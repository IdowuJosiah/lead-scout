import type { AuditRow, LeadRow } from "./db.js";
import { MOBILE_DEVICE } from "./audit/page.js";

const fmtMs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

/**
 * One-line, plain-text evidence built only from stored measurements.
 * Each clause maps to a recorded field; nothing is inferred. Negative findings
 * are scoped to what was checked ("on homepage").
 */
export function buildEvidence(lead: LeadRow, audit: AuditRow | null): string {
    if (!lead.website_url) return `No website listed by ${lead.source}`;
    if (!audit) return "Not audited yet";

    const parts: string[] = [];
    const providers = audit.payment_providers ? (JSON.parse(audit.payment_providers) as { name: string; signal: string }[]) : null;

    switch (audit.status) {
        case "social_profile":
            parts.push(`Listed website is a social profile (${audit.link_in_bio_host}); not loaded`);
            break;
        case "whatsapp_link":
            parts.push("Listed website is a WhatsApp chat link; not loaded");
            break;
        case "robots_disallowed":
            if (audit.link_in_bio_only) parts.push(`Listed website is a link-in-bio page (${audit.link_in_bio_host})`);
            parts.push(`Not loaded: ${audit.error ?? "robots.txt disallows"}`);
            break;
        case "unreachable":
            parts.push(`Site could not be loaded: ${audit.error ?? "unknown error"}`);
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
            if (audit.lighthouse_score != null) parts.push(`Lighthouse mobile performance ${audit.lighthouse_score}/100`);
            if (audit.link_in_bio_only) parts.push(`page is a link-in-bio/social page (${audit.link_in_bio_host})`);
            if (audit.platform) parts.push(`platform ${audit.platform} (${audit.platform_signal})`);
            if (audit.has_cart === 1 || audit.has_checkout === 1) parts.push(`cart/checkout found on homepage (${audit.cart_signal})`);
            else if (audit.has_cart === 0) parts.push("no cart or checkout found on homepage");
            if (audit.whatsapp_links) parts.push(`${audit.whatsapp_links} WhatsApp link(s) on homepage`);
            if (providers) {
                parts.push(
                    providers.length
                        ? `payment providers: ${providers.map((p) => `${p.name} (${p.signal})`).join(", ")}`
                        : "no configured payment provider found on homepage",
                );
            }
            if (audit.ssl === "valid") parts.push("valid HTTPS");
            else if (audit.ssl) parts.push(audit.ssl_detail ?? `SSL ${audit.ssl}`);
            break;
        }
    }
    // Strip separators from quoted page text so the field stays one line.
    return parts.join("; ").replace(/[\r\n\t]+/g, " ");
}
