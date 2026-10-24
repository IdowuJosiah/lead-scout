import type { AuditRow, LeadRow } from "./db.js";
import { websiteClass as websiteClass_, type WebsiteClass } from "./websiteClass.js";

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
 * clamped to 0..maxWithWebsite, so "no website" always ranks first. Only
 * measured facts feed the score: a lead whose site could not be inspected
 * (robots.txt, bot wall, a single transient failure, internal error, not yet
 * audited) gets no score rather than a guess. Permanently closed businesses
 * are not scored.
 */

export const WEIGHTS = {
    noWebsite: 100,
    /** Ceiling for any lead that has some website. */
    maxWithWebsite: 99,
    baseline: 5,

    // Primary gaps: the biggest one applies, they do not stack.
    deadListing: 90, // listed site doesn't exist (DNS, refused, 404/410, parked)
    socialOnly: 90, // "website" is an Instagram/Facebook/TikTok profile
    linkInBioOnly: 90,
    messagingOnly: 85, // "website" is a wa.me / t.me chat link
    whatsappOrderOnly: 85, // own site, but ordering is only via WhatsApp
    siteUnreachable: 80, // failed to load on 2 separate audit runs
    passwordProtected: 70, // store exists but is closed to the public
    noCartOrCheckout: 60, // checked homepage + up to 3 shop pages
    hostedStorefront: 40, // sells on a platform's domain, not its own

    // Secondary issues: these add up (only for sites that loaded).
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
    /** A transient load failure is only scored once it has happened on this many runs. */
    unreachableRuns: 2,
} as const;

export const PRIORITY_BANDS = { high: 60, medium: 25 } as const;

export interface ScoreResult {
    score: number | null;
    /** e.g. "no_cart_or_checkout+60; slow_load+15" */
    breakdown: string | null;
    websiteClass: WebsiteClass;
}

type LeadForScore = Pick<LeadRow, "website_url"> & Partial<Pick<LeadRow, "business_status">>;

export function scoreLead(lead: LeadForScore, audit: AuditRow | null): ScoreResult {
    const websiteClass = websiteClass_(lead.website_url, audit);
    const none = (breakdown: string | null = null): ScoreResult => ({ score: null, breakdown, websiteClass });
    if (lead.business_status === "CLOSED_PERMANENTLY") return none("closed_permanently (not scored)");
    if (websiteClass === "none") return { score: WEIGHTS.noWebsite, breakdown: `no_website=${WEIGHTS.noWebsite}`, websiteClass };

    const primary: [string, number][] = [];
    // Known from the URL (or a proven-dead audit) without loading anything.
    if (websiteClass === "dead_listing") primary.push(["dead_listing", WEIGHTS.deadListing]);
    if (websiteClass === "social") primary.push(["social_only", WEIGHTS.socialOnly]);
    if (websiteClass === "link_in_bio") primary.push(["link_in_bio_only", WEIGHTS.linkInBioOnly]);
    if (websiteClass === "messaging") primary.push(["messaging_only", WEIGHTS.messagingOnly]);

    const loaded = audit?.status === "ok";
    const unreachableConfirmed = audit?.status === "unreachable" && (audit.unreachable_runs ?? 1) >= THRESHOLDS.unreachableRuns;
    if (!primary.length && !loaded && !unreachableConfirmed) return none(); // nothing measured yet

    if (unreachableConfirmed) primary.push(["site_unreachable", WEIGHTS.siteUnreachable]);
    const secondary: [string, number][] = [];
    if (loaded && audit) {
        if (websiteClass === "hosted_storefront") primary.push(["hosted_storefront", WEIGHTS.hostedStorefront]);
        if (audit.password_protected) primary.push(["password_protected", WEIGHTS.passwordProtected]);
        if (audit.whatsapp_order_only) primary.push(["whatsapp_order_only", WEIGHTS.whatsappOrderOnly]);
        if (!audit.password_protected && audit.has_cart === 0 && audit.has_checkout === 0) primary.push(["no_cart_or_checkout", WEIGHTS.noCartOrCheckout]);

        if (audit.load_timed_out) secondary.push(["load_timed_out", WEIGHTS.loadTimedOut]);
        else if (audit.load_time_ms != null && audit.load_time_ms >= THRESHOLDS.verySlowLoadMs) secondary.push(["very_slow_load", WEIGHTS.verySlowLoad]);
        else if (audit.load_time_ms != null && audit.load_time_ms >= THRESHOLDS.slowLoadMs) secondary.push(["slow_load", WEIGHTS.slowLoad]);

        // Lighthouse only counts when our own load finished, so the two never contradict.
        if (audit.lighthouse_score != null && !audit.load_timed_out) {
            if (audit.lighthouse_score < THRESHOLDS.lighthousePoor) secondary.push(["lighthouse_poor", WEIGHTS.lighthousePoor]);
            else if (audit.lighthouse_score < THRESHOLDS.lighthouseGood) secondary.push(["lighthouse_needs_work", WEIGHTS.lighthouseNeedsWork]);
        }
        if (audit.ssl === "invalid" || audit.ssl === "none") secondary.push(["no_valid_ssl", WEIGHTS.noValidSsl]);
        const hasStore = audit.has_cart === 1 || audit.has_checkout === 1;
        if (hasStore && audit.payment_providers === "[]") secondary.push(["no_payment_provider_detected", WEIGHTS.noPaymentProviderDetected]);
    }

    const top = primary.sort((a, b) => b[1] - a[1])[0];
    const parts: [string, number][] = [["baseline", WEIGHTS.baseline], ...(top ? [top] : []), ...secondary];
    const total = parts.reduce((sum, [, w]) => sum + w, 0);
    return {
        score: Math.max(0, Math.min(WEIGHTS.maxWithWebsite, total)),
        breakdown: parts.map(([k, w]) => `${k}+${w}`).join("; "),
        websiteClass,
    };
}

/**
 * Ranking: lead_score (desc, unscored last), then Google review count (desc,
 * more reviews = a more established business), then name.
 */
export function compareLeads(
    a: Pick<LeadRow, "lead_score" | "name"> & Partial<Pick<LeadRow, "user_ratings_total">>,
    b: Pick<LeadRow, "lead_score" | "name"> & Partial<Pick<LeadRow, "user_ratings_total">>,
): number {
    return (b.lead_score ?? -1) - (a.lead_score ?? -1) || (b.user_ratings_total ?? -1) - (a.user_ratings_total ?? -1) || a.name.localeCompare(b.name);
}

export function priorityOf(score: number | null): "high" | "medium" | "low" | "" {
    if (score == null) return "";
    if (score >= PRIORITY_BANDS.high) return "high";
    if (score >= PRIORITY_BANDS.medium) return "medium";
    return "low";
}
