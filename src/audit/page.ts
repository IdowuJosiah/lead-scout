import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { devices, errors, type Browser } from "playwright";
import type { PageSnapshot } from "./detect.js";
import { chromiumCertError } from "./ssl.js";

/** Mobile device profile used for every audit. */
export const MOBILE_DEVICE = "Pixel 7";

// In-page scripts are plain strings: the TS loader would otherwise inject
// helpers (e.g. __name) into serialised functions that don't exist in the page.
const LOAD_TIME_SCRIPT = `(() => {
    const nav = performance.getEntriesByType("navigation")[0];
    return nav && nav.loadEventEnd > 0 ? Math.round(nav.loadEventEnd) : null;
})()`;

// Written defensively: sites can override built-ins or give elements odd
// properties (an <li role=button> has a numeric .value; an SVG <a> has an
// object .href), so every value is forced to a plain string.
const EXTRACT_SCRIPT = `(() => {
    const str = (v) => (typeof v === "string" ? v : "");
    const text = (el) => { try { return str(el && (el.innerText || el.textContent)); } catch (e) { return ""; } };
    const all = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));
    const attr = (el, n) => str(el.getAttribute && el.getAttribute(n));
    const links = all("a[href]").slice(0, 2000).map((a) => ({
        href: str(a.href) || attr(a, "href"),
        text: (text(a) || attr(a, "aria-label")).trim().slice(0, 200),
    }));
    const buttons = all("button, input[type=submit], input[type=button], [role=button]")
        .slice(0, 1000)
        .map((b) => (text(b) || str(b.value) || attr(b, "aria-label")).trim().slice(0, 200))
        .filter(Boolean);
    const formActions = all("form[action]").map((f) => str(f.action) || attr(f, "action")).filter(Boolean);
    const alts = all("img[alt]").map((i) => attr(i, "alt")).join(" ");
    const gen = document.querySelector('meta[name="generator" i]');
    return { links, buttons, formActions, generator: gen ? attr(gen, "content") || null : null, text: (text(document.body) + " " + alts).slice(0, 300000) };
})()`;

/** Whatever the page returned, give the detectors well-typed values. */
export function normalizeExtract(raw: unknown): Omit<PageSnapshot, "finalUrl" | "html" | "headers" | "requestUrls"> {
    const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const s = (v: unknown) => (typeof v === "string" ? v : "");
    const arr = (v: unknown) => (Array.isArray(v) ? v : []);
    return {
        links: arr(r.links).map((l) => ({ href: s((l as { href?: unknown })?.href), text: s((l as { text?: unknown })?.text) })).filter((l) => l.href),
        buttons: arr(r.buttons).map(s).filter(Boolean),
        formActions: arr(r.formActions).map(s).filter(Boolean),
        generator: s(r.generator) || null,
        text: s(r.text),
    };
}

export type PageLoad =
    | {
          kind: "loaded";
          finalUrl: string;
          httpStatus: number | null;
          /** Navigation Timing loadEventEnd, in ms from navigation start. */
          loadTimeMs: number | null;
          timedOut: boolean;
          snapshot: PageSnapshot;
          screenshotPath: string | null;
          screenshotError: string | null;
      }
    | { kind: "cert_error"; code: string }
    | { kind: "unreachable"; error: string };

export interface LoadOptions {
    timeoutMs: number;
    userAgentSuffix: string;
    /** null: no screenshot (used for extra shop pages). */
    screenshotPath: string | null;
    ignoreHttpsErrors: boolean;
}

export async function loadPage(browser: Browser, url: string, opts: LoadOptions): Promise<PageLoad> {
    const device = devices[MOBILE_DEVICE]!;
    const context = await browser.newContext({
        ...device,
        userAgent: `${device.userAgent} ${opts.userAgentSuffix}`,
        ignoreHTTPSErrors: opts.ignoreHttpsErrors,
        serviceWorkers: "block",
    });
    try {
        const page = await context.newPage();
        const requestUrls: string[] = [];
        page.on("request", (r) => requestUrls.push(r.url()));

        let timedOut = false;
        let response = null;
        try {
            response = await page.goto(url, { waitUntil: "load", timeout: opts.timeoutMs });
        } catch (err) {
            const msg = (err as Error).message;
            const cert = chromiumCertError(msg);
            if (cert && !opts.ignoreHttpsErrors) return { kind: "cert_error", code: cert };
            if (!(err instanceof errors.TimeoutError)) return { kind: "unreachable", error: msg.split("\n")[0]! };
            timedOut = true;
        }

        const finalUrl = page.url();
        if (timedOut && (finalUrl === "about:blank" || !(await page.content().catch(() => "")).includes("<body"))) {
            return { kind: "unreachable", error: `no response within ${opts.timeoutMs}ms` };
        }

        const loadTimeMs = timedOut
            ? null
            : ((await page.evaluate(LOAD_TIME_SCRIPT).catch(() => null)) as number | null);

        // Give client-rendered stores a moment to draw cart buttons.
        await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});

        const extracted = normalizeExtract(await page.evaluate(EXTRACT_SCRIPT).catch(() => null));
        const html = (await page.content()).slice(0, 3_000_000);
        const headers = response ? await response.allHeaders().catch(() => ({})) : {};

        let screenshotPath: string | null = opts.screenshotPath;
        let screenshotError: string | null = null;
        if (opts.screenshotPath) {
            try {
                mkdirSync(dirname(opts.screenshotPath), { recursive: true });
                await page.screenshot({ path: opts.screenshotPath, timeout: 15_000 });
            } catch (err) {
                screenshotPath = null;
                screenshotError = (err as Error).message.split("\n")[0]!;
            }
        }

        return {
            kind: "loaded",
            finalUrl,
            httpStatus: response?.status() ?? null,
            loadTimeMs,
            timedOut,
            snapshot: { finalUrl, html, headers, requestUrls, ...extracted },
            screenshotPath,
            screenshotError,
        };
    } finally {
        await context.close().catch(() => {});
    }
}
