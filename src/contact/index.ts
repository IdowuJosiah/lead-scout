import { isIP } from "node:net";
import { httpGet } from "../audit/http.js";
import { RobotsChecker } from "../audit/robots.js";
import type { RegionConfig } from "../config.js";
import type { AuditRow, ContactRecord, ContactResult, LeadRow, LeadStore } from "../db.js";
import { rescoreAll } from "../export.js";
import { errMessage, log } from "../log.js";
import { RateLimiter } from "../rateLimit.js";
import { parseWebsite } from "../url.js";
import { websiteClass } from "../websiteClass.js";
import { ApiConfigError, HunterClient, queueDecision, ZeroBounceClient, type HunterEmail } from "./apis.js";
import { classifyEmail, isOwnDomain, rankEmails } from "./classify.js";
import { extractEmails, extractWhatsappLinks } from "./extract.js";
import { fallbackChannel } from "./fallback.js";

export const CONTACT_PATHS = ["/contact", "/about", "/contact-us"];

export interface PaidPlan {
    leads: number;
    hunterCalls: number;
    hunterCached: number;
    zeroBounceCalls: number;
    zeroBounceCached: number;
    /** Extra ZeroBounce calls possible for addresses Hunter may return. */
    zeroBounceUpTo: number;
}

export interface ContactOptions {
    minScore: number;
    recontact: boolean;
    limit?: number;
    ids?: number[];
    /** Most addresses verified per lead (each costs a ZeroBounce credit). */
    maxVerify: number;
    perHostDelayMs: number;
    userAgentToken: string;
    timeoutMs: number;
    /** Print the paid-call plan and stop before any paid call or write. */
    dryRun?: boolean;
    /**
     * Asked before any paid call. Resolve true to go ahead. Without it, paid
     * calls are not made: leads that need them are left for a later run.
     */
    confirm?: (plan: PaidPlan) => Promise<boolean>;
}

export interface ContactSummary {
    processed: number;
    email: number;
    fallback: number;
    failed: number;
    skipped: number;
    /** Left unprocessed because their paid calls were not approved. */
    deferred: number;
    plan: PaidPlan | null;
}

/** Whether this region permits email. Unset counts as no. */
export function emailAllowed(config: RegionConfig): boolean {
    return config.allowed_to_email === true;
}

export function freeProviderFlag(email: string): string {
    return `free mailbox (${email.split("@")[1]}), not at the site's own domain`;
}

interface Candidate extends ContactRecord {
    detail: string;
    status: string | null;
    subStatus: string | null;
}

/** Everything learned for one lead without spending anything. */
interface Gathered {
    lead: LeadRow;
    home: URL;
    pageNotes: string[];
    siteWhatsapp: { url: string; page: string } | null;
    candidates: Candidate[];
    /** Addresses found on the site at other businesses' domains (not usable). */
    ignored: string[];
    /** Domain for a Hunter lookup, when the site published nothing usable. */
    hunterDomain: string | null;
    hunterCached: HunterEmail[] | null;
}

const hunterCandidate = (h: HunterEmail, siteHost: string): Candidate => ({
    email: h.value,
    email_source: "hunter",
    source_detail: `hunter: ${h.sourceCount} web source(s)${h.confidence != null ? `, confidence ${h.confidence}` : ""}`,
    email_type: classifyEmail(h.value, h.type),
    own_domain: isOwnDomain(h.value.split("@")[1]!, siteHost),
    detail: `Hunter domain search (seen on ${h.sourceCount} web page(s)${h.confidence != null ? `, confidence ${h.confidence}` : ""})`,
    status: null,
    subStatus: null,
});

export async function runContacts(store: LeadStore, config: RegionConfig, opts: ContactOptions): Promise<ContactSummary> {
    rescoreAll(store);
    const summary: ContactSummary = { processed: 0, email: 0, fallback: 0, failed: 0, skipped: 0, deferred: 0, plan: null };

    // Only owned sites, and only leads in the loaded region.
    const eligible = store.leadsForContact(opts).filter(({ lead, audit }) => {
        if (websiteClass(lead.website_url, audit) !== "owned_site") {
            summary.skipped++;
            return false;
        }
        if (lead.country && lead.country !== config.country_code) {
            summary.skipped++;
            log.info(`contacts: #${lead.id} ${lead.name} is in region ${lead.country}; run with that region's config`);
            return false;
        }
        return true;
    });
    log.info(`contacts: ${eligible.length} lead(s) with lead_score >= ${opts.minScore} and an owned site (${summary.skipped} skipped)`);
    if (!eligible.length) return summary;

    const allowed = emailAllowed(config);
    if (!allowed) {
        log.warn(
            config.allowed_to_email === false
                ? `contacts: allowed_to_email is false for ${config.country_code}; no lead will be queued for email and no paid lookups are made`
                : `contacts: allowed_to_email is not set for ${config.country_code}; treating it as false. Set it in the region config.`,
        );
    }
    let hunter = allowed && process.env.HUNTER_API_KEY ? new HunterClient(process.env.HUNTER_API_KEY) : null;
    let zerobounce = allowed && process.env.ZEROBOUNCE_API_KEY ? new ZeroBounceClient(process.env.ZEROBOUNCE_API_KEY) : null;
    if (allowed && !hunter) log.warn("contacts: HUNTER_API_KEY not set; Hunter lookups skipped (cached results still used)");
    if (allowed && !zerobounce) log.warn("contacts: ZEROBOUNCE_API_KEY not set; uncached emails can't be verified, so they won't be queued");

    const limiter = new RateLimiter(opts.perHostDelayMs);
    const robots = new RobotsChecker(opts.userAgentToken, limiter);
    const userAgent = `Mozilla/5.0 (compatible; ${opts.userAgentToken})`;

    // ---- Phase 1: free. Fetch site pages, extract, look up caches. ----
    const gather = async (lead: LeadRow, audit: AuditRow): Promise<Gathered> => {
        const home = new URL(audit.final_url ?? lead.website_url!);
        const urls = [...new Set([home.href, ...CONTACT_PATHS.map((p) => new URL(p, home.origin).href)])];
        const pageNotes: string[] = [];
        const found = new Map<string, ReturnType<typeof extractEmails>[number]>();
        let siteWhatsapp: Gathered["siteWhatsapp"] = null;
        for (const url of urls) {
            const path = new URL(url).pathname;
            try {
                const verdict = await robots.check(url);
                if (!verdict.allowed) {
                    pageNotes.push(`${path} (robots.txt disallows)`);
                    continue;
                }
                if (verdict.crawlDelayMs) limiter.setInterval(home.host, verdict.crawlDelayMs);
                await limiter.wait(home.host);
                const res = await httpGet(url, { headers: { "User-Agent": userAgent, Accept: "text/html" }, timeoutMs: opts.timeoutMs, maxBytes: 3_000_000 });
                if (res.status !== 200) {
                    pageNotes.push(`${path} (HTTP ${res.status})`);
                    continue;
                }
                pageNotes.push(path);
                for (const f of extractEmails(res.body, res.finalUrl)) {
                    const prev = found.get(f.email);
                    if (!prev || (f.source === "mailto" && prev.source !== "mailto")) found.set(f.email, f);
                }
                siteWhatsapp ??= extractWhatsappLinks(res.body, res.finalUrl).map((u) => ({ url: u, page: res.finalUrl }))[0] ?? null;
            } catch (err) {
                pageNotes.push(`${path} (${errMessage(err)})`);
            }
        }

        const candidates: Candidate[] = [];
        const ignored: string[] = [];
        for (const f of found.values()) {
            const type = classifyEmail(f.email);
            const own = isOwnDomain(f.email.split("@")[1]!, home.hostname);
            // Addresses at someone else's domain (web designer, platform, supplier) are never the lead's.
            if (!own && type !== "free_provider") {
                ignored.push(f.email);
                continue;
            }
            candidates.push({
                email: f.email,
                email_source: f.source,
                source_detail: f.pageUrl,
                email_type: type,
                own_domain: own,
                detail: `${f.source === "mailto" ? "mailto: link" : "visible text"} on ${f.pageUrl}${f.note ? ` (${f.note})` : ""}`,
                status: null,
                subStatus: null,
            });
        }

        const host = parseWebsite(lead.website_url)?.hostname.replace(/^www\./, "") ?? null;
        const hunterDomain = !candidates.length && allowed && host && !isIP(host) && host.includes(".") ? host : null;
        const cached = hunterDomain ? store.getHunterCache(hunterDomain) : null;
        return { lead, home, pageNotes, siteWhatsapp, candidates, ignored, hunterDomain, hunterCached: cached ? (JSON.parse(cached.emails) as HunterEmail[]) : null };
    };

    const toVerify = (cands: Candidate[]) => rankEmails(cands).slice(0, opts.maxVerify);
    const uncachedVerifications = (cands: Candidate[]) => toVerify(cands).filter((c) => !store.getVerification(c.email)).length;

    const gathered: Gathered[] = [];
    for (const { lead, audit } of eligible) {
        try {
            gathered.push(await gather(lead, audit));
        } catch (err) {
            summary.processed++;
            summary.failed++;
            store.saveContactResult(failedResult(lead.id, errMessage(err)));
            store.logFailure(lead.id, "contact", errMessage(err));
        }
    }

    // ---- Plan paid calls ----
    const plan: PaidPlan = { leads: 0, hunterCalls: 0, hunterCached: 0, zeroBounceCalls: 0, zeroBounceCached: 0, zeroBounceUpTo: 0 };
    const needsPaid = new Set<Gathered>();
    if (allowed) {
        for (const g of gathered) {
            let paid = false;
            let cands = g.candidates;
            if (g.hunterDomain) {
                if (g.hunterCached) {
                    plan.hunterCached++;
                    cands = g.hunterCached.map((h) => hunterCandidate(h, g.home.hostname));
                } else if (hunter) {
                    plan.hunterCalls++;
                    plan.zeroBounceUpTo += zerobounce ? opts.maxVerify : 0;
                    paid = true;
                }
            }
            const verify = toVerify(cands);
            const uncached = zerobounce ? uncachedVerifications(cands) : 0;
            plan.zeroBounceCalls += uncached;
            plan.zeroBounceCached += verify.length - verify.filter((c) => !store.getVerification(c.email)).length;
            if (uncached) paid = true;
            if (paid) needsPaid.add(g);
        }
        plan.leads = needsPaid.size;
    }
    summary.plan = plan;
    const totalPaid = plan.hunterCalls + plan.zeroBounceCalls;
    log.info(
        `contacts: paid calls needed: Hunter ${plan.hunterCalls} (cached ${plan.hunterCached}), ZeroBounce ${plan.zeroBounceCalls}` +
            `${plan.zeroBounceUpTo ? ` + up to ${plan.zeroBounceUpTo} for addresses Hunter returns` : ""} (cached ${plan.zeroBounceCached}), across ${plan.leads} lead(s)`,
    );
    if (opts.dryRun) {
        log.info("contacts: dry run; nothing saved and no paid calls made");
        return summary;
    }
    let paidApproved = totalPaid === 0;
    if (totalPaid > 0) {
        paidApproved = opts.confirm ? await opts.confirm(plan) : false;
        if (!paidApproved) log.warn(`contacts: paid calls not approved; ${needsPaid.size} lead(s) that need them are left for a later run`);
    }
    if (!paidApproved) {
        hunter = null;
        zerobounce = null;
    }

    // ---- Phase 2: decide each lead (paid calls only if approved). ----
    const finalize = async (g: Gathered): Promise<ContactResult> => {
        const { lead } = g;
        let candidates = g.candidates;
        let hunterNote = "";
        if (g.hunterDomain) {
            let found = g.hunterCached;
            if (!found && hunter) {
                try {
                    found = await hunter.domainSearch(g.hunterDomain);
                    store.saveHunterCache(g.hunterDomain, JSON.stringify(found));
                } catch (err) {
                    if (err instanceof ApiConfigError) {
                        log.error(`contacts: ${err.message}; disabling Hunter for this run`);
                        hunter = null;
                    }
                    hunterNote = `Hunter lookup failed: ${errMessage(err)}`;
                }
            }
            if (found) {
                candidates = found.filter((h) => isOwnDomain(h.value.split("@")[1]!, g.home.hostname)).map((h) => hunterCandidate(h, g.home.hostname));
                hunterNote = `Hunter domain search for ${g.hunterDomain}${g.hunterCached ? " (cached)" : ""}: ${candidates.length} address(es) seen on the web`;
            } else if (!hunterNote) {
                hunterNote = "Hunter not run";
            }
        }
        store.replaceContacts(lead.id, candidates);

        const channel = fallbackChannel(lead.phone, lead.country ?? config.country_code, g.siteWhatsapp);
        const ignoredNote = g.ignored.length ? `; ignored ${g.ignored.length} address(es) at other domains (${g.ignored.join(", ")})` : "";
        const pagesChecked = `checked ${g.pageNotes.join(", ")}${ignoredNote}`;
        const base: ContactResult = {
            ...failedResult(lead.id, null),
            channel: channel.channel,
            channel_value: channel.value,
            channel_note: channel.note,
        };
        const fallback = (reason: string): ContactResult => ({ ...base, outcome: "fallback", reason, contact_evidence: `${reason}; ${pagesChecked}` });

        if (!allowed) return fallback(`email not permitted for region ${config.country_code} (allowed_to_email ${config.allowed_to_email === false ? "false" : "not set"})`);
        if (!candidates.length) return fallback(`no usable email address published on the site${hunterNote ? `; ${hunterNote}` : ""}`);

        const verify = toVerify(candidates);
        for (const c of verify) {
            const cached = store.getVerification(c.email);
            if (cached) {
                c.status = cached.status;
                c.subStatus = cached.sub_status;
                continue;
            }
            if (!zerobounce) continue;
            try {
                const v = await zerobounce.validate(c.email);
                c.status = v.status;
                c.subStatus = v.subStatus;
                store.saveVerification({ email: c.email, status: v.status, sub_status: v.subStatus, provider: "zerobounce", verified_at: new Date().toISOString() });
            } catch (err) {
                if (err instanceof ApiConfigError) {
                    log.error(`contacts: ${err.message}; disabling ZeroBounce for this run`);
                    zerobounce = null;
                }
                c.subStatus = errMessage(err);
            }
        }

        const best = rankEmails(verify.filter((c) => queueDecision(c.status).queue))[0];
        if (best) {
            const flags = [queueDecision(best.status).riskFlag, best.email_type === "free_provider" ? freeProviderFlag(best.email) : null].filter(Boolean);
            return {
                ...base,
                outcome: "email",
                email: best.email,
                email_type: best.email_type,
                email_source: best.email_source,
                verification_status: best.status,
                risk_flag: flags.length ? flags.join("; ") : null,
                contact_evidence: `${best.email} found via ${best.detail}; ZeroBounce: ${best.status}${best.subStatus ? ` (${best.subStatus})` : ""}${ignoredNote}`,
            };
        }
        const outcomes = verify.map((c) => `${c.email}: ${c.status ?? `not verified (${c.subStatus ?? (zerobounce ? "error" : "no ZeroBounce key or not approved")})`}`);
        const unchecked = candidates.length - verify.length;
        return fallback(`${candidates.length} email(s) found, none usable (${outcomes.join("; ")}${unchecked ? `; ${unchecked} more not checked` : ""})`);
    };

    for (const [i, g] of gathered.entries()) {
        if (!paidApproved && needsPaid.has(g)) {
            summary.deferred++;
            continue;
        }
        summary.processed++;
        let result: ContactResult;
        try {
            result = await finalize(g);
        } catch (err) {
            result = failedResult(g.lead.id, errMessage(err));
            store.logFailure(g.lead.id, "contact", errMessage(err));
        }
        store.saveContactResult(result);
        summary[result.outcome]++;
        const what =
            result.outcome === "email"
                ? `${result.email} (${result.email_type}, ${result.verification_status})`
                : result.outcome === "fallback"
                  ? `fallback ${result.channel}: ${result.reason}`
                  : `failed: ${result.error}`;
        log.info(`[${i + 1}/${gathered.length}] #${g.lead.id} ${g.lead.name}: ${what}`);
    }
    return summary;
}

function failedResult(leadId: number, error: string | null): ContactResult {
    return {
        lead_id: leadId,
        processed_at: new Date().toISOString(),
        outcome: "failed",
        email: null,
        email_type: null,
        email_source: null,
        verification_status: null,
        risk_flag: null,
        channel: null,
        channel_value: null,
        channel_note: null,
        reason: null,
        contact_evidence: null,
        error,
    };
}
