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

/** Hosts shared by many unrelated businesses: dedupe on host + first path segment. */
const SHARED_HOSTS = [...SOCIAL_HOSTS, ...LINK_IN_BIO_HOSTS, ...WHATSAPP_HOSTS, "sites.google.com", "business.site"];

export type UrlKind = "website" | "social" | "link_in_bio" | "whatsapp";

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
    const wa = hostMatches(host, WHATSAPP_HOSTS);
    if (wa) return { kind: "whatsapp", host: wa };
    const social = hostMatches(host, SOCIAL_HOSTS);
    if (social) return { kind: "social", host: social };
    const lib = hostMatches(host, LINK_IN_BIO_HOSTS);
    if (lib) return { kind: "link_in_bio", host: lib };
    return { kind: "website", host: null };
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
