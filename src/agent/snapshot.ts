import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RegionConfig } from "../config.js";
import type { LeadStore } from "../db.js";
import type { OutreachConfig } from "../outreach/config.js";
import { monthKey } from "../outreach/store.js";
import { compareLeads, priorityOf } from "../scoring.js";

/**
 * dashboard.json: everything the dashboard shows, written after every run.
 * The dashboard only reads this file (plus pending action files).
 */
export function buildSnapshot(store: LeadStore, region: RegionConfig, cfg: OutreachConfig) {
    const o = store.outreach;
    const rows = store.allLeadsWithAudits();
    const leadById = new Map(rows.map(({ lead }) => [lead.id, lead]));
    const results = new Map(store.contactResults().map(({ lead, result }) => [lead.id, result]));
    const outreach = o.list();
    const byLead = new Map<number, typeof outreach>();
    for (const r of outreach) byLead.set(r.lead_id, [...(byLead.get(r.lead_id) ?? []), r]);
    const replies = o.replies(200);
    const replied = new Set(replies.filter((r) => r.kind === "reply" || r.kind === "opt_out").map((r) => r.lead_id));

    const item = (r: (typeof outreach)[number]) => {
        const lead = leadById.get(r.lead_id);
        const result = results.get(r.lead_id);
        return {
            id: r.id,
            lead_id: r.lead_id,
            channel: r.channel,
            name: lead?.name ?? "",
            category: lead?.category ?? null,
            score: lead?.lead_score ?? null,
            reviews: lead?.user_ratings_total ?? null,
            website: lead?.website_url ?? null,
            website_class: lead?.website_class ?? null,
            phone: lead?.phone ?? null,
            recipient: r.recipient,
            subject: r.subject,
            body: r.body,
            issues: r.issues ? (JSON.parse(r.issues) as string[]) : [],
            evidence: lead?.evidence ?? null,
            status: r.status,
            error: r.error,
            created_at: r.created_at,
            sent_at: r.sent_at,
            verification_status: r.channel === "email" ? (result?.verification_status ?? null) : null,
            risk_flag: r.channel === "email" ? (result?.risk_flag ?? null) : null,
            replied: replied.has(r.lead_id),
        };
    };

    const batches = o.batches().slice(0, 12).map((b) => ({
        ...b,
        items: outreach.filter((r) => r.batch_id === b.id).map(item),
    }));
    const chats = outreach
        .filter((r) => r.channel !== "email")
        .sort((a, b) => compareLeads(leadById.get(a.lead_id) ?? { lead_score: null, name: "" }, leadById.get(b.lead_id) ?? { lead_score: null, name: "" }))
        .map(item);

    const leads = rows
        .map(({ lead }) => lead)
        .sort(compareLeads)
        .slice(0, 1000)
        .map((l) => ({
            id: l.id,
            name: l.name,
            category: l.category,
            score: l.lead_score,
            priority: priorityOf(l.lead_score),
            website: l.website_url,
            website_class: l.website_class,
            phone: l.phone,
            rating: l.rating ?? null,
            reviews: l.user_ratings_total ?? null,
            evidence: l.evidence,
            outreach: (byLead.get(l.id) ?? []).map((r) => ({ channel: r.channel, status: r.status, sent_at: r.sent_at })),
            replied: replied.has(l.id),
        }));

    const state = (k: string) => {
        const v = o.getState(k);
        return v ? (JSON.parse(v) as unknown) : null;
    };
    return {
        version: 1,
        generated_at: new Date().toISOString(),
        region: {
            city: region.city,
            country: region.country,
            country_code: region.country_code,
            timezone: region.timezone,
            send_window: region.send_window,
            allowed_to_email: region.allowed_to_email,
        },
        sender: { name: cfg.sender.name, configured: !!cfg.sender.name },
        limits: cfg.limits,
        stats: {
            ...store.counts(),
            emails_sent: outreach.filter((r) => r.channel === "email" && r.status === "sent").length,
            emails_waiting_approval: outreach.filter((r) => r.channel === "email" && r.status === "draft").length,
            emails_approved: outreach.filter((r) => r.channel === "email" && r.status === "approved").length,
            chats_to_send: outreach.filter((r) => r.channel !== "email" && r.status === "draft").length,
            replies: replies.filter((r) => r.kind === "reply").length,
            opt_outs: replies.filter((r) => r.kind === "opt_out").length,
            bounces: replies.filter((r) => r.kind === "bounce").length,
        },
        usage: {
            month: monthKey(),
            hunter: { used: o.usage("hunter"), limit: cfg.limits.hunter_calls_per_month },
            zerobounce: { used: o.usage("zerobounce"), limit: cfg.limits.zerobounce_calls_per_month },
        },
        runs: { weekly: state("last_weekly"), tick: state("last_tick") },
        batches,
        chats,
        replies: replies.map((r) => ({ ...r, name: r.lead_id ? (leadById.get(r.lead_id)?.name ?? null) : null })),
        leads,
        failures: store.recentFailures(25),
    };
}

export type Snapshot = ReturnType<typeof buildSnapshot>;

export function writeSnapshot(path: string, snap: Snapshot) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(snap, null, 1));
    renameSync(tmp, path);
}
