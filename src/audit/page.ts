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

const EXTRACT_SCRIPT = `(() => {
    const text = (el) => (el && (el.innerText || el.textContent)) || "";
    const links = [...document.querySelectorAll("a[href]")].slice(0, 2000).map((a) => ({
        href: a.href || a.getAttribute("href") || "",
        text: (text(a) || a.getAttribute("aria-label") || "").trim().slice(0, 200),
    }));
    const buttons = [...document.querySelectorAll("button, input[type=submit], input[type=button], [role=button]")]
        .slice(0, 1000)
        .map((b) => (text(b) || b.value || b.getAttribute("aria-label") || "").trim().slice(0, 200))
        .filter(Boolean);
    const formActions = [...document.querySelectorAll("form[action]")].map((f) => f.action);
    const alts = [...document.querySelectorAll("img[alt]")].map((i) => i.getAttribute("alt") || "").join(" ");
    const generator = document.querySelector('meta[name="generator" i]')?.getAttribute("content") ?? null;
    return { links, buttons, formActions, generator, text: (text(document.body) + " " + alts).slice(0, 300000) };
})()`;

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

        const extracted = (await page.evaluate(EXTRACT_SCRIPT)) as Omit<PageSnapshot, "finalUrl" | "html" | "headers" | "requestUrls">;
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
