import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RegionConfig } from "../config.js";
import type { LeadStore } from "../db.js";
import { csvCell } from "../export.js";
import { log } from "../log.js";
import { compareLeads } from "../scoring.js";
import { parseWebsite } from "../url.js";
import { isFreeProvider, isOwnDomain } from "./classify.js";
import { emailAllowed } from "./index.js";

const EMAIL_COLUMNS = [
    "name", "email", "email_type", "verification_status", "evidence", "lead_score", "country",
    "risk_flag", "email_source", "website", "timezone", "send_window", "legal_basis",
] as const;

const FALLBACK_COLUMNS = [
    "name", "channel", "contact", "channel_note", "phone", "reason", "lead_score", "country",
    "website", "evidence", "timezone", "send_window",
] as const;

function writeCsv(path: string, columns: readonly string[], rows: Record<string, unknown>[]) {
    const lines = [columns.join(","), ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(","))];
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, `${lines.join("\r\n")}\r\n`, "utf8");
    renameSync(tmp, path);
}

/**
 * Write email_queue.csv and fallback_queue.csv from stored contact results.
 * The region rule is re-checked here, so turning allowed_to_email off takes
 * effect immediately: those leads move to the fallback queue. Leads from a
 * different region than the loaded config are left out (their rule is unknown).
 */
export function exportQueues(store: LeadStore, config: RegionConfig, paths: { email: string; fallback: string }) {
    const window = `${config.send_window.days} ${config.send_window.start}-${config.send_window.end} ${config.timezone}`;
    const emailRows: Record<string, unknown>[] = [];
    const fallbackRows: Record<string, unknown>[] = [];
    let otherRegion = 0;
    let notOwned = 0;
    let belowScore = 0;

    const results = store
        .contactResults()
        .filter(({ result }) => result.outcome !== "failed")
        .sort((a, b) => compareLeads(a.lead, b.lead));

    for (const { lead, result } of results) {
        const country = lead.country ?? config.country_code;
        if (country !== config.country_code) {
            otherRegion++;
            continue;
        }
        // Stage 3 only applies to owned sites at or above the threshold (reconcile cleans the DB;
        // this guards the CSVs in case it hasn't run since the rules or scores changed).
        if (lead.website_class !== "owned_site") {
            notOwned++;
            continue;
        }
        if ((lead.lead_score ?? -1) < config.contact_min_score) {
            belowScore++;
            continue;
        }
        if (result.outcome === "email" && result.email) {
            const domain = result.email.split("@")[1]!;
            const site = parseWebsite(lead.website_url);
            if (!isFreeProvider(domain) && !(site && isOwnDomain(domain, site.hostname))) {
                notOwned++;
                continue;
            }
        }
        const common = { name: lead.name, lead_score: lead.lead_score, country, website: lead.website_url, timezone: config.timezone, send_window: window };
        if (result.outcome === "email" && emailAllowed(config)) {
            emailRows.push({
                ...common,
                email: result.email,
                email_type: result.email_type,
                verification_status: result.verification_status,
                evidence: `${result.contact_evidence} | site: ${lead.evidence ?? ""}`,
                risk_flag: result.risk_flag,
                email_source: result.email_source,
                legal_basis: config.legal_basis,
            });
        } else {
            fallbackRows.push({
                ...common,
                channel: result.channel,
                contact: result.channel_value,
                channel_note: result.channel_note,
                phone: lead.phone,
                reason: result.outcome === "email" ? `email not permitted for region ${country} (allowed_to_email is not true)` : result.reason,
                evidence: `${result.contact_evidence ?? ""} | site: ${lead.evidence ?? ""}`,
            });
        }
    }
    writeCsv(paths.email, EMAIL_COLUMNS, emailRows);
    writeCsv(paths.fallback, FALLBACK_COLUMNS, fallbackRows);
    if (otherRegion) log.warn(`queues: ${otherRegion} lead(s) from other regions left out; export with their region config`);
    if (notOwned) log.warn(`queues: ${notOwned} stage-3 result(s) left out: not an owned site or email at another domain. Run: npm run cli -- reconcile`);
    if (belowScore) log.info(`queues: ${belowScore} lead(s) now score below contact_min_score (${config.contact_min_score}) and were left out`);
    return { email: emailRows.length, fallback: fallbackRows.length };
}
