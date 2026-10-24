import { hostMatches, WHATSAPP_HOSTS } from "../url.js";

/**
 * Pull email addresses out of fetched HTML. Only addresses that are actually
 * published are returned: mailto: links and addresses in visible text
 * (including Cloudflare-obfuscated ones, which the browser shows as text).
 * Nothing is constructed from names or patterns.
 */

export interface FoundEmail {
    email: string;
    source: "mailto" | "page_text";
    pageUrl: string;
    note: string | null;
}

const EMAIL_RE = /[a-z0-9][a-z0-9._%+-]{0,63}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}/gi;

/** Placeholder, vendor and tracking addresses that are never the business's own. */
const JUNK_DOMAINS = [
    "example.com",
    "example.org",
    "example.net",
    "domain.com",
    "yourdomain.com",
    "email.com",
    "sentry.io",
    "sentry-next.wixpress.com",
    "wixpress.com",
    "sentry.wixpress.com",
];
const JUNK_LOCAL = /^(your|you|name|email|user|username|someone|test|noreply|no-reply|donotreply|do-not-reply|postmaster|mailer-daemon)$/i;
const FILE_TLD = /\.(png|jpe?g|gif|svg|webp|avif|ico|css|js|json|woff2?|ttf|mp4|webm)$/i;

export function normaliseEmail(raw: string): string | null {
    const email = raw.trim().replace(/^mailto:/i, "").replace(/[.,;:]+$/, "").toLowerCase();
    const m = email.match(EMAIL_RE);
    if (!m || m[0] !== email) return null;
    const [local, domain] = email.split("@") as [string, string];
    if (FILE_TLD.test(email)) return null; // logo@2x.png
    if (JUNK_LOCAL.test(local.replace(/\+.*$/, ""))) return null;
    if (hostMatches(domain, JUNK_DOMAINS)) return null;
    if (/^[0-9a-f]{24,}$/.test(local)) return null; // tracking ids
    return email;
}

/** Cloudflare "email protection": hex string, first byte is the XOR key. */
export function decodeCfEmail(hex: string): string | null {
    if (!/^[0-9a-f]+$/i.test(hex) || hex.length < 4 || hex.length % 2) return null;
    const key = parseInt(hex.slice(0, 2), 16);
    let out = "";
    for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ key);
    return out;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", commat: "@", period: ".", lowbar: "_", hyphen: "-" };

export function decodeEntities(s: string): string {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
        if (e[0] === "#") {
            const code = e[1]?.toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : m;
        }
        return ENTITIES[e.toLowerCase()] ?? m;
    });
}

/** Text a visitor would see: no scripts, styles, comments or tag attributes. */
export function visibleText(html: string): string {
    return decodeEntities(
        html
            .replace(/<!--[\s\S]*?-->/g, " ")
            .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, " ")
            .replace(/<[^>]+>/g, " "),
    ).replace(/\s+/g, " ");
}

const attr = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => decodeEntities(m[1] ?? ""));

export function extractEmails(html: string, pageUrl: string): FoundEmail[] {
    const found = new Map<string, FoundEmail>();
    const add = (raw: string, source: FoundEmail["source"], note: string | null = null) => {
        const email = normaliseEmail(raw);
        // mailto beats page_text when the same address appears both ways.
        if (email && (!found.has(email) || (source === "mailto" && found.get(email)!.source !== "mailto"))) {
            found.set(email, { email, source, pageUrl, note });
        }
    };

    for (const href of attr(html, /href\s*=\s*["']\s*(mailto:[^"']*)["']/gi)) {
        let value = href.slice("mailto:".length).split("?")[0] ?? "";
        try {
            value = decodeURIComponent(value);
        } catch {
            /* keep as-is */
        }
        for (const part of value.split(/[,;]/)) add(part, "mailto");
    }
    // Cloudflare rewrites mailto links to /cdn-cgi/l/email-protection#<hex>.
    for (const hex of attr(html, /href\s*=\s*["'][^"']*\/cdn-cgi\/l\/email-protection#([0-9a-f]+)["']/gi)) {
        const email = decodeCfEmail(hex);
        if (email) add(email, "mailto", "Cloudflare-protected link");
    }
    for (const hex of attr(html, /data-cfemail\s*=\s*["']([0-9a-f]+)["']/gi)) {
        const email = decodeCfEmail(hex);
        if (email) add(email, "page_text", "Cloudflare-protected address");
    }
    for (const m of visibleText(html).matchAll(EMAIL_RE)) add(m[0], "page_text");

    return [...found.values()];
}

/** wa.me / api.whatsapp.com links the site itself publishes. */
export function extractWhatsappLinks(html: string, pageUrl: string): string[] {
    const out = new Set<string>();
    for (const href of attr(html, /href\s*=\s*["']([^"']+)["']/gi)) {
        try {
            const u = new URL(href, pageUrl);
            if ((u.protocol === "https:" || u.protocol === "http:") && hostMatches(u.hostname, WHATSAPP_HOSTS)) out.add(u.href);
        } catch {
            /* not a URL */
        }
    }
    return [...out];
}
