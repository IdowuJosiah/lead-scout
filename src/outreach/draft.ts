import type { RegionConfig } from "../config.js";
import { stage3Exclusion } from "../contact/export.js";
import { fallbackChannel } from "../contact/fallback.js";
import { emailAllowed } from "../contact/index.js";
import type { LeadRow, LeadStore } from "../db.js";
import { rescoreAll } from "../export.js";
import { log } from "../log.js";
import { compareLeads } from "../scoring.js";
import { parseWebsite } from "../url.js";
import { websiteClass } from "../websiteClass.js";
import { composeEmail, composeWhatsapp } from "./compose.js";
import { assertSenderSet, type OutreachConfig } from "./config.js";

export interface DraftSummary {
    batchId: number | null;
    emailDrafts: number;
    whatsappDrafts: number;
    phoneDrafts: number;
    /** Leads skipped because no measured issue could be put into words. */
    noStatableIssue: number;
}

/** Normalise any WhatsApp link to https://wa.me/<digits> when the number is in it. */
export function waLink(url: string): string {
    try {
        const u = new URL(url);
        const digits = (u.searchParams.get("phone") ?? (u.hostname.endsWith("wa.me") ? u.pathname.slice(1) : "")).replace(/\D/g, "");
        return digits.length >= 8 ? `https://wa.me/${digits}` : url;
    } catch {
        return url;
    }
}

const DAY = 24 * 3600 * 1000;

/**
 * Write new drafts:
 *  - emails for leads in the email queue (stage 3 found a verified address),
 *    collected into one batch that waits for your approval;
 *  - WhatsApp (or phone) messages for high-scoring leads with no usable email.
 * Leads that already have outreach, replied, or are on the do-not-contact
 * list are never drafted again. Nothing is sent here.
 */
export function runDraft(store: LeadStore, region: RegionConfig, cfg: OutreachConfig): DraftSummary {
    assertSenderSet(cfg);
    rescoreAll(store);
    const o = store.outreach;
    const summary: DraftSummary = { batchId: null, emailDrafts: 0, whatsappDrafts: 0, phoneDrafts: 0, noStatableIssue: 0 };
    const audits = new Map(store.allLeadsWithAudits().map(({ lead, audit }) => [lead.id, { lead, audit }]));
    const results = new Map(store.contactResults().map(({ lead, result }) => [lead.id, result]));
    const blocked = (lead: LeadRow, recipient: string | null) => o.leadHasReplied(lead.id) || o.isSuppressed(recipient) || o.isSuppressed(lead.phone);

    // ---- Emails, into a batch awaiting approval ----
    // A batch never changes after it's created, so what you approve is exactly
    // what you saw. New drafts wait until the current batch has been handled.
    const open = o.openBatch();
    if (open) {
        summary.batchId = open;
        log.info(`draft: batch #${open} is still waiting for your approval; new email drafts wait for it`);
    } else if (emailAllowed(region)) {
        const candidates = store
            .contactResults()
            .filter(({ lead, result }) => result.outcome === "email" && result.email && !stage3Exclusion(lead, result, region))
            .filter(({ lead, result }) => !o.hasOutreach(lead.id, "email") && !blocked(lead, result.email))
            .sort((a, b) => compareLeads(a.lead, b.lead));
        let batchId: number | null = null;
        let room = cfg.limits.batch_size;
        for (const { lead, result } of candidates) {
            if (room <= 0) break;
            const msg = composeEmail(lead, audits.get(lead.id)?.audit ?? null, region, cfg);
            if (!msg) {
                summary.noStatableIssue++;
                continue;
            }
            batchId ??= o.createBatch();
            if (o.addDraft({ lead_id: lead.id, channel: "email", recipient: result.email, subject: msg.subject, body: msg.body, issues: msg.issues, batch_id: batchId })) {
                summary.emailDrafts++;
                room--;
            }
        }
        summary.batchId = batchId;
    }

    // ---- WhatsApp / phone, for leads that won't get an email ----
    const weekAgo = new Date(Date.now() - 7 * DAY).toISOString();
    const recent = o.list("channel IN ('whatsapp', 'phone') AND created_at >= ?", weekAgo).length;
    let room = Math.max(0, cfg.limits.whatsapp_drafts_per_week - recent);
    const leads = [...audits.values()]
        .filter(({ lead }) => lead.lead_score != null && lead.lead_score >= region.contact_min_score)
        .filter(({ lead }) => (lead.country ?? region.country_code) === region.country_code)
        .sort((a, b) => compareLeads(a.lead, b.lead));
    for (const { lead, audit } of leads) {
        if (room <= 0) break;
        if (o.hasOutreach(lead.id)) continue;
        const cls = websiteClass(lead.website_url, audit);
        const result = results.get(lead.id);
        // Owned sites go through stage 3 first; those with a usable email get an email instead.
        if (cls === "owned_site" && result?.outcome !== "fallback") continue;
        if (result?.outcome === "email" && emailAllowed(region)) continue;

        let channel: "whatsapp" | "phone";
        let recipient: string;
        const listed = parseWebsite(lead.website_url);
        if (cls === "messaging" && listed && /wa\.me|whatsapp/.test(listed.hostname)) {
            channel = "whatsapp";
            recipient = waLink(listed.href);
        } else if (result?.channel === "whatsapp" && result.channel_value) {
            channel = "whatsapp";
            recipient = waLink(result.channel_value);
        } else {
            const ch = fallbackChannel(lead.phone, lead.country ?? region.country_code, null);
            if (ch.channel === "none" || !ch.value) continue;
            channel = ch.channel;
            recipient = ch.channel === "whatsapp" ? waLink(ch.value) : ch.value;
        }
        if (blocked(lead, recipient)) continue;
        const msg = composeWhatsapp(lead, audit, region, cfg);
        if (!msg) {
            summary.noStatableIssue++;
            continue;
        }
        if (o.addDraft({ lead_id: lead.id, channel, recipient, subject: null, body: msg.body, issues: msg.issues, batch_id: null })) {
            if (channel === "whatsapp") summary.whatsappDrafts++;
            else summary.phoneDrafts++;
            room--;
        }
    }
    log.info(
        `draft: ${summary.emailDrafts} email(s)${summary.batchId ? ` in batch #${summary.batchId} (awaiting your approval)` : ""}, ` +
            `${summary.whatsappDrafts} WhatsApp, ${summary.phoneDrafts} phone` +
            `${summary.noStatableIssue ? `; ${summary.noStatableIssue} lead(s) skipped: no measured issue to mention` : ""}`,
    );
    return summary;
}
