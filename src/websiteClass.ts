import type { AuditRow } from "./db.js";
import { classifyUrl, parseWebsite, type UrlKind } from "./url.js";

/**
 * What a lead's listed website actually is. URL-based classes come from the
 * URL alone; dead_listing needs an audit that proved the site doesn't exist
 * (DNS failure, connection refused, 404/410, parked domain).
 */
export type WebsiteClass = "none" | UrlKind | "dead_listing";

/**
 * Businesses that already have a website of their own (working or not) are
 * out of scope: they are never scored, audited, contacted or listed.
 */
export const OWN_WEBSITE_CLASSES: ReadonlySet<string> = new Set(["owned_site", "hosted_storefront", "dead_listing"]);

let ownWebsitesInScope = false;
/** config/region.json "include_businesses_with_websites" (default false). */
export function setOwnWebsitesInScope(include: boolean) {
    ownWebsitesInScope = include;
}
export const ownWebsitesIncluded = () => ownWebsitesInScope;
/** True when this class is a business with its own website and those are out of scope. */
export const hasOwnWebsite = (cls: string | null | undefined) => !ownWebsitesInScope && !!cls && OWN_WEBSITE_CLASSES.has(cls);

export function websiteClass(websiteUrl: string | null, audit: Pick<AuditRow, "status" | "final_url"> | null): WebsiteClass {
    const url = parseWebsite(websiteUrl);
    if (!url) return "none";
    if (audit?.status === "dead") return "dead_listing";
    const listed = classifyUrl(url).kind;
    if (listed !== "owned_site") return listed;
    // An own domain that redirects to Instagram, a marketplace etc. is not an owned site.
    if (audit?.status === "ok" && audit.final_url) {
        const landed = parseWebsite(audit.final_url);
        if (landed) return classifyUrl(landed).kind;
    }
    return "owned_site";
}
