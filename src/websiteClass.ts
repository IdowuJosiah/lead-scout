import type { AuditRow } from "./db.js";
import { classifyUrl, parseWebsite, type UrlKind } from "./url.js";

/**
 * What a lead's listed website actually is. URL-based classes come from the
 * URL alone; dead_listing needs an audit that proved the site doesn't exist
 * (DNS failure, connection refused, 404/410, parked domain).
 */
export type WebsiteClass = "none" | UrlKind | "dead_listing";

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
