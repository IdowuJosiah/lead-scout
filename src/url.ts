/**
 * URL helpers: normalisation, dedupe keys, and classification of the
 * "website" a business lists (real site vs social profile vs WhatsApp link).
 */

/** Social networks: a profile here is not a website we can (or may) audit. */
export const SOCIAL_HOSTS = [
    "instagram.com",
    "facebook.com",
    "fb.com",
    "tiktok.com",
    "twitter.com",
    "x.com",
    "youtube.com",
    "pinterest.com",
    "snapchat.com",
    "threads.net",
    "linkedin.com",
];

/** Link-in-bio aggregators: a single page of outbound links. */
export const LINK_IN_BIO_HOSTS = [
    "linktr.ee",
    "beacons.ai",
    "bio.link",
    "linkin.bio",
    "lnk.bio",
    "campsite.bio",
    "solo.to",
    "taplink.cc",
    "msha.ke",
    "allmylinks.com",
    "carrd.co",
    "linkbio.co",
    "hoo.be",
    "komi.io",
];

export const WHATSAPP_HOSTS = ["wa.me", "api.whatsapp.com", "web.whatsapp.com", "chat.whatsapp.com", "wa.link", "whatsapp.com"];

/** Chat links: the listed "website" opens a conversation, not a site. */
export const MESSAGING_HOSTS = [...WHATSAPP_HOSTS, "t.me", "telegram.me", "m.me", "signal.me"];

/**
 * Storefronts and sites that live on a platform's domain rather than the
 * brand's own: marketplaces, social-commerce shops, and free builder subdomains.
 */
export const HOSTED_STOREFRONT_HOSTS = [
    // social commerce / storefront builders popular in Africa
    "bumpa.shop",
    "selar.co",
    "selar.com",
    "paystack.shop",
    "paystack.com",
    "flutterwave.store",
    "catlog.shop",
    "mainstack.me",
    "mainstack.com",
    // marketplaces
    "jumia.com.ng",
    "jumia.com",
    "konga.com",
    "jiji.ng",
    "etsy.com",
    "amazon.com",
    "ebay.com",
    "takealot.com",
    // platform subdomains
    "myshopify.com",
    "bigcartel.com",
    "square.site",
    "company.site",
    "wixsite.com",
    "wordpress.com",
    "blogspot.com",
    "weebly.com",
    "godaddysites.com",
    "business.site",
    "sites.google.com",
    "squarespace.com",
    "gumroad.com",
];

/** Hosts shared by many unrelated businesses: dedupe on host + first path segment. */
const SHARED_HOSTS = [...SOCIAL_HOSTS, ...LINK_IN_BIO_HOSTS, ...MESSAGING_HOSTS, "sites.google.com", "business.site", "paystack.com", "selar.co", "jiji.ng", "jumia.com.ng", "konga.com", "etsy.com"];

/** What the listed website URL is, from the URL alone (dead_listing needs an audit). */
export type UrlKind = "owned_site" | "social" | "messaging" | "link_in_bio" | "hosted_storefront";

export function hostMatches(host: string, list: readonly string[]): string | null {
    const h = host.toLowerCase().replace(/^www\./, "");
    for (const d of list) {
        if (h === d || h.endsWith(`.${d}`)) return d;
    }
    return null;
}

/** Parse a user/API supplied website string into a URL, adding https:// if no scheme. */
export function parseWebsite(raw: string | null | undefined): URL | null {
    if (!raw) return null;
    const trimmed = raw.trim();
    if (!trimmed) return null;
    // Another scheme (mailto:, tel:) is not a website; "host:8080" is.
    if (!/^https?:\/\//i.test(trimmed) && /^[a-z][a-z0-9+.-]*:(?!\d)/i.test(trimmed)) return null;
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    try {
        const u = new URL(withScheme);
        if (u.protocol !== "http:" && u.protocol !== "https:") return null;
        if (!u.hostname.includes(".")) return null;
        return u;
    } catch {
        return null;
    }
}

/** Domain used for dedupe: lowercased host (with any non-default port), without www. */
export function websiteDomain(u: URL): string {
    return u.host.toLowerCase().replace(/^www\./, "");
}

export function classifyUrl(u: URL): { kind: UrlKind; host: string | null } {
    const host = u.hostname;
    const chat = hostMatches(host, MESSAGING_HOSTS);
    if (chat) return { kind: "messaging", host: chat };
    const social = hostMatches(host, SOCIAL_HOSTS);
    if (social) return { kind: "social", host: social };
    const lib = hostMatches(host, LINK_IN_BIO_HOSTS);
    if (lib) return { kind: "link_in_bio", host: lib };
    const hosted = hostMatches(host, HOSTED_STOREFRONT_HOSTS);
    if (hosted) return { kind: "hosted_storefront", host: hosted };
    return { kind: "owned_site", host: null };
}

const normText = (s: string) =>
    s
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, " ")
        .trim();

/**
 * Dedupe key for a lead. Website domain when there is one (host + first path
 * segment on shared hosts like instagram.com), otherwise name + address.
 */
export function dedupeKey(name: string, address: string | null, website: URL | null): string {
    if (website) {
        const domain = websiteDomain(website);
        if (hostMatches(domain, SHARED_HOSTS)) {
            const first = website.pathname.split("/").filter(Boolean)[0]?.toLowerCase() ?? "";
            // wa.me/send?phone=..., facebook.com/profile.php?id=... carry identity in the query.
            const id = website.searchParams.get("phone")?.replace(/\D/g, "") || website.searchParams.get("id");
            return `url:${domain}/${first}${id ? `?${id}` : ""}`;
        }
        return `domain:${domain}`;
    }
    return `name:${normText(name)}|${normText(address ?? "")}`;
}
