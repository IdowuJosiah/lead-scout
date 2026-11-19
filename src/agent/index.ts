import { join } from "node:path";
import { runAudit, type AuditOptions } from "../audit/index.js";
import type { RegionConfig } from "../config.js";
import { exportQueues } from "../contact/export.js";
import { verifierName } from "../contact/apis.js";
import { runContacts, type ContactOptions } from "../contact/index.js";
import { reconcileContacts } from "../contact/reconcile.js";
import { ensureRegion, RegionSet } from "../regions.js";
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

/** Every active region (config/region.json's city is region #1). */
export function loadRegions(store: LeadStore, base: RegionConfig): RegionSet {
    store.regions.ensureDefault(base);
    return new RegionSet(base, store.regions.list().filter((r) => r.active));
}

const finish = (store: LeadStore, set: RegionSet, cfg: OutreachConfig, opts: AgentOptions, key: string, results: StepResult[], started: string, extra: Record<string, unknown> = {}) => {
    store.outreach.setState(key, JSON.stringify({ started_at: started, finished_at: new Date().toISOString(), steps: results, ...extra }));
    const out = join(opts.stateDir, "output");
    try {
        exportCsv(store, join(out, "leads.csv"));
        exportQueues(store, set, { email: join(out, "email_queue.csv"), fallback: join(out, "fallback_queue.csv") });
    } catch (err) {
        log.warn(`agent: could not write CSVs: ${errMessage(err)}`);
    }
    writeSnapshot(join(opts.stateDir, "dashboard.json"), buildSnapshot(store, set, cfg));
    log.info(`agent: ${key} done: ${results.map((r) => `${r.step} ${r.ok ? "ok" : "FAILED"}`).join(", ")}`);
    return results;
};

/** Paid-call budget left this month. Hunter verifications share the Hunter pool. */
function budgetLeft(store: LeadStore, cfg: OutreachConfig) {
    const o = store.outreach;
    const hunter = Math.max(0, cfg.limits.hunter_calls_per_month - o.usage("hunter"));
    return { hunter, verify: verifierName() === "hunter" ? hunter : Math.max(0, cfg.limits.zerobounce_calls_per_month - o.usage("zerobounce")) };
}

/** Discover, audit and find contacts for one region. */
async function regionSteps(results: StepResult[], store: LeadStore, set: RegionSet, regionId: number, cfg: OutreachConfig, opts: AgentOptions, discover: boolean) {
    const region = set.config(regionId)!;
    const label = set.label(regionId) ?? region.city;
    if (discover) {
        await step(results, store, `discover ${label}`, async () => {
            const d = await runDiscovery(store, region, regionId);
            store.regions.markScouted(regionId);
            return `${d.seen} found, ${d.inserted} new, ${d.failures} failure(s)`;
        });
    }
    await step(results, store, `audit ${label}`, async () => {
        const a = await runAudit(store, region, { ...opts.audit, upgrade: true, regionId });
        return `${a.attempted} audited ${JSON.stringify(a.byStatus)}`;
    });
    await step(results, store, `contacts ${label}`, async () => {
        // Unattended: the monthly budget is the approval.
        const c = await runContacts(store, region, { ...opts.contacts, regionId, budget: budgetLeft(store, cfg), confirm: async () => true });
        return `${c.processed} processed: ${c.email} email, ${c.fallback} fallback, ${c.deferred} waiting for credits${region.allowed_to_email === true ? "" : " (email is off for this region)"}`;
    });
}

const reconcileStep = (results: StepResult[], store: LeadStore) =>
    step(results, store, "reconcile", () => {
        const r = reconcileContacts(store);
        const removed = Object.values(r.notOwnedSite).reduce((s, x) => s + x.results, 0) + r.domainMismatch.length;
        return `${removed} stage-3 result(s) invalidated, ${r.unverifiedRetried} unverified retried, ${r.freeProviderFlagged.length} flagged`;
    });

export async function runWeekly(store: LeadStore, base: RegionConfig, cfg: OutreachConfig, opts: AgentOptions): Promise<StepResult[]> {
    const started = new Date().toISOString();
    const results: StepResult[] = [];
    await commonStart(results, store, cfg, opts);
    const set = loadRegions(store, base); // after actions, so region switches apply
    await reconcileStep(results, store);
    for (const r of set.rows) await regionSteps(results, store, set, r.id, cfg, opts, opts.discover);
    await step(results, store, "draft", () => {
        const d = runDraft(store, set, cfg);
        return `${d.emailDrafts} email(s)${d.batchId && d.emailDrafts ? ` in batch #${d.batchId}` : ""}, ${d.whatsappDrafts} WhatsApp, ${d.phoneDrafts} phone${d.withdrawn ? `, ${d.withdrawn} outdated draft(s) withdrawn` : ""}`;
    });
    return finish(store, set, cfg, opts, "last_weekly", results, started);
}

/** Scout one place by name: work out the region, then find, audit and draft for it. */
export async function runScout(
    store: LeadStore,
    base: RegionConfig,
    cfg: OutreachConfig,
    opts: AgentOptions,
    place: string,
    keywords: string[] | null,
    resolve?: Parameters<typeof ensureRegion>[2]["resolve"],
): Promise<StepResult[]> {
    const started = new Date().toISOString();
    const results: StepResult[] = [];
    await commonStart(results, store, cfg, opts);
    let regionId: number | null = null;
    await step(results, store, "region", async () => {
        const apiKey = process.env.GOOGLE_PLACES_API_KEY;
        if (!apiKey && !resolve) throw new Error("GOOGLE_PLACES_API_KEY is not set");
        store.regions.ensureDefault(base);
        const { region, created } = await ensureRegion(store.regions, place, { apiKey: apiKey ?? "", language: base.language, keywords: keywords ?? undefined, resolve, refresh: true });
        regionId = region.id;
        return `${created ? "new" : "existing"} region: ${region.city}, ${region.country} (${region.country_code}), ${region.radius_km} km, ${region.timezone}, ${region.currency}, email ${region.allowed_to_email === 1 ? "on" : "off"}`;
    });
    const set = loadRegions(store, base);
    if (regionId != null) {
        await reconcileStep(results, store);
        await regionSteps(results, store, set, regionId, cfg, opts, true);
        await step(results, store, "draft", () => {
            const d = runDraft(store, set, cfg, regionId);
            return `${d.emailDrafts} email(s)${d.batchId && d.emailDrafts ? ` in batch #${d.batchId}` : ""}, ${d.whatsappDrafts} WhatsApp, ${d.phoneDrafts} phone${d.withdrawn ? `, ${d.withdrawn} outdated draft(s) withdrawn` : ""}`;
        });
    }
    return finish(store, set, cfg, opts, "last_scout", results, started, { place, region_id: regionId });
}

export async function runTick(store: LeadStore, base: RegionConfig, cfg: OutreachConfig, opts: AgentOptions): Promise<StepResult[]> {
    const started = new Date().toISOString();
    const results: StepResult[] = [];
    await commonStart(results, store, cfg, opts);
    const set = loadRegions(store, base);
    await step(results, store, "send", async () => {
        const mail = mailSettingsFromEnv();
        if (!mail) return "skipped: no SMTP credentials";
        const transport = smtpTransport(mail);
        try {
            const s = await runSend(store, set, cfg, { transport, from: mail.from });
            return `${s.sent} sent, ${s.failed} failed, ${s.skipped} skipped${s.stoppedBecause ? ` (${s.stoppedBecause})` : ""}`;
        } finally {
            transport.close();
        }
    });
    return finish(store, set, cfg, opts, "last_tick", results, started);
}
