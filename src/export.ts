import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditRow, LeadRow, LeadStore } from "./db.js";
import { buildEvidence } from "./evidence.js";
import { priorityOf, scoreLead } from "./scoring.js";

/** Recompute score + evidence for every lead from what is stored. Idempotent. */
export function rescoreAll(store: LeadStore) {
    for (const { lead, audit } of store.allLeadsWithAudits()) {
        const { score, breakdown } = scoreLead(lead, audit);
        store.saveScore(lead.id, score, breakdown, buildEvidence(lead, audit));
    }
}

const COLUMNS = [
    "lead_score",
    "priority",
    "name",
    "category",
    "address",
    "phone",
    "website_url",
    "source",
    "audit_status",
    "load_time_ms",
    "lighthouse_mobile_performance",
    "platform",
    "has_cart",
    "has_checkout",
    "payment_providers",
    "link_in_bio_only",
    "whatsapp_order_only",
    "ssl",
    "local_currency_on_homepage",
    "screenshot_path",
    "evidence",
    "score_breakdown",
    "discovered_at",
    "audited_at",
] as const;

const bool = (v: number | null | undefined) => (v == null ? "" : v ? "yes" : "no");

export function csvCell(v: unknown): string {
    if (v == null) return "";
    let s = String(v);
    // Neutralise spreadsheet formulas; leave phone numbers like +234... alone.
    if (/^[=@\t\r]/.test(s) || /^[+-][^\d\s(]/.test(s)) s = `'${s}`;
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function row(lead: LeadRow, audit: AuditRow | null): Record<(typeof COLUMNS)[number], unknown> {
    const providers = audit?.payment_providers ? (JSON.parse(audit.payment_providers) as { name: string }[]).map((p) => p.name).join(" | ") : "";
    return {
        lead_score: lead.lead_score,
        priority: priorityOf(lead.lead_score),
        name: lead.name,
        category: lead.category,
        address: lead.address,
        phone: lead.phone,
        website_url: lead.website_url,
        source: lead.source,
        audit_status: lead.website_url ? (audit?.status ?? "pending") : "no_website",
        load_time_ms: audit?.load_time_ms,
        lighthouse_mobile_performance: audit?.lighthouse_score,
        platform: audit?.platform,
        has_cart: bool(audit?.has_cart),
        has_checkout: bool(audit?.has_checkout),
        payment_providers: providers,
        link_in_bio_only: bool(audit?.link_in_bio_only),
        whatsapp_order_only: bool(audit?.whatsapp_order_only),
        ssl: audit?.ssl,
        local_currency_on_homepage: bool(audit?.local_currency_seen),
        screenshot_path: audit?.screenshot_path,
        evidence: lead.evidence,
        score_breakdown: lead.score_breakdown,
        discovered_at: lead.discovered_at,
        audited_at: audit?.audited_at,
    };
}

/** Write leads.csv sorted by lead_score (desc, unscored last). Overwrites the file. */
export function exportCsv(store: LeadStore, path: string): number {
    rescoreAll(store);
    const rows = store
        .allLeadsWithAudits()
        .sort((a, b) => (b.lead.lead_score ?? -1) - (a.lead.lead_score ?? -1) || a.lead.name.localeCompare(b.lead.name));
    const lines = [COLUMNS.join(",")];
    for (const { lead, audit } of rows) {
        const r = row(lead, audit);
        lines.push(COLUMNS.map((c) => csvCell(r[c])).join(","));
    }
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${lines.join("\r\n")}\r\n`, "utf8");
    return rows.length;
}
