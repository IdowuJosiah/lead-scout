import { createHash } from "node:crypto";
import type { RegionConfig } from "../config.js";
import type { AuditRow, LeadRow } from "../db.js";
import { scoreLead } from "../scoring.js";
import { classifyUrl, parseWebsite } from "../url.js";
import type { OutreachConfig, Placeholder } from "./config.js";

/**
 * Turns a lead's stored measurements into a message. Every {placeholder} is
 * filled from a measured value or your own config; a sentence whose values
 * weren't measured is never used.
 */

export type Vars = Partial<Record<Placeholder, string>>;

export interface Issue {
    key: string;
}

/** Fill {placeholders}; null when any is missing, so the caller picks another sentence. */
export function render(template: string, vars: Vars): string | null {
    let ok = true;
    const out = template.replace(/\{([^}]+)\}/g, (_m, name: string) => {
        const v = vars[name as Placeholder];
        // Only "unknown" blocks a sentence; an intentionally empty value (e.g. no business name) is fine.
        if (v === undefined) ok = false;
        return v ?? "";
    });
    return ok ? out : null;
}

/** Stable choice per lead and slot, so re-drafting gives the same text. */
export function seedIndex(seed: string, length: number): number {
    const h = createHash("sha256").update(seed).digest();
    return h.readUInt32BE(0) % length;
}

/** First variant (starting at the seeded one) that renders with the known values. */
export function pick(variants: string[], vars: Vars, seed: string): string | null {
    const start = seedIndex(seed, variants.length);
    for (let i = 0; i < variants.length; i++) {
        const text = render(variants[(start + i) % variants.length]!, vars);
        if (text !== null) return text;
    }
    return null;
}

const DEAD_REASONS: [RegExp, string][] = [
    [/ERR_NAME_NOT_RESOLVED|ENOTFOUND/, "the domain doesn't resolve"],
    [/ERR_CONNECTION_REFUSED|ECONNREFUSED/, "the server refused the connection"],
    [/HTTP 404|HTTP 410/, "the page returns \"not found\""],
    [/parked domain/, "the domain shows a parking / for-sale page"],
];

/** Issues to mention, most important first: the main gap, then the biggest secondary one. */
export function leadIssues(lead: LeadRow, audit: AuditRow | null): string[] {
    const { breakdown } = scoreLead(lead, audit);
    if (!breakdown) return [];
    if (breakdown.startsWith("no_website")) return ["no_website"];
    const keys = breakdown
        .split(";")
        .map((p) => p.trim().split("+")[0]!)
        .filter((k) => k && k !== "baseline");
    // Lighthouse repeats the speed point; only use it when there's no load-time issue.
    const hasLoad = keys.some((k) => /load/.test(k));
    return keys.filter((k) => !(hasLoad && k.startsWith("lighthouse"))).slice(0, 2);
}

export function leadVars(lead: LeadRow, audit: AuditRow | null, region: RegionConfig, cfg: OutreachConfig): Vars {
    const site = parseWebsite(audit?.final_url ?? lead.website_url);
    const listed = parseWebsite(lead.website_url);
    const vars: Vars = {
        brand: lead.name.trim(),
        category: (lead.category ?? "").split(",")[0]?.trim().toLowerCase() || "local",
        city: region.city,
        sender_name: cfg.sender.name,
        sender_role: cfg.sender.role,
        sender_business_suffix: cfg.sender.business ? ` at ${cfg.sender.business}` : "",
    };
    if (site) vars.domain = site.hostname.replace(/^www\./, "");
    if (listed) {
        const cls = classifyUrl(listed);
        vars.host = cls.kind === "hosted_storefront" ? listed.hostname.replace(/^www\./, "") : (cls.host ?? listed.hostname);
    }
    if (audit) {
        if (audit.load_time_ms != null && !audit.load_timed_out) vars.load_seconds = (audit.load_time_ms / 1000).toFixed(1);
        if (audit.lighthouse_score != null && !audit.load_timed_out) vars.lighthouse = String(audit.lighthouse_score);
        const extra = audit.commerce_pages ? (JSON.parse(audit.commerce_pages) as string[]) : [];
        vars.pages_checked = extra.length ? `the homepage and ${extra.join(", ")}` : "the homepage";
        const reason = DEAD_REASONS.find(([re]) => re.test(audit.error ?? ""));
        if (reason) vars.dead_reason = reason[1];
    }
    return vars;
}

export interface Composed {
    subject: string | null;
    body: string;
    issues: string[];
}

function issueSentences(issues: string[], vars: Vars, cfg: OutreachConfig, seed: string): { keys: string[]; lines: string[] } {
    const keys: string[] = [];
    const lines: string[] = [];
    for (const key of issues) {
        const line = pick(cfg.issues[key] ?? [], vars, `${seed}:issue:${key}`);
        if (line) {
            keys.push(key);
            lines.push(line);
        }
    }
    return { keys, lines };
}

/** Plain-text email. Null when no measured issue can be stated. */
export function composeEmail(lead: LeadRow, audit: AuditRow | null, region: RegionConfig, cfg: OutreachConfig): Composed | null {
    const vars = leadVars(lead, audit, region, cfg);
    const seed = `lead:${lead.id}`;
    const { keys, lines } = issueSentences(leadIssues(lead, audit), vars, cfg, seed);
    if (!lines.length) return null;

    const subjectVariants = cfg.email.subjects[keys[0]!] ?? cfg.email.subjects.default!;
    const subject = pick(subjectVariants, vars, `${seed}:subject`) ?? pick(cfg.email.subjects.default!, vars, `${seed}:subject`);
    const p = (list: string[], slot: string) => pick(list, vars, `${seed}:${slot}`);
    const issueBlock = lines.length === 1 ? lines[0]! : `${p(cfg.email.transition, "transition") ?? ""}\n\n${lines.map((l) => `- ${l}`).join("\n")}`;
    const signature = [cfg.sender.name, cfg.sender.business, cfg.sender.website, cfg.sender.phone].filter(Boolean).join("\n");

    const body = [
        p(cfg.email.greeting, "greeting"),
        p(cfg.email.intro, "intro"),
        issueBlock,
        p(cfg.email.offer, "offer"),
        p(cfg.email.cta, "cta"),
        `${p(cfg.email.signoff, "signoff") ?? ""}\n${signature}`,
        cfg.email.opt_out,
    ]
        .filter((x): x is string => !!x && !!x.trim())
        .join("\n\n");
    return { subject, body, issues: keys };
}

/** Short WhatsApp/SMS message. Null when no measured issue can be stated. */
export function composeWhatsapp(lead: LeadRow, audit: AuditRow | null, region: RegionConfig, cfg: OutreachConfig): Composed | null {
    const vars = leadVars(lead, audit, region, cfg);
    const seed = `lead:${lead.id}:wa`;
    const { keys, lines } = issueSentences(leadIssues(lead, audit).slice(0, 1), vars, cfg, seed);
    if (!lines.length) return null;
    const p = (list: string[], slot: string) => pick(list, vars, `${seed}:${slot}`);
    const body = [p(cfg.whatsapp.greeting, "greeting"), `${p(cfg.whatsapp.intro, "intro") ?? ""} ${lines[0]}`, p(cfg.whatsapp.offer, "offer"), p(cfg.whatsapp.cta, "cta"), cfg.whatsapp.opt_out]
        .filter((x): x is string => !!x && !!x.trim())
        .join("\n\n");
    return { subject: null, body, issues: keys };
}
