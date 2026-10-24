import type { AuditRow, LeadRow } from "./db.js";

/**
 * Lead scoring: all weights and thresholds live here.
 *
 * Higher = more in need of an ecommerce site.
 *   - no website                         -> 100
 *   - no way to buy online (primary gap) -> high   (~60-95)
 *   - slow / broken mobile experience    -> medium (~25-55)
 *   - good modern store                  -> low    (~5)
 *
 * score = BASELINE + max(applicable PRIMARY gaps) + sum(applicable SECONDARY issues),
 * clamped to 0..maxWithWebsite, so "no website" always ranks first. Only measured facts feed the score: a lead whose site could
 * not be inspected (robots.txt, bot wall, internal error, not yet audited) gets
 * no score rather than a guess.
 */

export const WEIGHTS = {
    noWebsite: 100,
    /** Ceiling for any lead that has some website. */
    maxWithWebsite: 99,
    baseline: 5,

    // Primary gaps: the biggest one applies, they do not stack.
    linkInBioOnly: 90,
    whatsappOrderOnly: 85,
    siteUnreachable: 80,
    noCartOrCheckout: 60,

    // Secondary issues: these add up.
    loadTimedOut: 30,
    verySlowLoad: 25,
    slowLoad: 15,
    lighthousePoor: 20,
    lighthouseNeedsWork: 8,
    noValidSsl: 10,
    noPaymentProviderDetected: 5,
} as const;

export const THRESHOLDS = {
    slowLoadMs: 5_000,
    verySlowLoadMs: 10_000,
    /** Lighthouse performance below this is "poor" (Lighthouse's own red band). */
    lighthousePoor: 50,
    /** Below this is "needs improvement" (Lighthouse's orange band). */
    lighthouseGood: 90,
} as const;

export const PRIORITY_BANDS = { high: 60, medium: 25 } as const;

/** Audit statuses where something about the brand's own site was measured. */
const MEASURED = new Set(["ok", "unreachable", "social_profile", "whatsapp_link"]);

export interface ScoreResult {
    score: number | null;
    /** e.g. "no_cart_or_checkout+60; slow_load+15" */
    breakdown: string | null;
}

export function scoreLead(lead: Pick<LeadRow, "website_url">, audit: AuditRow | null): ScoreResult {
    if (!lead.website_url) return { score: WEIGHTS.noWebsite, breakdown: `no_website=${WEIGHTS.noWebsite}` };
    if (!audit) return { score: null, breakdown: null };
    // A link-in-bio URL is known from the URL alone, even when robots.txt blocks loading it.
    if (!MEASURED.has(audit.status) && !audit.link_in_bio_only) return { score: null, breakdown: null };

    const primary: [string, number][] = [];
    if (audit.link_in_bio_only) primary.push(["link_in_bio_only", WEIGHTS.linkInBioOnly]);
    if (audit.whatsapp_order_only) primary.push(["whatsapp_order_only", WEIGHTS.whatsappOrderOnly]);
    if (audit.status === "unreachable") primary.push(["site_unreachable", WEIGHTS.siteUnreachable]);
    if (audit.status === "ok" && audit.has_cart === 0 && audit.has_checkout === 0) {
        primary.push(["no_cart_or_checkout", WEIGHTS.noCartOrCheckout]);
    }

    const secondary: [string, number][] = [];
    if (audit.status === "ok") {
        if (audit.load_timed_out) secondary.push(["load_timed_out", WEIGHTS.loadTimedOut]);
        else if (audit.load_time_ms != null && audit.load_time_ms >= THRESHOLDS.verySlowLoadMs) secondary.push(["very_slow_load", WEIGHTS.verySlowLoad]);
        else if (audit.load_time_ms != null && audit.load_time_ms >= THRESHOLDS.slowLoadMs) secondary.push(["slow_load", WEIGHTS.slowLoad]);

        if (audit.lighthouse_score != null) {
            if (audit.lighthouse_score < THRESHOLDS.lighthousePoor) secondary.push(["lighthouse_poor", WEIGHTS.lighthousePoor]);
            else if (audit.lighthouse_score < THRESHOLDS.lighthouseGood) secondary.push(["lighthouse_needs_work", WEIGHTS.lighthouseNeedsWork]);
        }
        if (audit.ssl === "invalid" || audit.ssl === "none") secondary.push(["no_valid_ssl", WEIGHTS.noValidSsl]);
        const hasStore = audit.has_cart === 1 || audit.has_checkout === 1;
        if (hasStore && audit.payment_providers === "[]") secondary.push(["no_payment_provider_detected", WEIGHTS.noPaymentProviderDetected]);
    }

    const top = primary.sort((a, b) => b[1] - a[1])[0];
    const parts: [string, number][] = [["baseline", WEIGHTS.baseline], ...(top ? [top] : []), ...secondary];
    const total = parts.reduce((s, [, w]) => s + w, 0);
    return {
        score: Math.max(0, Math.min(WEIGHTS.maxWithWebsite, total)),
        breakdown: parts.map(([k, w]) => `${k}+${w}`).join("; "),
    };
}

export function priorityOf(score: number | null): "high" | "medium" | "low" | "" {
    if (score == null) return "";
    if (score >= PRIORITY_BANDS.high) return "high";
    if (score >= PRIORITY_BANDS.medium) return "medium";
    return "low";
}
