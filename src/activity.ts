import type { LeadRow, LeadStore } from "./db.js";
import { errMessage, log } from "./log.js";
import { hasOwnWebsite } from "./websiteClass.js";

/**
 * Is the business still active? We only contact businesses that are.
 *
 *  - Google says closed (temporarily or permanently): inactive.
 *  - Newest Google review within ACTIVE_WITHIN_DAYS: active.
 *  - Reviews, but none that recent: inactive.
 *  - No reviews, or found somewhere other than Google: unknown. These are
 *    drafted but flagged, so you check their socials before sending.
 *
 * Google returns up to 5 reviews (its "most relevant", not strictly newest),
 * so "newest review we saw" can be older than the real newest one.
 */
export const ACTIVE_WITHIN_DAYS = 183; // 6 months
/** Re-check a business's activity after this long. */
const RECHECK_AFTER_DAYS = 30;
/** Most paid Place Details lookups in one run. */
export const ACTIVITY_CHECKS_PER_RUN = 60;
const DAY = 86_400_000;

export type Activity = "active" | "inactive" | "unknown";
export interface ActivityResult {
    activity: Activity;
    note: string;
    lastReviewAt: string | null;
}

export interface PlaceActivity {
    businessStatus: string | null;
    reviewTimes: string[];
}

const day = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function judgeActivity(p: PlaceActivity, now = new Date()): ActivityResult {
    if (p.businessStatus === "CLOSED_PERMANENTLY" || p.businessStatus === "CLOSED_TEMPORARILY") {
        return { activity: "inactive", note: `Google lists it as ${p.businessStatus.toLowerCase().replace("_", " ")}`, lastReviewAt: null };
    }
    const times = p.reviewTimes.map((t) => Date.parse(t)).filter((t) => Number.isFinite(t));
    if (!times.length) return { activity: "unknown", note: "no Google reviews to judge by; check their socials", lastReviewAt: null };
    const newest = new Date(Math.max(...times)).toISOString();
    const ageDays = (now.getTime() - Date.parse(newest)) / DAY;
    if (ageDays <= ACTIVE_WITHIN_DAYS) return { activity: "active", note: `latest Google review ${day(newest)}`, lastReviewAt: newest };
    return { activity: "inactive", note: `latest Google review ${day(newest)}, over 6 months ago`, lastReviewAt: newest };
}

/** One Place Details call: open/closed state and review dates. */
export async function fetchPlaceActivity(placeId: string, apiKey: string): Promise<PlaceActivity> {
    const res = await fetch(`https://places.googleapis.com/v1/places/${encodeURIComponent(placeId)}`, {
        headers: { "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": "businessStatus,reviews" },
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Place Details HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { businessStatus?: string; reviews?: { publishTime?: string }[] };
    return { businessStatus: body.businessStatus ?? null, reviewTimes: (body.reviews ?? []).map((r) => r.publishTime ?? "").filter(Boolean) };
}

export interface ActivitySummary {
    checked: number;
    active: number;
    inactive: number;
    unknown: number;
    failed: number;
}

/**
 * Check the leads we're about to contact (best first), within a per-run cap.
 * Leads not from Google are marked unknown without any paid call.
 */
export async function runActivityChecks(
    store: LeadStore,
    opts: { regionId?: number | null; minScore: number; apiKey: string | null; limit?: number; fetchPlace?: typeof fetchPlaceActivity; now?: Date },
): Promise<ActivitySummary> {
    const now = opts.now ?? new Date();
    const fetchPlace = opts.fetchPlace ?? fetchPlaceActivity;
    const summary: ActivitySummary = { checked: 0, active: 0, inactive: 0, unknown: 0, failed: 0 };
    const stale = (l: LeadRow) => !l.activity_checked_at || now.getTime() - Date.parse(l.activity_checked_at) > RECHECK_AFTER_DAYS * DAY;
    const candidates = store
        .allLeadsWithAudits()
        .map(({ lead }) => lead)
        .filter((l) => (opts.regionId == null || l.region_id === opts.regionId) && l.lead_score != null && l.lead_score >= opts.minScore)
        // Not yet contacted: no outreach, or only unsent drafts (which are withdrawn if the business turns out inactive).
        .filter((l) => !hasOwnWebsite(l.website_class) && stale(l) && store.outreach.forLead(l.id).every((r) => r.status === "draft"))
        .sort((a, b) => (b.lead_score ?? 0) - (a.lead_score ?? 0) || (b.user_ratings_total ?? 0) - (a.user_ratings_total ?? 0));
    let paid = 0;
    const cap = opts.limit ?? ACTIVITY_CHECKS_PER_RUN;
    for (const lead of candidates) {
        let result: ActivityResult;
        if (lead.source !== "google_places" || !lead.source_ref) {
            const where = /instagram/.test(lead.website_url ?? "") ? "Instagram" : /facebook/.test(lead.website_url ?? "") ? "Facebook" : /tiktok/.test(lead.website_url ?? "") ? "TikTok" : "web search";
            result = { activity: "unknown", note: `found on ${where}; check their recent posts`, lastReviewAt: null };
        } else if (lead.user_ratings_total === 0) {
            result = judgeActivity({ businessStatus: lead.business_status ?? null, reviewTimes: [] }, now); // nothing to fetch
        } else {
            if (!opts.apiKey) break;
            if (paid >= cap) break;
            try {
                paid++;
                store.outreach.recordUsage("google_place_details");
                result = judgeActivity(await fetchPlace(lead.source_ref, opts.apiKey), now);
            } catch (err) {
                summary.failed++;
                log.warn(`activity: ${lead.name}: ${errMessage(err)}`);
                store.logFailure(lead.id, "activity", errMessage(err));
                continue;
            }
        }
        store.setActivity(lead.id, result, now.toISOString());
        summary.checked++;
        summary[result.activity]++;
    }
    return summary;
}
