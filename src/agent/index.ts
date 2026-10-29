import { join } from "node:path";
import { runAudit, type AuditOptions } from "../audit/index.js";
import type { RegionConfig } from "../config.js";
import { exportQueues } from "../contact/export.js";
import { runContacts, type ContactOptions } from "../contact/index.js";
import type { LeadStore } from "../db.js";
import { runDiscovery } from "../discovery/index.js";
import { exportCsv } from "../export.js";
import { errMessage, log } from "../log.js";
import type { OutreachConfig } from "../outreach/config.js";
import { runDraft } from "../outreach/draft.js";
import { applyInbound, fetchInbox, imapSettingsFromEnv } from "../outreach/inbox.js";
import { mailSettingsFromEnv, runSend, smtpTransport } from "../outreach/send.js";
import { ingestActions } from "./actions.js";
import { buildSnapshot, writeSnapshot } from "./snapshot.js";

/**
 * The unattended agent. Two routines, both safe to re-run:
 *
 *  weekly: apply dashboard actions, read replies, find new leads, audit,
 *          find + verify emails within the monthly API budget, draft messages,
 *          write the dashboard. Sends nothing: emails wait for your approval.
 *  tick:   apply dashboard actions (e.g. your approval), read replies, send
 *          approved emails inside the send window, write the dashboard.
 *
 * Every step is isolated: a failure is recorded and the run carries on.
 */

export interface AgentOptions {
    stateDir: string;
    audit: AuditOptions;
    contacts: Omit<ContactOptions, "confirm" | "budget" | "dryRun">;
    discover: boolean;
}

type StepResult = { step: string; ok: boolean; detail: string };

async function step(results: StepResult[], store: LeadStore, name: string, fn: () => Promise<string> | string) {
    try {
        const detail = await fn();
        results.push({ step: name, ok: true, detail });
    } catch (err) {
        log.error(`agent: ${name} failed: ${errMessage(err)}`);
        store.logFailure(null, `agent:${name}`, errMessage(err));
        results.push({ step: name, ok: false, detail: errMessage(err) });
    }
}

const commonStart = async (results: StepResult[], store: LeadStore, cfg: OutreachConfig, opts: AgentOptions) => {
    await step(results, store, "actions", () => {
        const r = ingestActions(store, cfg, join(opts.stateDir, "actions"));
        return `${r.applied} applied, ${r.failed} rejected`;
    });
    await step(results, store, "inbox", async () => {
        const imap = imapSettingsFromEnv();
        if (!imap) return "skipped: no mailbox credentials";
        const c = applyInbound(store, await fetchInbox(store, imap));
        return `${c.reply} repl(ies), ${c.opt_out} opt-out(s), ${c.bounce} bounce(s), ${c.auto_reply} auto-repl(ies)`;
    });
};

const finish = (store: LeadStore, region: RegionConfig, cfg: OutreachConfig, opts: AgentOptions, key: string, results: StepResult[], started: string) => {
    store.outreach.setState(key, JSON.stringify({ started_at: started, finished_at: new Date().toISOString(), steps: results }));
    const out = join(opts.stateDir, "output");
    try {
        exportCsv(store, join(out, "leads.csv"));
        exportQueues(store, region, { email: join(out, "email_queue.csv"), fallback: join(out, "fallback_queue.csv") });
    } catch (err) {
        log.warn(`agent: could not write CSVs: ${errMessage(err)}`);
    }
    writeSnapshot(join(opts.stateDir, "dashboard.json"), buildSnapshot(store, region, cfg));
    log.info(`agent: ${key} done: ${results.map((r) => `${r.step} ${r.ok ? "ok" : "FAILED"}`).join(", ")}`);
    return results;
};

export async function runWeekly(store: LeadStore, region: RegionConfig, cfg: OutreachConfig, opts: AgentOptions): Promise<StepResult[]> {
    const started = new Date().toISOString();
    const results: StepResult[] = [];
    await commonStart(results, store, cfg, opts);
    if (opts.discover) {
        await step(results, store, "discover", async () => {
            const d = await runDiscovery(store, region);
            return `${d.seen} found, ${d.inserted} new, ${d.failures} failure(s)`;
        });
    }
    await step(results, store, "audit", async () => {
        const a = await runAudit(store, region, { ...opts.audit, upgrade: true });
        return `${a.attempted} audited ${JSON.stringify(a.byStatus)}`;
    });
    await step(results, store, "contacts", async () => {
        const o = store.outreach;
        const budget = {
            hunter: Math.max(0, cfg.limits.hunter_calls_per_month - o.usage("hunter")),
            zerobounce: Math.max(0, cfg.limits.zerobounce_calls_per_month - o.usage("zerobounce")),
        };
        // Unattended: the monthly budget is the approval.
        const c = await runContacts(store, region, { ...opts.contacts, budget, confirm: async () => true });
        return `${c.processed} processed: ${c.email} email, ${c.fallback} fallback, ${c.deferred} waiting for credits`;
    });
    await step(results, store, "draft", () => {
        const d = runDraft(store, region, cfg);
        return `${d.emailDrafts} email(s)${d.batchId ? ` in batch #${d.batchId}` : ""}, ${d.whatsappDrafts} WhatsApp, ${d.phoneDrafts} phone`;
    });
    return finish(store, region, cfg, opts, "last_weekly", results, started);
}

export async function runTick(store: LeadStore, region: RegionConfig, cfg: OutreachConfig, opts: AgentOptions): Promise<StepResult[]> {
    const started = new Date().toISOString();
    const results: StepResult[] = [];
    await commonStart(results, store, cfg, opts);
    await step(results, store, "send", async () => {
        const mail = mailSettingsFromEnv();
        if (!mail) return "skipped: no SMTP credentials";
        const transport = smtpTransport(mail);
        try {
            const s = await runSend(store, region, cfg, { transport, from: mail.from });
            return `${s.sent} sent, ${s.failed} failed, ${s.skipped} skipped${s.stoppedBecause ? ` (${s.stoppedBecause})` : ""}`;
        } finally {
            transport.close();
        }
    });
    return finish(store, region, cfg, opts, "last_tick", results, started);
}
