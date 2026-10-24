import type { AuditRow, LeadRow } from "./db.js";
import { MOBILE_DEVICE } from "./audit/page.js";
import { classifyUrl, parseWebsite } from "./url.js";
import { websiteClass } from "./websiteClass.js";

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * One-line, plain-text evidence built only from stored measurements.
 * Each clause maps to a recorded field; nothing is inferred. Negative findings
 * are scoped to what was checked ("on homepage").
 */
const pagesChecked = (audit: AuditRow) => {
    const extra = audit.commerce_pages ? (JSON.parse(audit.commerce_pages) as string[]) : [];
    return extra.length ? `homepage or ${extra.length} shop page(s) (${extra.join(", ")})` : "homepage";
};

export function buildEvidence(lead: LeadRow, audit: AuditRow | null): string {
    const parts: string[] = [];
    const cls = websiteClass(lead.website_url, audit);
    const host = (() => {
        const u = parseWebsite(lead.website_url);
        return u ? classifyUrl(u).host : null;
    })();

    if (cls === "none") parts.push(`No website listed by ${lead.source}`);
    else if (cls === "social") parts.push(`Listed website is a social profile (${host ?? audit?.link_in_bio_host}); not loaded`);
    else if (cls === "messaging") parts.push(`Listed website is a chat link (${host ?? audit?.link_in_bio_host}); not loaded`);
    else if (!audit) parts.push(cls === "link_in_bio" ? `Listed website is a link-in-bio page (${host}); not audited yet` : "Not audited yet");
    else {
        const providers = audit.payment_providers ? (JSON.parse(audit.payment_providers) as { name: string; signal: string }[]) : null;
        switch (audit.status) {
            case "robots_disallowed":
                if (cls === "link_in_bio") parts.push(`Listed website is a link-in-bio page (${audit.link_in_bio_host})`);
                parts.push(`Not loaded: ${audit.error ?? "robots.txt disallows"}`);
                break;
            case "dead":
                parts.push(`Listed website does not exist: ${audit.error ?? "unknown"}`);
                break;
            case "unreachable":
                parts.push(
                    `Site could not be loaded on ${audit.unreachable_runs ?? 1} audit run(s)${(audit.unreachable_runs ?? 1) < 2 ? " (retried next run before scoring)" : ""}: ${audit.error ?? "unknown error"}`,
                );
                if (audit.ssl === "invalid") parts.push(audit.ssl_detail ?? "invalid certificate");
                break;
            case "blocked":
                parts.push(`Not inspected: ${audit.error}`);
                break;
            case "failed":
                parts.push(`Audit error (nothing measured): ${audit.error ?? "unknown"}`);
                break;
            case "ok": {
                const where = audit.final_url && audit.final_url !== audit.requested_url ? `${audit.requested_url} -> ${audit.final_url}` : audit.requested_url;
                if (audit.load_timed_out) parts.push(`${where} did not finish loading within the timeout on ${MOBILE_DEVICE} viewport`);
                else if (audit.load_time_ms != null) parts.push(`${where} loaded in ${fmtMs(audit.load_time_ms)} on ${MOBILE_DEVICE} viewport`);
                else parts.push(`${where} loaded on ${MOBILE_DEVICE} viewport`);
                if (audit.http_status) parts.push(`HTTP ${audit.http_status}`);
                if (cls === "hosted_storefront") parts.push(`hosted on a platform domain (${host ?? (audit.final_url ? new URL(audit.final_url).hostname : "unknown")}), not the brand's own`);
                if (audit.lighthouse_score != null && !audit.load_timed_out) parts.push(`Lighthouse mobile performance ${audit.lighthouse_score}/100`);
                if (audit.link_in_bio_only) parts.push(`page is a link-in-bio/social page (${audit.link_in_bio_host})`);
                if (audit.platform) parts.push(`platform ${audit.platform} (${audit.platform_signal})`);
                if (audit.password_protected) parts.push(`store is password-protected (${audit.password_signal})`);
                else if (audit.has_cart === 1 || audit.has_checkout === 1) parts.push(`cart/checkout found (${audit.cart_signal})`);
                else if (audit.has_cart === 0) parts.push(`no cart or checkout found on ${pagesChecked(audit)}`);
                if (audit.whatsapp_links) parts.push(`${audit.whatsapp_links} WhatsApp link(s) on homepage`);
                if (providers) {
                    parts.push(
                        providers.length
                            ? `payment providers: ${providers.map((p) => `${p.name} (${p.signal})`).join(", ")}`
                            : `no configured payment provider found on ${pagesChecked(audit)}`,
                    );
                }
                if (audit.ssl === "valid") parts.push("valid HTTPS");
                else if (audit.ssl) parts.push(audit.ssl_detail ?? `SSL ${audit.ssl}`);
                break;
            }
            default:
                parts.push(`Not loaded (${audit.status})`);
        }
    }
    if (lead.user_ratings_total != null) parts.push(`Google: ${lead.rating ?? "-"} stars from ${lead.user_ratings_total} reviews`);
    if (lead.business_status && lead.business_status !== "OPERATIONAL") parts.push(`Google business status: ${lead.business_status}`);
    // Strip separators from quoted page text so the field stays one line.
    return parts.join("; ").replace(/[\r\n\t]+/g, " ");
}
