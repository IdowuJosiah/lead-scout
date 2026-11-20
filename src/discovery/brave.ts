import { findPhoneNumbersInText, type CountryCode } from "libphonenumber-js/max";
import { createRequire } from "node:module";
import { classifyUrl, hostMatches, parseWebsite, SOCIAL_HOSTS } from "../url.js";
import type { DiscoveredLead, DiscoveryContext, DiscoverySource } from "./types.js";

/**
 * Finds businesses that live on social media, through the Brave Search API:
 *
 *  - Instagram, Facebook and TikTok profiles: `site:instagram.com fashion Lagos`.
 *    Name and handle come from the result title, a phone number from the bio
 *    snippet. Nothing is fetched from the social networks themselves.
 *  - Blog round-ups ("best fashion boutiques in Lagos"): the article is fetched
 *    (robots.txt respected) and every Instagram profile it links to becomes a lead.
 *
 * Needs BRAVE_API_KEY. Options (config source_options.brave_search):
 *   networks: ["instagram", "facebook", "tiktok"], blog_pages: 3, results: 20
 */

const robotsParser = createRequire(import.meta.url)("robots-parser") as (url: string, contents: string) => { isAllowed(url: string, ua?: string): boolean | undefined };
const API = "https://api.search.brave.com/res/v1/web/search";
const NETWORKS: Record<string, string> = { instagram: "instagram.com", facebook: "facebook.com", tiktok: "tiktok.com" };
/** First path segments that are pages of the network, not a business. */
const NOT_PROFILES = new Set([
    "p", "reel", "reels", "explore", "stories", "tv", "accounts", "about", "developer", "legal", "directory", "popular", "web",
    "groups", "events", "watch", "marketplace", "share", "story.php", "photo", "photo.php", "people", "hashtag", "login", "help",
    "privacy", "policies", "business", "ads", "pages", "search", "tag", "discover", "music", "video", "live", "foryou", "gaming",
]);
const UA = "Mozilla/5.0 (compatible; LeadScout/1.0; +https://github.com/IdowuJosiah/lead-scout)";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface BraveResult {
    title?: string;
    url?: string;
    description?: string;
    extra_snippets?: string[];
}

const stripTags = (s: string) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').trim();

/** "Ada's Closet (@adascloset) • Instagram photos and videos" -> { name, handle }. */
export function profileFromResult(r: BraveResult): { network: string; handle: string; url: string; name: string } | null {
    const url = parseWebsite(r.url ?? null);
    if (!url) return null;
    const network = Object.entries(NETWORKS).find(([, host]) => hostMatches(url.hostname, [host]))?.[0];
    if (!network) return null;
    const first = url.pathname.split("/").filter(Boolean)[0] ?? "";
    if (!first || NOT_PROFILES.has(first.toLowerCase())) return null;
    if (network === "tiktok" && !first.startsWith("@")) return null;
    const handle = first.replace(/^@/, "");
    if (!/^[\w.-]{2,60}$/.test(handle) || /^profile\.php$/i.test(handle)) return null;
    const title = stripTags(r.title ?? "");
    let name = title
        .replace(/\s*\(@[^)]*\).*$/, "") // "Name (@handle) • Instagram ..."
        .replace(/\s*[|•·-]\s*(Instagram|Facebook|TikTok).*$/i, "")
        .replace(/\s*\|.*$/, "")
        .trim();
    if (!name || /^(instagram|facebook|tiktok|log ?in)/i.test(name)) name = handle;
    const canonical = network === "tiktok" ? `https://www.tiktok.com/@${handle}` : `https://www.${NETWORKS[network]}/${handle}`;
    return { network, handle, url: canonical, name: name.slice(0, 120) };
}

/** A mobile/any valid number for the country in the snippet, formatted internationally. */
export function phoneFromText(text: string, country: string): string | null {
    try {
        const found = findPhoneNumbersInText(text, country as CountryCode).filter((f) => f.number.isValid());
        const best = found.find((f) => f.number.getType() === "MOBILE") ?? found[0];
        return best ? best.number.formatInternational() : null;
    } catch {
        return null;
    }
}

/** A website of their own mentioned in the bio ("www.brand.com"), which puts them out of scope. */
export function ownSiteInText(text: string): string | null {
    for (const m of text.matchAll(/\b((?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|ng|net|org|co|shop|store|online|io|co\.uk|ae|com\.ng)(?:\/\S*)?)/gi)) {
        const url = parseWebsite(m[1]!);
        if (url && classifyUrl(url).kind === "owned_site" && !/\.(jpe?g|png|gif)$/i.test(url.pathname)) return url.href;
    }
    return null;
}

/** Instagram profiles linked from an article's HTML. */
export function instagramLinksInHtml(html: string): string[] {
    const out = new Set<string>();
    for (const m of html.matchAll(/href=["'](https?:\/\/(?:www\.)?instagram\.com\/([\w.]{2,30})\/?(?:\?[^"']*)?)["']/gi)) {
        const handle = m[2]!.toLowerCase();
        if (!NOT_PROFILES.has(handle)) out.add(handle);
    }
    return [...out];
}

export class BraveSearchSource implements DiscoverySource {
    readonly name = "brave_search";
    static warned = false;
    private lastCall = 0;

    private async search(q: string, key: string, count: number): Promise<BraveResult[]> {
        // Free plan: one request per second.
        const wait = this.lastCall + 1100 - Date.now();
        if (wait > 0) await sleep(wait);
        this.lastCall = Date.now();
        const res = await fetch(`${API}?${new URLSearchParams({ q, count: String(count), safesearch: "moderate" })}`, {
            headers: { Accept: "application/json", "X-Subscription-Token": key },
            signal: AbortSignal.timeout(30_000),
        });
        if (res.status === 401 || res.status === 403) throw new Error(`Brave Search rejected the API key (HTTP ${res.status})`);
        if (res.status === 429) throw new Error("Brave Search rate limit or monthly quota reached (HTTP 429)");
        if (!res.ok) throw new Error(`Brave Search HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        const body = (await res.json()) as { web?: { results?: BraveResult[] } };
        return body.web?.results ?? [];
    }

    private async fetchArticle(url: URL): Promise<string | null> {
        try {
            const robotsUrl = `${url.origin}/robots.txt`;
            const r = await fetch(robotsUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000) }).catch(() => null);
            const robots = robotsParser(robotsUrl, r?.ok ? await r.text() : "");
            if (robots.isAllowed(url.href, "LeadScout") === false) return null;
            await sleep(1000);
            const page = await fetch(url.href, { headers: { "User-Agent": UA, Accept: "text/html" }, signal: AbortSignal.timeout(20_000) });
            if (!page.ok || !(page.headers.get("content-type") ?? "").includes("html")) return null;
            return (await page.text()).slice(0, 2_000_000);
        } catch {
            return null;
        }
    }

    async *discover(keyword: string, ctx: DiscoveryContext): AsyncIterable<DiscoveredLead> {
        const key = process.env.BRAVE_API_KEY;
        if (!key) {
            if (!BraveSearchSource.warned) ctx.log.warn("brave_search: BRAVE_API_KEY is not set; skipping social and blog search");
            BraveSearchSource.warned = true;
            return;
        }
        const { city, country, country_code } = ctx.config;
        const networks = (Array.isArray(ctx.options.networks) ? (ctx.options.networks as string[]) : Object.keys(NETWORKS)).filter((n) => NETWORKS[n]);
        const count = Math.min(20, Number(ctx.options.results ?? 20) || 20);
        const blogPages = Math.max(0, Number(ctx.options.blog_pages ?? 3) || 0);
        const local = (text: string) => new RegExp(`\\b(${[city, country].map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "i").test(text);
        const seen = new Set<string>();

        for (const network of networks) {
            for (const r of await this.search(`site:${NETWORKS[network]} ${keyword} ${city}`, key, count)) {
                const p = profileFromResult(r);
                if (!p || seen.has(p.url)) continue;
                const text = stripTags([r.title, r.description, ...(r.extra_snippets ?? [])].filter(Boolean).join(" \n "));
                const phone = phoneFromText(text, country_code);
                // Keep it local: the profile mentions the place, or lists a local number.
                if (!local(text) && !phone) continue;
                seen.add(p.url);
                const ownSite = ownSiteInText(text);
                yield {
                    name: p.name,
                    category: keyword,
                    address: null,
                    phone,
                    // A website of their own in the bio is recorded, which puts them out of scope.
                    website: ownSite ?? p.url,
                    sourceRef: `${p.network}:${p.handle.toLowerCase()}`,
                };
            }
        }

        if (!blogPages) return;
        const articles = (await this.search(`best ${keyword} in ${city} instagram`, key, 10))
            .map((r) => parseWebsite(r.url ?? null))
            .filter((u): u is URL => !!u && !hostMatches(u.hostname, SOCIAL_HOSTS))
            .slice(0, blogPages);
        for (const article of articles) {
            const html = await this.fetchArticle(article);
            if (!html) continue;
            for (const handle of instagramLinksInHtml(html)) {
                const url = `https://www.instagram.com/${handle}`;
                if (seen.has(url)) continue;
                seen.add(url);
                yield { name: `@${handle}`, category: keyword, address: null, phone: null, website: url, sourceRef: `instagram:${handle}` };
            }
        }
    }
}
