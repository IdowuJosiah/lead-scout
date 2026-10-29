import { existsSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { LeadStore } from "../db.js";
import { errMessage, log } from "../log.js";
import type { OutreachConfig } from "../outreach/config.js";

/**
 * Actions from the dashboard. The dashboard never touches the database: it
 * writes one small JSON file per click into actions/, and the agent applies
 * them in order at the start of each run, then deletes the files.
 */
export type DashboardAction =
    | { id: string; at: string; type: "approve_batch"; batch_id: number; items: { id: number; approve: boolean; subject?: string; body?: string }[] }
    | { id: string; at: string; type: "whatsapp_done"; outreach_id: number }
    | { id: string; at: string; type: "skip"; outreach_id: number }
    | { id: string; at: string; type: "do_not_contact"; lead_id: number };

const MAX_SUBJECT = 200;
const MAX_BODY = 5000;

/** Returns a short description of what was done, or throws if the action is invalid. */
export function applyAction(store: LeadStore, cfg: OutreachConfig, a: DashboardAction): string {
    const o = store.outreach;
    const now = new Date().toISOString();
    switch (a.type) {
        case "approve_batch": {
            const rows = new Map(o.list("batch_id = ? AND channel = 'email'", a.batch_id).map((r) => [r.id, r]));
            if (!rows.size) throw new Error(`batch ${a.batch_id} has no emails`);
            let approved = 0;
            for (const item of a.items) {
                const row = rows.get(item.id);
                if (!row || row.status !== "draft") continue; // already handled, or not in this batch
                if (!item.approve) {
                    o.update(row.id, { status: "skipped", error: "not approved" });
                    continue;
                }
                const subject = (item.subject ?? row.subject ?? "").trim().slice(0, MAX_SUBJECT);
                let body = (item.body ?? row.body).replace(/\r\n/g, "\n").trim().slice(0, MAX_BODY);
                // Whatever the edit, every email keeps its opt-out line.
                if (!body.includes(cfg.email.opt_out)) body = `${body}\n\n${cfg.email.opt_out}`;
                o.update(row.id, { status: "approved", approved_at: now, subject, body });
                approved++;
            }
            // Drafts left out of the action stay as drafts in an approved batch: treat them as not approved.
            for (const row of rows.values()) if (o.get(row.id)?.status === "draft") o.update(row.id, { status: "skipped", error: "not approved" });
            o.setBatchStatus(a.batch_id, "approved");
            o.settleBatches();
            return `batch ${a.batch_id}: ${approved} email(s) approved`;
        }
        case "whatsapp_done": {
            const row = o.get(a.outreach_id);
            if (!row || row.channel === "email") throw new Error(`outreach ${a.outreach_id} is not a WhatsApp/phone message`);
            if (row.status === "draft") o.update(row.id, { status: "sent", sent_at: a.at || now });
            return `message ${a.outreach_id} marked sent`;
        }
        case "skip": {
            const row = o.get(a.outreach_id);
            if (!row) throw new Error(`outreach ${a.outreach_id} not found`);
            if (row.status === "draft" || row.status === "approved") o.update(row.id, { status: "skipped", error: "skipped in dashboard" });
            return `message ${a.outreach_id} skipped`;
        }
        case "do_not_contact": {
            const lead = store.allLeadsWithAudits().find((x) => x.lead.id === a.lead_id)?.lead;
            if (!lead) throw new Error(`lead ${a.lead_id} not found`);
            if (lead.phone) o.suppress(lead.phone, "manual");
            for (const row of o.forLead(lead.id)) {
                if (row.recipient) o.suppress(row.recipient, "manual");
                if (row.status === "draft" || row.status === "approved") o.update(row.id, { status: "skipped", error: "do not contact" });
            }
            return `lead ${a.lead_id} added to do-not-contact`;
        }
        default:
            throw new Error(`unknown action type ${(a as { type?: string }).type}`);
    }
}

/** Apply every action file in dir (oldest first) and delete it. */
export function ingestActions(store: LeadStore, cfg: OutreachConfig, dir: string): { applied: number; failed: number } {
    const res = { applied: 0, failed: 0 };
    if (!existsSync(dir)) return res;
    const files = readdirSync(dir).filter((f) => f.endsWith(".json"));
    const actions: { file: string; action: DashboardAction }[] = [];
    for (const f of files) {
        const file = join(dir, f);
        try {
            actions.push({ file, action: JSON.parse(readFileSync(file, "utf8")) as DashboardAction });
        } catch (err) {
            log.warn(`actions: ${f} is not valid JSON (${errMessage(err)}); removed`);
            unlinkSync(file);
            res.failed++;
        }
    }
    actions.sort((a, b) => String(a.action.at).localeCompare(String(b.action.at)));
    for (const { file, action } of actions) {
        try {
            if (!action || typeof action !== "object" || Array.isArray(action) || typeof action.id !== "string") throw new Error("not an action");
            if (store.outreach.actionProcessed(action.id)) {
                unlinkSync(file);
                continue;
            }
            log.info(`actions: ${applyAction(store, cfg, action)}`);
            store.outreach.markActionProcessed(action.id);
            res.applied++;
        } catch (err) {
            const what = `${(action as { type?: string })?.type ?? "?"} ${(action as { id?: string })?.id ?? file}`;
            log.warn(`actions: ${what} rejected: ${errMessage(err)}`);
            store.logFailure(null, "action", `${what}: ${errMessage(err)}`);
            res.failed++;
        }
        unlinkSync(file);
    }
    return res;
}
