import { readFileSync } from "node:fs";

/**
 * config/outreach.json: who you are, sending limits, and every phrase used in
 * emails and WhatsApp messages. Placeholders are checked on load so a typo
 * fails loudly instead of sending "{brnad}" to a customer.
 */

export interface OutreachLimits {
    batch_size: number;
    daily_email_limit: number;
    emails_per_run: number;
    min_gap_seconds: number;
    max_gap_seconds: number;
    whatsapp_drafts_per_week: number;
    hunter_calls_per_month: number;
    zerobounce_calls_per_month: number;
}

export interface OutreachConfig {
    sender: { name: string; business: string; role: string; website: string; phone: string };
    limits: OutreachLimits;
    email: {
        subjects: Record<string, string[]>;
        greeting: string[];
        intro: string[];
        transition: string[];
        offer: string[];
        cta: string[];
        signoff: string[];
        opt_out: string;
    };
    whatsapp: { greeting: string[]; intro: string[]; offer: string[]; cta: string[]; opt_out: string };
    issues: Record<string, string[]>;
}

/** Every value a template may use. Each is filled only from stored measurements or your config. */
export const PLACEHOLDERS = [
    "brand",
    "category",
    "city",
    "domain",
    "host",
    "pages_checked",
    "load_seconds",
    "lighthouse",
    "dead_reason",
    "sender_name",
    "sender_role",
    "sender_business_suffix",
] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];

/** Issue keys the scorer can produce (see scoring.ts) plus no_website. */
export const ISSUE_KEYS = [
    "no_website",
    "dead_listing",
    "social_only",
    "link_in_bio_only",
    "messaging_only",
    "whatsapp_order_only",
    "site_unreachable",
    "password_protected",
    "no_cart_or_checkout",
    "hosted_storefront",
    "load_timed_out",
    "very_slow_load",
    "slow_load",
    "lighthouse_poor",
    "lighthouse_needs_work",
    "no_valid_ssl",
    "no_payment_provider_detected",
] as const;

const DEFAULT_LIMITS: OutreachLimits = {
    batch_size: 25,
    daily_email_limit: 25,
    emails_per_run: 5,
    min_gap_seconds: 60,
    max_gap_seconds: 180,
    whatsapp_drafts_per_week: 40,
    hunter_calls_per_month: 50,
    zerobounce_calls_per_month: 100,
};

const list = (v: unknown, where: string, errors: string[]): string[] => {
    if (!Array.isArray(v) || !v.length || !v.every((x) => typeof x === "string" && x.trim())) {
        errors.push(`${where} must be a non-empty list of text`);
        return [];
    }
    return v as string[];
};

export function parseOutreachConfig(raw: Record<string, unknown>): OutreachConfig {
    const errors: string[] = [];
    const sender = (raw.sender ?? {}) as Record<string, unknown>;
    const email = (raw.email ?? {}) as Record<string, unknown>;
    const wa = (raw.whatsapp ?? {}) as Record<string, unknown>;
    const issuesRaw = (raw.issues ?? {}) as Record<string, unknown>;
    const subjectsRaw = (email.subjects ?? {}) as Record<string, unknown>;

    const limits = { ...DEFAULT_LIMITS, ...((raw.limits ?? {}) as Partial<OutreachLimits>) };
    for (const [k, v] of Object.entries(limits)) {
        if (typeof v !== "number" || !Number.isFinite(v) || v < 0) errors.push(`limits.${k} must be a number >= 0`);
    }
    if (limits.max_gap_seconds < limits.min_gap_seconds) errors.push("limits.max_gap_seconds must be >= min_gap_seconds");

    const subjects: Record<string, string[]> = {};
    for (const [k, v] of Object.entries(subjectsRaw)) subjects[k] = list(v, `email.subjects.${k}`, errors);
    if (!subjects.default) errors.push("email.subjects.default is required");

    const issues: Record<string, string[]> = {};
    for (const key of ISSUE_KEYS) {
        if (issuesRaw[key] === undefined) errors.push(`issues.${key} is missing`);
        else issues[key] = list(issuesRaw[key], `issues.${key}`, errors);
    }
    for (const key of Object.keys(issuesRaw)) if (!(ISSUE_KEYS as readonly string[]).includes(key)) errors.push(`issues.${key} is not a known issue`);

    const optOut = (v: unknown, where: string) => {
        if (typeof v !== "string" || !v.trim()) errors.push(`${where} is required (every message must offer a way to opt out)`);
        return String(v ?? "");
    };

    const cfg: OutreachConfig = {
        sender: {
            name: String(sender.name ?? "").trim(),
            business: String(sender.business ?? "").trim(),
            role: String(sender.role ?? "web developer").trim(),
            website: String(sender.website ?? "").trim(),
            phone: String(sender.phone ?? "").trim(),
        },
        limits,
        email: {
            subjects,
            greeting: list(email.greeting, "email.greeting", errors),
            intro: list(email.intro, "email.intro", errors),
            transition: list(email.transition, "email.transition", errors),
            offer: list(email.offer, "email.offer", errors),
            cta: list(email.cta, "email.cta", errors),
            signoff: list(email.signoff, "email.signoff", errors),
            opt_out: optOut(email.opt_out, "email.opt_out"),
        },
        whatsapp: {
            greeting: list(wa.greeting, "whatsapp.greeting", errors),
            intro: list(wa.intro, "whatsapp.intro", errors),
            offer: list(wa.offer, "whatsapp.offer", errors),
            cta: list(wa.cta, "whatsapp.cta", errors),
            opt_out: optOut(wa.opt_out, "whatsapp.opt_out"),
        },
        issues,
    };

    // Unknown placeholders anywhere are a typo.
    const walk = (v: unknown, where: string) => {
        if (typeof v === "string") {
            for (const m of v.matchAll(/\{([^}]*)\}/g)) {
                if (!(PLACEHOLDERS as readonly string[]).includes(m[1]!)) errors.push(`${where}: unknown placeholder {${m[1]}}`);
            }
        } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
        else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, where ? `${where}.${k}` : k);
    };
    walk({ email: cfg.email, whatsapp: cfg.whatsapp, issues: cfg.issues }, "");

    if (errors.length) throw new Error(`Invalid outreach config:\n  - ${errors.join("\n  - ")}`);
    return cfg;
}

export function loadOutreachConfig(path: string): OutreachConfig {
    let raw: Record<string, unknown>;
    try {
        raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
        throw new Error(`Could not read ${path}: ${(err as Error).message}`);
    }
    return parseOutreachConfig(raw);
}

/** Drafting needs to know who is writing. */
export function assertSenderSet(cfg: OutreachConfig) {
    if (!cfg.sender.name) throw new Error('Set "sender.name" in config/outreach.json before drafting messages');
}
