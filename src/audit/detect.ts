import type { PaymentProvider } from "../config.js";
import { classifyUrl, hostMatches, WHATSAPP_HOSTS } from "../url.js";

/**
 * Pure detection over a captured page snapshot. Every positive result carries
 * the signal that matched, so evidence can quote exactly what was observed.
 */

export interface PageSnapshot {
    finalUrl: string;
    html: string;
    /** Main document response headers, lowercased keys. */
    headers: Record<string, string>;
    /** Every request URL the page made while loading. */
    requestUrls: string[];
    links: { href: string; text: string }[];
    /** Text of buttons / submit inputs / role=button elements. */
    buttons: string[];
    formActions: string[];
    generator: string | null;
    /** Visible text plus image alt text. */
    text: string;
}

export interface Detection<T = string> {
    value: T;
    signal: string;
}

const hostOf = (u: string) => {
    try {
        return new URL(u).hostname.toLowerCase();
    } catch {
        return "";
    }
};

const requestedHost = (s: PageSnapshot, suffix: string) => s.requestUrls.map(hostOf).find((h) => h === suffix || h.endsWith(`.${suffix}`));

type PlatformRule = { platform: string; test: (s: PageSnapshot) => string | null };

const htmlHas = (s: PageSnapshot, needle: string) => (s.html.includes(needle) ? `"${needle}" in page source` : null);

/** Ordered: the first match wins (WooCommerce before plain WordPress). */
export const PLATFORM_RULES: PlatformRule[] = [
    {
        platform: "Shopify",
        test: (s) =>
            (s.headers["x-shopid"] ? "x-shopid response header" : null) ??
            (/shopify/i.test(s.headers["powered-by"] ?? "") ? "powered-by: Shopify header" : null) ??
            (requestedHost(s, "cdn.shopify.com") ? "requests to cdn.shopify.com" : null) ??
            htmlHas(s, "cdn.shopify.com") ??
            htmlHas(s, "Shopify.theme"),
    },
    {
        platform: "WooCommerce",
        test: (s) => htmlHas(s, "wp-content/plugins/woocommerce") ?? htmlHas(s, "wc_add_to_cart_params") ?? htmlHas(s, "woocommerce-page"),
    },
    {
        platform: "Wix",
        test: (s) =>
            (s.headers["x-wix-request-id"] ? "x-wix-request-id response header" : null) ??
            (/wix\.com/i.test(s.generator ?? "") ? `generator meta "${s.generator}"` : null) ??
            (requestedHost(s, "parastorage.com") ? "requests to parastorage.com" : null) ??
            htmlHas(s, "static.wixstatic.com"),
    },
    {
        platform: "Squarespace",
        test: (s) =>
            (/squarespace/i.test(s.generator ?? "") ? `generator meta "${s.generator}"` : null) ??
            htmlHas(s, "static1.squarespace.com") ??
            htmlHas(s, "SQUARESPACE_CONTEXT"),
    },
    { platform: "BigCommerce", test: (s) => htmlHas(s, "cdn11.bigcommerce.com") },
    { platform: "Ecwid", test: (s) => (requestedHost(s, "ecwid.com") ? "requests to ecwid.com" : null) },
    { platform: "Bumpa", test: (s) => (hostMatches(hostOf(s.finalUrl), ["bumpa.shop"]) ? "hosted on bumpa.shop" : null) },
    { platform: "Selar", test: (s) => (hostMatches(hostOf(s.finalUrl), ["selar.co", "selar.com"]) ? "hosted on selar" : null) },
    {
        platform: "WordPress",
        test: (s) => (/wordpress/i.test(s.generator ?? "") ? `generator meta "${s.generator}"` : null) ?? htmlHas(s, "/wp-content/"),
    },
];

/** "custom" means the page loaded but no known platform signature matched. */
export function detectPlatform(s: PageSnapshot): Detection {
    for (const rule of PLATFORM_RULES) {
        const signal = rule.test(s);
        if (signal) return { value: rule.platform, signal };
    }
    return { value: "custom", signal: "no known platform signature matched" };
}

const CART_PATH = /\/(cart|basket|bag|shopping-cart)(\/|$|\?|#|\.)/i;
const CHECKOUT_PATH = /\/checkout(\/|$|\?|#|\.)/i;
const ADD_TO_CART_TEXT = /\badd\s+to\s+(cart|bag|basket)\b/i;
const CHECKOUT_TEXT = /\bcheck\s?out\b/i;

const isWhatsapp = (href: string) => /^whatsapp:/i.test(href) || !!hostMatches(hostOf(href), WHATSAPP_HOSTS);

export function detectCommerce(s: PageSnapshot): { hasCart: boolean; hasCheckout: boolean; signals: string[] } {
    const signals: string[] = [];
    let hasCart = false;
    let hasCheckout = false;

    for (const l of s.links) {
        if (isWhatsapp(l.href)) continue;
        let path = "";
        try {
            path = new URL(l.href, s.finalUrl).pathname;
        } catch {
            continue;
        }
        if (!hasCart && CART_PATH.test(path)) {
            hasCart = true;
            signals.push(`cart link ${path}`);
        }
        if (!hasCheckout && CHECKOUT_PATH.test(path)) {
            hasCheckout = true;
            signals.push(`checkout link ${path}`);
        }
        if (!hasCart && ADD_TO_CART_TEXT.test(l.text)) {
            hasCart = true;
            signals.push(`link "${l.text.trim().slice(0, 40)}"`);
        }
        if (!hasCheckout && CHECKOUT_TEXT.test(l.text)) {
            hasCheckout = true;
            signals.push(`link "${l.text.trim().slice(0, 40)}"`);
        }
    }
    for (const b of s.buttons) {
        if (!hasCart && ADD_TO_CART_TEXT.test(b)) {
            hasCart = true;
            signals.push(`button "${b.trim().slice(0, 40)}"`);
        }
        if (!hasCheckout && CHECKOUT_TEXT.test(b)) {
            hasCheckout = true;
            signals.push(`button "${b.trim().slice(0, 40)}"`);
        }
    }
    for (const a of s.formActions) {
        if (!hasCart && /\/cart(\/add)?\b/i.test(a)) {
            hasCart = true;
            signals.push(`form action ${a.slice(0, 60)}`);
        }
        if (!hasCheckout && CHECKOUT_PATH.test(a)) {
            hasCheckout = true;
            signals.push(`form action ${a.slice(0, 60)}`);
        }
    }
    return { hasCart, hasCheckout, signals };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

export function detectPaymentProviders(s: PageSnapshot, providers: PaymentProvider[]): Detection[] {
    const found: Detection[] = [];
    for (const p of providers) {
        let signal: string | null = null;
        for (const d of p.domains) {
            const host = requestedHost(s, d);
            if (host) {
                signal = `request to ${host}`;
                break;
            }
        }
        if (!signal) {
            // Whole-domain match: "paystack.co" must not match inside "paystack.com".
            const d = p.domains.find((d) => new RegExp(`(^|[^a-z0-9-])${escapeRe(d)}(?![a-z0-9-])`, "i").test(s.html));
            if (d) signal = `${d} referenced in page source`;
        }
        if (!signal && p.matchText && new RegExp(`\\b${escapeRe(p.name)}\\b`).test(s.text)) {
            signal = `"${p.name}" in page text`;
        }
        if (signal) found.push({ value: p.name, signal });
    }
    return found;
}

export function countWhatsappLinks(s: PageSnapshot): number {
    return s.links.filter((l) => isWhatsapp(l.href)).length;
}

/** The page itself is a social profile or link-in-bio page (e.g. after a redirect). */
export function linkInBioHost(url: string): string | null {
    try {
        const c = classifyUrl(new URL(url));
        return c.kind === "social" || c.kind === "link_in_bio" ? c.host : null;
    } catch {
        return null;
    }
}

/** Distinctive symbols only; "$" and "R" are too ambiguous to count. */
const CURRENCY_SYMBOLS: Record<string, string[]> = {
    NGN: ["₦"],
    GHS: ["GH₵", "GH¢"],
    KES: ["KSh"],
    GBP: ["£"],
    EUR: ["€"],
    INR: ["₹"],
    ZAR: [],
    USD: ["US$"],
};

export function localCurrencySeen(s: PageSnapshot, currency: string): Detection<boolean> {
    const code = currency.toUpperCase();
    if (new RegExp(`\\b${escapeRe(code)}\\b`).test(s.text)) return { value: true, signal: `"${code}" in page text` };
    const sym = (CURRENCY_SYMBOLS[code] ?? []).find((x) => s.text.includes(x));
    if (sym) return { value: true, signal: `"${sym}" in page text` };
    return { value: false, signal: `no "${code}" code or symbol in page text` };
}

/**
 * Store behind a password page: Shopify's /password "opening soon" page, or
 * any page whose main content is a password form with password wording.
 */
export function detectPasswordProtected(s: PageSnapshot): Detection<boolean> {
    let path = "";
    try {
        path = new URL(s.finalUrl).pathname;
    } catch {
        /* keep empty */
    }
    if (/^\/password\/?$/i.test(path)) return { value: true, signal: "redirected to /password" };
    if (s.html.includes("template-password")) return { value: true, signal: '"template-password" in page source (Shopify password page)' };
    if (s.formActions.some((a) => /\/password\/?(\?|$)/i.test(a))) return { value: true, signal: "form posts to /password" };
    const hasPasswordInput = /<input[^>]+type\s*=\s*["']?password/i.test(s.html);
    const wording = /(enter (the )?(store |shop |site )?password|password[- ]protected|this (store|shop|site) is (private|password protected)|opening soon)/i.exec(s.text);
    if (hasPasswordInput && wording) return { value: true, signal: `password field and "${wording[0]}" on page` };
    return { value: false, signal: "no password page" };
}

const PARKING_HOSTS = ["sedoparking.com", "sedo.com", "dan.com", "afternic.com", "hugedomains.com", "parkingcrew.net", "bodis.com", "above.com", "undeveloped.com", "parklogic.com"];
const PARKED_TEXT = /(this domain (name )?(is|may be) for sale|buy this domain|domain is parked|parked free|courtesy of godaddy|this domain has expired|renew (this|your) domain)/i;

/** A parked or for-sale domain: the listed website doesn't exist as a business site. */
export function detectParked(s: PageSnapshot): string | null {
    const host = hostOf(s.finalUrl);
    const parkHost = hostMatches(host, PARKING_HOSTS);
    if (parkHost) return `redirected to ${parkHost}`;
    const req = PARKING_HOSTS.map((d) => requestedHost(s, d)).find(Boolean);
    if (req) return `page loads from ${req}`;
    const m = PARKED_TEXT.exec(s.text.slice(0, 5000));
    return m ? `"${m[0]}" on page` : null;
}

const SHOP_PATH = /\/(shop|store|products?|collections?|catalog(ue)?|categor(y|ies)|product-category|buy|order-online|menu)(\/|$|\?|#)/i;

/** Same-site links that look like shop/product listings, best first. */
export function shopPageLinks(s: PageSnapshot, max = 3): string[] {
    let origin = "";
    try {
        origin = new URL(s.finalUrl).origin;
    } catch {
        return [];
    }
    const out = new Set<string>();
    for (const l of s.links) {
        let u: URL;
        try {
            u = new URL(l.href, s.finalUrl);
        } catch {
            continue;
        }
        if (u.origin !== origin || !SHOP_PATH.test(u.pathname)) continue;
        u.hash = "";
        if (u.href !== s.finalUrl) out.add(u.href);
        if (out.size >= max) break;
    }
    return [...out];
}
