import { isIP } from "node:net";
import { httpGet } from "../audit/http.js";
import { RobotsChecker } from "../audit/robots.js";
import type { RegionConfig } from "../config.js";
import type { AuditRow, ContactRecord, ContactResult, LeadRow, LeadStore } from "../db.js";
import { rescoreAll } from "../export.js";
import { errMessage, log } from "../log.js";
import { RateLimiter } from "../rateLimit.js";
import { classifyUrl, parseWebsite } from "../url.js";
import { ApiConfigError, HunterClient, queueDecision, ZeroBounceClient } from "./apis.js";
import { classifyEmail, isOwnDomain, rankEmails } from "./classify.js";
import { extractEmails, extractWhatsappLinks } from "./extract.js";
import { fallbackChannel } from "./fallback.js";

export const CONTACT_PATHS = ["/contact", "/about", "/contact-us"];

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
}

export interface ContactSummary {
    processed: number;
    email: number;
    fallback: number;
    failed: number;
    skipped: number;
}

/** Whether this region permits email. Unset counts as no. */
export function emailAllowed(config: RegionConfig): boolean {
    return config.allowed_to_email === true;
}

interface Candidate extends ContactRecord {
    detail: string;
    status: string | null;
    subStatus: string | null;
}

export async function runContacts(store: LeadStore, config: RegionConfig, opts: ContactOptions): Promise<ContactSummary> {
    rescoreAll(store);
    const summary: ContactSummary = { processed: 0, email: 0, fallback: 0, failed: 0, skipped: 0 };
    const leads = store.leadsForContact(opts);
    log.info(`contacts: ${leads.length} lead(s) with lead_score >= ${opts.minScore} and a loaded site`);
    if (!leads.length) return summary;

    const allowed = emailAllowed(config);
    if (!allowed) {
        log.warn(
            config.allowed_to_email === false
                ? `contacts: allowed_to_email is false for ${config.country_code}; no lead will be queued for email`
                : `contacts: allowed_to_email is not set for ${config.country_code}; treating it as false. Set it in the region config.`,
        );
    }
    let hunter = process.env.HUNTER_API_KEY ? new HunterClient(process.env.HUNTER_API_KEY) : null;
    let zerobounce = process.env.ZEROBOUNCE_API_KEY ? new ZeroBounceClient(process.env.ZEROBOUNCE_API_KEY) : null;
    if (allowed && !hunter) log.warn("contacts: HUNTER_API_KEY not set; Hunter lookups skipped");
    if (allowed && !zerobounce) log.warn("contacts: ZEROBOUNCE_API_KEY not set; emails can't be verified, so none will be queued");

    const limiter = new RateLimiter(opts.perHostDelayMs);
    const robots = new RobotsChecker(opts.userAgentToken, limiter);
    const userAgent = `Mozilla/5.0 (compatible; ${opts.userAgentToken})`;

    const processLead = async (lead: LeadRow, audit: AuditRow): Promise<ContactResult> => {
        const now = new Date().toISOString();
        const base: ContactResult = {
            lead_id: lead.id,
            processed_at: now,
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
            error: null,
        };

        // 1. Site pages: homepage as loaded by the audit, then the contact pages.
        const home = new URL(audit.final_url ?? lead.website_url!);
        const urls = [...new Set([home.href, ...CONTACT_PATHS.map((p) => new URL(p, home.origin).href)])];
        const pageNotes: string[] = [];
        const siteEmails = new Map<string, ReturnType<typeof extractEmails>[number]>();
        let siteWhatsapp: { url: string; page: string } | null = null;
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
                    const prev = siteEmails.get(f.email);
                    if (!prev || (f.source === "mailto" && prev.source !== "mailto")) siteEmails.set(f.email, f);
                }
                siteWhatsapp ??= extractWhatsappLinks(res.body, res.finalUrl).map((u) => ({ url: u, page: res.finalUrl }))[0] ?? null;
            } catch (err) {
                pageNotes.push(`${path} (${errMessage(err)})`);
            }
        }
        const pagesChecked = `checked ${pageNotes.join(", ")}`;

        const siteHost = home.hostname;
        const candidates: Candidate[] = [...siteEmails.values()].map((f) => ({
            email: f.email,
            email_source: f.source,
            source_detail: f.pageUrl,
            email_type: classifyEmail(f.email),
            own_domain: isOwnDomain(f.email.split("@")[1]!, siteHost),
            detail: `${f.source === "mailto" ? "mailto: link" : "visible text"} on ${f.pageUrl}${f.note ? ` (${f.note})` : ""}`,
            status: null,
            subStatus: null,
        }));

        // 2. Hunter, only when the site published nothing and email is allowed.
        let hunterNote = "";
        const domain = parseWebsite(lead.website_url)?.hostname.replace(/^www\./, "") ?? null;
        if (!candidates.length && allowed && hunter && domain && !isIP(domain) && domain.includes(".")) {
            try {
                const found = await hunter.domainSearch(domain);
                hunterNote = `Hunter domain search for ${domain}: ${found.length} address(es) seen on the web`;
                for (const h of found) {
                    candidates.push({
                        email: h.value,
                        email_source: "hunter",
                        source_detail: `hunter: ${h.sourceCount} web source(s)${h.confidence != null ? `, confidence ${h.confidence}` : ""}`,
                        email_type: classifyEmail(h.value, h.type),
                        own_domain: isOwnDomain(h.value.split("@")[1]!, siteHost),
                        detail: `Hunter domain search (seen on ${h.sourceCount} web page(s)${h.confidence != null ? `, confidence ${h.confidence}` : ""})`,
                        status: null,
                        subStatus: null,
                    });
                }
            } catch (err) {
                if (err instanceof ApiConfigError) {
                    log.error(`contacts: ${err.message}; disabling Hunter for this run`);
                    hunter = null;
                }
                hunterNote = `Hunter lookup failed: ${errMessage(err)}`;
            }
        }
        store.replaceContacts(lead.id, candidates);

        const channel = fallbackChannel(lead.phone, lead.country ?? config.country_code, siteWhatsapp);
        const withChannel = { ...base, channel: channel.channel, channel_value: channel.value, channel_note: channel.note };
        const fallback = (reason: string): ContactResult => ({ ...withChannel, outcome: "fallback", reason, contact_evidence: `${reason}; ${pagesChecked}` });

        if (!allowed) return fallback(`email not permitted for region ${config.country_code} (allowed_to_email ${config.allowed_to_email === false ? "false" : "not set"})`);
        if (!candidates.length) return fallback(`no email address published on the site${hunterNote ? `; ${hunterNote}` : hunter ? "" : "; Hunter not configured"}`);

        // 3-4. Verify in preference order (each check costs a credit, so cap it).
        const ordered = rankEmails(candidates);
        const toVerify = ordered.slice(0, opts.maxVerify);
        for (const c of toVerify) {
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

        const best = rankEmails(toVerify.filter((c) => queueDecision(c.status).queue))[0];
        if (best) {
            const { riskFlag } = queueDecision(best.status);
            const statusText = `ZeroBounce: ${best.status}${best.subStatus ? ` (${best.subStatus})` : ""}`;
            const affiliation = best.own_domain ? "" : best.email_type === "free_provider" ? "; free mailbox, not at the site's domain" : `; address is not at the site's domain (${siteHost})`;
            return {
                ...withChannel,
                outcome: "email",
                email: best.email,
                email_type: best.email_type,
                email_source: best.email_source,
                verification_status: best.status,
                risk_flag: riskFlag,
                contact_evidence: `${best.email} found via ${best.detail}; ${statusText}${affiliation}`,
            };
        }

        const outcomes = toVerify.map((c) => `${c.email}: ${c.status ?? (zerobounce ? `not verified (${c.subStatus ?? "error"})` : "not verified, no ZeroBounce key")}`);
        const skipped = ordered.length - toVerify.length;
        return fallback(`${ordered.length} email(s) found, none usable (${outcomes.join("; ")}${skipped ? `; ${skipped} more not checked` : ""})`);
    };

    for (const [i, { lead, audit }] of leads.entries()) {
        const kind = classifyUrl(new URL(lead.website_url!)).kind;
        if (kind !== "website" || audit.link_in_bio_only) {
            summary.skipped++;
            continue; // not an owned site
        }
        if (lead.country && lead.country !== config.country_code) {
            summary.skipped++;
            log.info(`contacts: #${lead.id} ${lead.name} is in region ${lead.country}; run with that region's config`);
            continue;
        }
        summary.processed++;
        let result: ContactResult;
        try {
            result = await processLead(lead, audit);
        } catch (err) {
            result = {
                lead_id: lead.id, processed_at: new Date().toISOString(), outcome: "failed", email: null, email_type: null,
                email_source: null, verification_status: null, risk_flag: null, channel: null, channel_value: null,
                channel_note: null, reason: null, contact_evidence: null, error: errMessage(err),
            };
            store.logFailure(lead.id, "contact", errMessage(err));
        }
        store.saveContactResult(result);
        summary[result.outcome]++;
        const what =
            result.outcome === "email"
                ? `${result.email} (${result.email_type}, ${result.verification_status})`
                : result.outcome === "fallback"
                  ? `fallback ${result.channel}: ${result.reason}`
                  : `failed: ${result.error}`;
        log.info(`[${i + 1}/${leads.length}] #${lead.id} ${lead.name}: ${what}`);
    }
    return summary;
}
