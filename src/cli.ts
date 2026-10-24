import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { runAudit, type AuditOptions } from "./audit/index.js";
import { loadConfigFile, resolveConfig, type ConfigOverrides } from "./config.js";
import { LeadStore } from "./db.js";
import { runDiscovery, SOURCES } from "./discovery/index.js";
import { exportCsv } from "./export.js";
import { errMessage, log, setLogLevel } from "./log.js";

const HELP = `lead-scout - find brands that need an ecommerce site, and audit them

Usage: npm run cli -- <command> [flags]

Commands:
  discover    Stage 1: query discovery sources and store leads (deduped)
  audit       Stage 2: audit leads that have a website (mobile, Playwright + Lighthouse)
  export      Write the CSV sorted by lead_score
  run         discover + audit + export
  failures    Show recent per-lead failures
  stats       Show row counts

Region (override config/region.json):
  --country <code>            ISO country code, e.g. NG
  --city <name>
  --radius-km <n>
  --language <code>           e.g. en
  --currency <code>           e.g. NGN
  --keywords <a,b,c>          product categories to search
  --payment-providers <a,b>   names or domains to detect
  --sources <a,b>             discovery sources (${Object.keys(SOURCES).join(", ")})
  --lat <n> --lng <n>         search centre (default: geocode the city)

General:
  --config <path>             default: config/region.json
  --db <path>                 default: data/leads.db
  --out <path>                default: output/leads.csv
  --screenshots <dir>         default: output/screenshots

Audit:
  --reaudit                   re-audit leads already audited (default: only new or failed)
  --limit <n>                 audit at most n leads
  --ids <1,2,3>               audit only these lead ids
  --no-lighthouse             skip Lighthouse (much faster)
  --timeout-ms <n>            page load timeout (default 30000)
  --delay-ms <n>              min gap between requests to one host (default 3000)
  --user-agent <token>        robots.txt product token (default LeadScout)
  --csv-every <n>             rewrite the CSV every n audited sites (default 5, 0 = only at the end)

  --verbose                   debug logging
`;

async function main() {
    const { values, positionals } = parseArgs({
        allowPositionals: true,
        options: {
            help: { type: "boolean", short: "h" },
            config: { type: "string", default: "config/region.json" },
            db: { type: "string", default: "data/leads.db" },
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
            verbose: { type: "boolean", default: false },
        },
    });

    const command = positionals[0];
    if (values.help || !command) {
        process.stdout.write(HELP);
        return;
    }
    if (values.verbose) setLogLevel("debug");

    const store = new LeadStore(resolve(values.db));
    try {
        const needsConfig = ["discover", "audit", "run"].includes(command);
        const overrides: ConfigOverrides = {
            country: values.country,
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
            limit: values.limit ? Number(values.limit) : undefined,
            ids: values.ids ? values.ids.split(",").map(Number).filter(Number.isInteger) : undefined,
            lighthouse: !values["no-lighthouse"],
            timeoutMs: Number(values["timeout-ms"]),
            perHostDelayMs: Number(values["delay-ms"]),
            screenshotsDir: values.screenshots,
            userAgentToken: values["user-agent"],
        };

        const out = resolve(values.out);
        // Keep the CSV current while long stages run. A failed write (e.g. the
        // file is locked by a spreadsheet app) is logged and retried next time.
        const writeCsv = (why: string) => {
            try {
                const n = exportCsv(store, out);
                log.info(`csv: wrote ${n} lead(s) to ${values.out} (${why})`);
            } catch (err) {
                log.warn(`csv: could not write ${values.out}: ${errMessage(err)}`);
            }
        };
        const csvEvery = Math.max(0, Number(values["csv-every"]) || 0);
        const onLeadDone = (done: number, total: number) => {
            if (csvEvery && done % csvEvery === 0 && done < total) writeCsv(`${done}/${total} audited`);
        };
        // Ctrl+C: everything audited so far is already saved, so write the CSV and stop.
        if (["discover", "audit", "run"].includes(command)) {
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
            case "export": {
                const n = exportCsv(store, out);
                log.info(`export: wrote ${n} lead(s) to ${values.out}`);
                break;
            }
            case "run": {
                const d = await runDiscovery(store, config!);
                log.info(`discover: ${d.seen} results, ${d.inserted} new, ${d.merged} merged, ${d.failures} failure(s)`);
                writeCsv("discovery done");
                const a = await runAudit(store, config!, auditOpts, onLeadDone);
                log.info(`audit: ${a.attempted} attempted ${JSON.stringify(a.byStatus)}`);
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
