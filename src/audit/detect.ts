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

// Cart / checkout under the names stores actually use, in the languages we meet most.
const CART_WORDS = "cart|basket|bag|trolley|shopping-cart|shopping-bag|my-cart|panier|carrito|carrinho|warenkorb|carrello|winkelwagen";
const CART_PATH = new RegExp(`/(${CART_WORDS})(/|$|\\?|#|\\.)|/cart\\.php|route=checkout/cart`, "i");
const CHECKOUT_PATH = /\/(checkouts?|kasse|caisse|pago|finalizar-compra)(\/|$|\?|#|\.)|route=checkout\/checkout/i;
/** Link or button text that adds something to a cart, or buys it outright. */
const ADD_TO_CART_TEXT =
    /\b(add\s+to\s+(cart|bag|basket|trolley|order)|buy\s+(it\s+)?now|ajouter\s+au\s+panier|a[ñn]adir\s+al\s+carrito|agregar\s+al\s+carrito|adicionar\s+ao\s+carrinho|in\s+den\s+warenkorb|aggiungi\s+al\s+carrello|in\s+winkelwagen)\b|(أضف|إضافة)\s+(إلى|الى|ل)\s*السلة/i;
/** A link that is just the cart itself: "Cart", "My bag (2)", "Basket 0". */
const CART_LINK_TEXT = new RegExp(`\\b\\d*\\s*items?\\s+in\\s+(your\\s+|the\\s+)?(cart|bag|basket)\\b|^\\s*(my\\s+|your\\s+|view\\s+|open\\s+|go\\s+to\\s+)?(cart|basket|bag|trolley|shopping\\s+(cart|bag)|panier|carrito|carrinho|warenkorb|carrello|السلة)\\s*(\\(?\\s*\\d+\\s*\\)?|items?)?\\s*$`, "i");
const CHECKOUT_TEXT = /\b(check\s?out|place\s+order|proceed\s+to\s+payment|pay\s+now|commander|finalizar\s+compra|zur\s+kasse)\b|إتمام\s+الشراء|الدفع/i;
/** Cart widgets that are only an icon: drawer / mini-cart / counter markup. */
const CART_MARKUP =
    /\b(?:class|id|data-[\w-]+)\s*=\s*["'][^"']*?((?:mini-?|header-?)?(?:cart|bag|basket)[-_]?(?:drawer|count|icon|link|toggle|button|bubble|items|popup|sidebar|trigger|wrapper|counter|qty|quantity|badge)|mini-?(?:cart|bag|basket)|js-cart|w-commerce-commercecart|wc-block-mini-cart|sqs-cart)/i;

/** Store software running on the page: if it's there, the site has a cart even if we can't see the button. */
const STORE_ENGINES: [string, (s: PageSnapshot) => boolean][] = [
    ["Shopify cart", (s) => /\/cart(\.js|\/add)\b|Shopify\.routes|"cart_add_url"|sdks\.shopifycdn\.com\/buy-button/.test(s.html) || s.requestUrls.some((u) => /\/cart\.js\b/.test(u))],
    ["WooCommerce cart", (s) => /wc-cart-fragments|wc-ajax=|add_to_cart_button|wc_add_to_cart_params|woocommerce-cart/.test(s.html) || s.requestUrls.some((u) => /wc-ajax=|wc-cart-fragments/.test(u))],
    ["Wix Stores", (s) => /wixstores|wix-ecommerce|ecom-platform|"cartIconLink"/i.test(s.html) || s.requestUrls.some((u) => /wixstores|\/ecom\//.test(u))],
    ["Squarespace Commerce", (s) => /sqs-add-to-cart-button|commerce-cart|Static\.SQUARESPACE_CONTEXT[^;]*"commerce/.test(s.html)],
    ["Ecwid store", (s) => /app\.ecwid\.com\/script\.js|ecwid-productBrowser/i.test(s.html) || s.requestUrls.some((u) => /app\.ecwid\.com/.test(u))],
    ["Snipcart", (s) => /snipcart/i.test(s.html)],
    ["BigCommerce cart", (s) => /cart\.php|data-cart-preview|BCData/.test(s.html)],
    ["Magento cart", (s) => /Magento_Checkout|mage\/cookies|minicart-wrapper/.test(s.html)],
    ["PrestaShop cart", (s) => /prestashop|blockcart/i.test(s.html)],
    ["OpenCart cart", (s) => /route=checkout\/cart|catalog\/view\/theme/.test(s.html)],
    ["Webflow Ecommerce", (s) => /w-commerce-commerce(cart|addtocart)/.test(s.html)],
    ["Square Online", (s) => s.requestUrls.some((u) => /square\.site|squareup\.com\/.*online/.test(u))],
];

/** Where a "buy" link can send people to pay or order outside the site. */
const EXTERNAL_CHECKOUT_HOSTS = [
    "buy.stripe.com", "checkout.stripe.com", "paystack.com", "paystack.shop", "flutterwave.com", "selar.co", "selar.com", "gumroad.com",
    "paypal.com", "paypal.me", "square.link", "checkout.square.site", "sumup.link", "lemonsqueezy.com", "payhip.com", "bumpa.shop",
    "etsy.com", "jumia.com.ng", "jumia.com", "konga.com", "amazon.com", "amazon.co.uk", "amazon.ae", "noon.com", "takealot.com", "ko-fi.com",
];
const EXTERNAL_CHECKOUT_PATH: Record<string, RegExp> = { "paystack.com": /^\/(pay|buy)\b/, "flutterwave.com": /^\/(pay|store)\b/, "paypal.com": /webscr|\/paypalme|\/donate|\/ncp\/payment/ };

const isWhatsapp = (href: string) => /^whatsapp:/i.test(href) || !!hostMatches(hostOf(href), WHATSAPP_HOSTS);

export interface Commerce {
    hasCart: boolean;
    hasCheckout: boolean;
    signals: string[];
    /** Structured product/price data on the page: the site sells, even if we found no cart. */
    sellingSigns: string[];
}

export function detectCommerce(s: PageSnapshot): Commerce {
    const signals: string[] = [];
    let hasCart = false;
    let hasCheckout = false;
    const cart = (sig: string) => {
        if (!hasCart) signals.push(sig);
        hasCart = true;
    };
    const checkout = (sig: string) => {
        if (!hasCheckout) signals.push(sig);
        hasCheckout = true;
    };

    for (const l of s.links) {
        if (isWhatsapp(l.href)) continue;
        let u: URL;
        try {
            u = new URL(l.href, s.finalUrl);
        } catch {
            continue;
        }
        const pathAndQuery = u.pathname + u.search;
        if (CART_PATH.test(pathAndQuery)) cart(`cart link ${u.pathname}`);
        if (CHECKOUT_PATH.test(pathAndQuery)) checkout(`checkout link ${u.pathname}`);
        if (ADD_TO_CART_TEXT.test(l.text) || CART_LINK_TEXT.test(l.text)) cart(`link "${l.text.trim().slice(0, 40)}"`);
        if (CHECKOUT_TEXT.test(l.text)) checkout(`link "${l.text.trim().slice(0, 40)}"`);
        const host = hostMatches(u.hostname.toLowerCase(), EXTERNAL_CHECKOUT_HOSTS);
        if (host && (!EXTERNAL_CHECKOUT_PATH[host] || EXTERNAL_CHECKOUT_PATH[host]!.test(u.pathname + u.search))) checkout(`buy link to ${host}`);
    }
    for (const b of s.buttons) {
        if (ADD_TO_CART_TEXT.test(b) || CART_LINK_TEXT.test(b)) cart(`button "${b.trim().slice(0, 40)}"`);
        if (CHECKOUT_TEXT.test(b)) checkout(`button "${b.trim().slice(0, 40)}"`);
    }
    for (const a of s.formActions) {
        if (CART_PATH.test(a) || /\/cart\/add\b|add-to-cart=/i.test(a)) cart(`form action ${a.slice(0, 60)}`);
        if (CHECKOUT_PATH.test(a)) checkout(`form action ${a.slice(0, 60)}`);
    }
    if (!hasCart) {
        const m = CART_MARKUP.exec(s.html);
        if (m) cart(`cart widget "${m[1]}" in page`);
    }
    if (!hasCart) {
        const engine = STORE_ENGINES.find(([, test]) => test(s));
        if (engine) cart(`${engine[0]} running on the page`);
    }

    const sellingSigns: string[] = [];
    if (/"@type"\s*:\s*"(Product|Offer|AggregateOffer)"/.test(s.html)) sellingSigns.push("product data (schema.org Product/Offer)");
    if (/itemprop=["'](price|offers)["']/.test(s.html)) sellingSigns.push("price markup (itemprop)");
    if (/<meta[^>]+property=["']og:type["'][^>]+content=["']product/i.test(s.html)) sellingSigns.push("og:type product");
    if (/<meta[^>]+property=["'](product:price:amount|og:price:amount)["']/i.test(s.html)) sellingSigns.push("product price meta tag");
    return { hasCart, hasCheckout, signals, sellingSigns };
}

const PRODUCT_PATH = /\/(products?|items?|p|shop|store|collections\/[^/]+\/products)\/[^/?#]{3,}\/?$|\/product-page\/|[?&](product_id|item_id)=/i;

/** One or two links that look like a single product page (where "add to cart" usually lives). */
export function productPageLinks(s: PageSnapshot, max = 1): string[] {
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
        if (u.origin !== origin || !PRODUCT_PATH.test(u.pathname + u.search)) continue;
        if (/\/(products?|shop|store|collections?|categor(y|ies))\/?$/i.test(u.pathname)) continue; // a listing, not a product
        u.hash = "";
        if (u.href !== s.finalUrl) out.add(u.href);
        if (out.size >= max) break;
    }
    return [...out];
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
