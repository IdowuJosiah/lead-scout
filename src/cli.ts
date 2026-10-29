import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { runAudit, type AuditOptions } from "./audit/index.js";
import { loadConfigFile, resolveConfig, type ConfigOverrides } from "./config.js";
import { exportQueues } from "./contact/export.js";
import { runContacts, type ContactOptions, type PaidPlan } from "./contact/index.js";
import { formatReconcileReport, reconcileContacts } from "./contact/reconcile.js";
import { LeadStore } from "./db.js";
import { runDiscovery, SOURCES } from "./discovery/index.js";
import { exportCsv } from "./export.js";
import { errMessage, log, setLogLevel } from "./log.js";
import { runTick, runWeekly } from "./agent/index.js";
import { buildSnapshot, writeSnapshot } from "./agent/snapshot.js";
import { loadOutreachConfig } from "./outreach/config.js";
import { runDraft } from "./outreach/draft.js";
import { applyInbound, fetchInbox, imapSettingsFromEnv } from "./outreach/inbox.js";
import { mailSettingsFromEnv, runSend, smtpTransport } from "./outreach/send.js";

const HELP = `lead-scout - find brands that need an ecommerce site, and audit them

Usage: npm run cli -- <command> [flags]

Commands:
  discover    Stage 1: query discovery sources and store leads (deduped)
  audit       Stage 2: audit leads that have a website (mobile, Playwright + Lighthouse)
  contacts    Stage 3: find and verify emails for high-scoring leads with their own site
  reconcile   Re-score, drop stage-3 results that break the current rules, report, rewrite CSVs
  export      Write leads.csv, email_queue.csv and fallback_queue.csv
  run         discover + audit + contacts + export
  draft       Write email drafts (a batch for your approval) and WhatsApp/phone messages
  send        Send approved emails now (inside the send window, within daily limits)
  inbox       Read replies, "stop" requests and bounces from the mailbox
  snapshot    Write dashboard.json
  agent weekly   Unattended: actions, inbox, discover, audit, contacts (within budget), draft
  agent tick     Unattended: actions, inbox, send approved emails
  failures    Show recent per-lead failures
  stats       Show row counts

Region (override config/region.json):
  --country <name>            e.g. Nigeria
  --country-code <code>       ISO code, e.g. NG
  --city <name>
  --radius-km <n>
  --language <code>           e.g. en
  --currency <code>           e.g. NGN
  --keywords <a,b,c>          product categories to search
  --payment-providers <a,b>   names or domains to detect
  --sources <a,b>             discovery sources (${Object.keys(SOURCES).join(", ")})
  --lat <n> --lng <n>         search centre (default: geocode the city)

Keys: GOOGLE_PLACES_API_KEY, HUNTER_API_KEY, ZEROBOUNCE_API_KEY, from the shell or a .env
file in this folder (copy .env.example to .env). Shell values win over the file.

General:
  --config <path>             default: config/region.json
  --db <path>                 default: data/leads.db
  --out <path>                default: output/leads.csv
  --screenshots <dir>         default: output/screenshots

Audit:
  --reaudit                   re-audit leads already audited (default: only new, failed, or unreachable once)
  --upgrade                   also re-audit leads audited by an older version of the checks
  --limit <n>                 audit at most n leads
  --ids <1,2,3>               audit only these lead ids
  --no-lighthouse             skip Lighthouse (much faster)
  --timeout-ms <n>            page load timeout (default 30000)
  --delay-ms <n>              min gap between requests to one host (default 3000)
  --user-agent <token>        robots.txt product token (default LeadScout)
  --csv-every <n>             rewrite the CSV every n audited sites (default 5, 0 = only at the end)

Contacts (needs HUNTER_API_KEY and ZEROBOUNCE_API_KEY):
  --min-score <n>             only leads scoring at least n (default: contact_min_score, 60)
  --recontact                 redo leads already processed
  --max-verify <n>            most addresses verified per lead (default 3; each costs a credit)
  --dry-run                   show how many paid calls would be made, then stop
  --yes                       make the paid calls without asking

Agent / outreach:
  --state <dir>               keep leads.db, dashboard.json, actions/ and output/ in this folder
  --outreach <path>           default: config/outreach.json
  --lighthouse                run Lighthouse in agent audits (off by default: slow)
  --no-discover               agent weekly: skip discovery (no Google calls)

  --verbose                   debug logging
`;

/** Ask before spending API credits. --yes skips the question; no terminal means no. */
async function confirmPaidCalls(plan: PaidPlan, yes: boolean): Promise<boolean> {
    const total = plan.hunterCalls + plan.zeroBounceCalls;
    const upTo = plan.zeroBounceUpTo ? ` (+ up to ${plan.zeroBounceUpTo} ZeroBounce for addresses Hunter returns)` : "";
    const summary = `About to make ${total} paid call(s): ${plan.hunterCalls} Hunter, ${plan.zeroBounceCalls} ZeroBounce${upTo}, for ${plan.leads} lead(s).`;
    if (yes) {
        process.stderr.write(`${summary} Approved by --yes.\n`);
        return true;
    }
    if (!process.stdin.isTTY) {
        process.stderr.write(`${summary} Not approved: re-run with --yes to allow, or --dry-run to only preview.\n`);
        return false;
    }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
        const answer = await rl.question(`${summary} Continue? [y/N] `);
        return /^y(es)?$/i.test(answer.trim());
    } finally {
        rl.close();
    }
}

/**
 * API keys from a local .env file, so they needn't be typed each session.
 * Variables already set in the shell win over the file.
 */
function loadEnv() {
    const path = resolve(".env");
    if (!existsSync(path)) return;
    try {
        process.loadEnvFile(path);
    } catch (err) {
        log.warn(`could not read ${path}: ${errMessage(err)}`);
    }
}

async function main() {
    loadEnv();
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            help: { type: "boolean", short: "h" },
            config: { type: "string", default: "config/region.json" },
            db: { type: "string" },
            state: { type: "string" },
            outreach: { type: "string", default: "config/outreach.json" },
            lighthouse: { type: "boolean", default: false },
            "no-discover": { type: "boolean", default: false },
            out: { type: "string", default: "output/leads.csv" },
            screenshots: { type: "string", default: "output/screenshots" },
            country: { type: "string" },
            city: { type: "string" },
            "radius-km": { type: "string" },
            language: { type: "string" },
            currency: { type: "string" },
            keywords: { type: "string" },
            "payment-providers": { type: "string" },
            sources: { type: "string" },
            lat: { type: "string" },
            lng: { type: "string" },
            reaudit: { type: "boolean", default: false },
            limit: { type: "string" },
            ids: { type: "string" },
            "no-lighthouse": { type: "boolean", default: false },
            "timeout-ms": { type: "string", default: "30000" },
            "delay-ms": { type: "string", default: "3000" },
            "user-agent": { type: "string", default: "LeadScout" },
            "csv-every": { type: "string", default: "5" },
            "country-code": { type: "string" },
            "min-score": { type: "string" },
            recontact: { type: "boolean", default: false },
            "max-verify": { type: "string", default: "3" },
            upgrade: { type: "boolean", default: false },
            "dry-run": { type: "boolean", default: false },
            yes: { type: "boolean", default: false },
            verbose: { type: "boolean", default: false },
        },
    });

    const command = positionals[0];
    if (values.help || !command) {
        process.stdout.write(HELP);
        return;
    }
    if (values.verbose) setLogLevel("debug");

    const stateDir = values.state ? resolve(values.state) : null;
    const store = new LeadStore(resolve(values.db ?? (stateDir ? join(stateDir, "leads.db") : "data/leads.db")));
    try {
        const needsConfig = ["discover", "audit", "contacts", "reconcile", "export", "run", "draft", "send", "snapshot", "agent"].includes(command);
        const overrides: ConfigOverrides = {
            country: values.country,
            country_code: values["country-code"],
            min_score: values["min-score"],
            city: values.city,
            radius_km: values["radius-km"],
            language: values.language,
            currency: values.currency,
            keywords: values.keywords,
            payment_providers: values["payment-providers"],
            sources: values.sources,
            lat: values.lat,
            lng: values.lng,
        };
        const config = needsConfig ? resolveConfig(loadConfigFile(values.config), overrides) : null;

        const auditOpts: AuditOptions = {
            reaudit: values.reaudit,
            upgrade: values.upgrade,
            limit: values.limit ? Number(values.limit) : undefined,
            ids: values.ids ? values.ids.split(",").map(Number).filter(Number.isInteger) : undefined,
            lighthouse: !values["no-lighthouse"],
            timeoutMs: Number(values["timeout-ms"]),
            perHostDelayMs: Number(values["delay-ms"]),
            screenshotsDir: values.screenshots,
            userAgentToken: values["user-agent"],
        };

        const contactOpts: ContactOptions = {
            minScore: config?.contact_min_score ?? 60,
            recontact: values.recontact,
            limit: auditOpts.limit,
            ids: auditOpts.ids,
            maxVerify: Math.max(1, Number(values["max-verify"]) || 3),
            perHostDelayMs: auditOpts.perHostDelayMs,
            userAgentToken: auditOpts.userAgentToken,
            timeoutMs: Math.min(auditOpts.timeoutMs, 20_000),
            dryRun: values["dry-run"],
            confirm: (plan) => confirmPaidCalls(plan, values.yes),
        };

        const out = resolve(values.out);
        const queues = { email: join(dirname(out), "email_queue.csv"), fallback: join(dirname(out), "fallback_queue.csv") };
        // Keep the CSVs current while long stages run. A failed write (e.g. the
        // file is locked by a spreadsheet app) is logged and retried next time.
        const writeCsv = (why: string) => {
            try {
                const n = exportCsv(store, out);
                const q = config ? exportQueues(store, config, queues) : null;
                log.info(`csv: wrote ${n} lead(s) to ${values.out}${q ? `, ${q.email} to email_queue.csv, ${q.fallback} to fallback_queue.csv (${q.noWebsite} with no website)` : ""} (${why})`);
            } catch (err) {
                log.warn(`csv: could not write CSVs: ${errMessage(err)}`);
            }
        };
        const csvEvery = Math.max(0, Number(values["csv-every"]) || 0);
        const onLeadDone = (done: number, total: number) => {
            if (csvEvery && done % csvEvery === 0 && done < total) writeCsv(`${done}/${total} audited`);
        };
        // Ctrl+C: everything audited so far is already saved, so write the CSV and stop.
        if (["discover", "audit", "contacts", "run"].includes(command)) {
            process.once("SIGINT", () => {
                log.warn("interrupted; writing CSV with progress so far");
                writeCsv("interrupted");
                store.close();
                process.exit(130);
            });
        }

        switch (command) {
            case "discover": {
                const s = await runDiscovery(store, config!);
                log.info(`discover: ${s.seen} results, ${s.inserted} new, ${s.merged} merged into existing, ${s.failures} failure(s)`);
                writeCsv("discovery done");
                break;
            }
            case "audit": {
                const s = await runAudit(store, config!, auditOpts, onLeadDone);
                log.info(`audit: ${s.attempted} attempted ${JSON.stringify(s.byStatus)}`);
                writeCsv("audit done");
                break;
            }
            case "contacts": {
                const c = await runContacts(store, config!, contactOpts);
                log.info(`contacts: ${c.processed} processed: ${c.email} email, ${c.fallback} fallback, ${c.failed} failed, ${c.skipped} skipped, ${c.deferred} waiting for paid-call approval`);
                writeCsv("contacts done");
                break;
            }
            case "reconcile": {
                const report = reconcileContacts(store);
                process.stdout.write(`${formatReconcileReport(report)}\n`);
                writeCsv("reconciled");
                break;
            }
            case "export":
                writeCsv("export");
                break;
            case "run": {
                const d = await runDiscovery(store, config!);
                log.info(`discover: ${d.seen} results, ${d.inserted} new, ${d.merged} merged, ${d.failures} failure(s)`);
                writeCsv("discovery done");
                const a = await runAudit(store, config!, auditOpts, onLeadDone);
                log.info(`audit: ${a.attempted} attempted ${JSON.stringify(a.byStatus)}`);
                writeCsv("audit done");
                const c = await runContacts(store, config!, contactOpts);
                log.info(`contacts: ${c.processed} processed: ${c.email} email, ${c.fallback} fallback, ${c.failed} failed, ${c.skipped} skipped, ${c.deferred} waiting for paid-call approval`);
                writeCsv("finished");
                break;
            }
            case "failures": {
                for (const f of store.recentFailures(values.limit ? Number(values.limit) : 50)) {
                    process.stdout.write(`${f.occurred_at}  ${f.stage.padEnd(8)} ${f.lead_id ? `#${f.lead_id} ${f.name}: ` : ""}${f.message}\n`);
                }
                break;
            }
            case "stats":
                process.stdout.write(`${JSON.stringify(store.counts(), null, 2)}\n`);
                break;
            case "draft": {
                runDraft(store, config!, loadOutreachConfig(values.outreach));
                writeCsv("drafted");
                break;
            }
            case "send": {
                const mail = mailSettingsFromEnv();
                if (!mail) throw new Error("Set SMTP_USER and SMTP_PASS (in .env) to send email");
                const transport = smtpTransport(mail);
                try {
                    await runSend(store, config!, loadOutreachConfig(values.outreach), { transport, from: mail.from });
                } finally {
                    transport.close();
                }
                break;
            }
            case "inbox": {
                const imap = imapSettingsFromEnv();
                if (!imap) throw new Error("Set SMTP_USER/SMTP_PASS (or IMAP_USER/IMAP_PASS) in .env to read the mailbox");
                const c = applyInbound(store, await fetchInbox(store, imap));
                log.info(`inbox: ${JSON.stringify(c)}`);
                break;
            }
            case "snapshot": {
                const path = join(stateDir ?? dirname(out), "dashboard.json");
                writeSnapshot(path, buildSnapshot(store, config!, loadOutreachConfig(values.outreach)));
                log.info(`snapshot: wrote ${path}`);
                break;
            }
            case "agent": {
                const which = positionals[1];
                if (which !== "weekly" && which !== "tick") throw new Error('Use "agent weekly" or "agent tick"');
                const agentOpts = {
                    stateDir: stateDir ?? resolve("."),
                    audit: { ...auditOpts, lighthouse: values.lighthouse, screenshotsDir: join(stateDir ?? ".", "output", "screenshots") },
                    contacts: contactOpts,
                    discover: !values["no-discover"],
                };
                const run = which === "weekly" ? runWeekly : runTick;
                const steps = await run(store, config!, loadOutreachConfig(values.outreach), agentOpts);
                if (steps.every((s) => !s.ok)) process.exitCode = 1;
                break;
            }
            default:
                throw new Error(`Unknown command "${command}". Run with --help.`);
        }
    } finally {
        store.close();
    }
}

main().catch((err) => {
    log.error(errMessage(err));
    process.exitCode = 1;
});
