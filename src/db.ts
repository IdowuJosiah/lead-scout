import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/**
 * SQLite storage (node:sqlite, no native addon). Every write is an upsert keyed
 * on something stable, so each stage can be re-run without duplicating rows.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS leads (
    id              INTEGER PRIMARY KEY,
    dedupe_key      TEXT NOT NULL UNIQUE,
    name            TEXT NOT NULL,
    category        TEXT,
    address         TEXT,
    phone           TEXT,
    website_url     TEXT,
    website_domain  TEXT,
    source          TEXT NOT NULL,
    source_ref      TEXT,
    discovered_at   TEXT NOT NULL,
    updated_at      TEXT NOT NULL,
    high_priority   INTEGER NOT NULL DEFAULT 0,
    lead_score      INTEGER,
    score_breakdown TEXT,
    evidence        TEXT,
    country         TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS leads_source_ref ON leads(source, source_ref) WHERE source_ref IS NOT NULL;

CREATE TABLE IF NOT EXISTS audits (
    lead_id              INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
    audited_at           TEXT NOT NULL,
    status               TEXT NOT NULL,
    requested_url        TEXT,
    final_url            TEXT,
    http_status          INTEGER,
    load_time_ms         INTEGER,
    load_timed_out       INTEGER,
    lighthouse_score     INTEGER,
    lighthouse_error     TEXT,
    platform             TEXT,
    platform_signal      TEXT,
    has_cart             INTEGER,
    has_checkout         INTEGER,
    cart_signal          TEXT,
    payment_providers    TEXT,
    link_in_bio_only     INTEGER,
    link_in_bio_host     TEXT,
    whatsapp_links       INTEGER,
    whatsapp_order_only  INTEGER,
    ssl                  TEXT,
    ssl_detail           TEXT,
    local_currency_seen  INTEGER,
    screenshot_path      TEXT,
    error                TEXT
);

CREATE TABLE IF NOT EXISTS failures (
    id           INTEGER PRIMARY KEY,
    lead_id      INTEGER REFERENCES leads(id) ON DELETE CASCADE,
    stage        TEXT NOT NULL,
    message      TEXT NOT NULL,
    occurred_at  TEXT NOT NULL
);

-- Stage 3. Every email address found for a lead, and where it came from.
CREATE TABLE IF NOT EXISTS contacts (
    lead_id        INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    email          TEXT NOT NULL,
    email_source   TEXT NOT NULL,
    source_detail  TEXT,
    email_type     TEXT NOT NULL,
    own_domain     INTEGER NOT NULL,
    found_at       TEXT NOT NULL,
    PRIMARY KEY (lead_id, email)
);

-- Verification results, cached per address so re-runs don't pay twice.
CREATE TABLE IF NOT EXISTS email_verifications (
    email        TEXT PRIMARY KEY,
    status       TEXT NOT NULL,
    sub_status   TEXT,
    provider     TEXT NOT NULL,
    verified_at  TEXT NOT NULL
);

-- One outcome per lead: an email to queue, or a fallback channel.
CREATE TABLE IF NOT EXISTS contact_results (
    lead_id              INTEGER PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
    processed_at         TEXT NOT NULL,
    outcome              TEXT NOT NULL,
    email                TEXT,
    email_type           TEXT,
    email_source         TEXT,
    verification_status  TEXT,
    risk_flag            TEXT,
    channel              TEXT,
    channel_value        TEXT,
    channel_note         TEXT,
    reason               TEXT,
    contact_evidence     TEXT,
    error                TEXT
);
`;

export interface LeadRow {
    id: number;
    dedupe_key: string;
    name: string;
    category: string | null;
    address: string | null;
    phone: string | null;
    website_url: string | null;
    website_domain: string | null;
    source: string;
    source_ref: string | null;
    discovered_at: string;
    updated_at: string;
    high_priority: number;
    lead_score: number | null;
    score_breakdown: string | null;
    evidence: string | null;
    /** ISO code of the region config the lead was discovered under. */
    country: string | null;
}

export type AuditStatus =
    | "ok" // page loaded and was inspected
    | "unreachable" // DNS/connection/HTTP error or timeout before any response
    | "robots_disallowed" // robots.txt forbids fetching the page; nothing loaded
    | "social_profile" // listed website is a social profile; not loaded
    | "whatsapp_link" // listed website is a WhatsApp chat link; not loaded
    | "blocked" // site answered 401/403/429 (bot wall); nothing about the store measured
    | "failed"; // our own error; nothing reliable measured

export interface AuditRecord {
    lead_id: number;
    audited_at: string;
    status: AuditStatus;
    requested_url: string | null;
    final_url: string | null;
    http_status: number | null;
    load_time_ms: number | null;
    load_timed_out: boolean | null;
    lighthouse_score: number | null;
    lighthouse_error: string | null;
    platform: string | null;
    platform_signal: string | null;
    has_cart: boolean | null;
    has_checkout: boolean | null;
    cart_signal: string | null;
    /** JSON array of {name, signal}. */
    payment_providers: string | null;
    link_in_bio_only: boolean | null;
    link_in_bio_host: string | null;
    whatsapp_links: number | null;
    whatsapp_order_only: boolean | null;
    ssl: "valid" | "invalid" | "none" | "unknown" | null;
    ssl_detail: string | null;
    local_currency_seen: boolean | null;
    screenshot_path: string | null;
    error: string | null;
}

/** Row shape as read back from SQLite (booleans become 0/1). */
export type AuditRow = {
    [K in keyof AuditRecord]: AuditRecord[K] extends boolean | null ? number | null : AuditRecord[K];
};

export interface NewLead {
    name: string;
    category: string | null;
    address: string | null;
    phone: string | null;
    website_url: string | null;
    website_domain: string | null;
    source: string;
    source_ref: string | null;
    dedupe_key: string;
    country?: string | null;
}

export type EmailSource = "mailto" | "page_text" | "hunter";
export type EmailType = "personal" | "role" | "free_provider";

export interface ContactRecord {
    email: string;
    email_source: EmailSource;
    /** Page URL for site finds; Hunter details for API finds. */
    source_detail: string | null;
    email_type: EmailType;
    own_domain: boolean;
}

export interface VerificationRecord {
    email: string;
    /** Provider status, e.g. valid | invalid | catch-all | unknown | spamtrap | abuse | do_not_mail. */
    status: string;
    sub_status: string | null;
    provider: string;
    verified_at: string;
}

export interface ContactResult {
    lead_id: number;
    processed_at: string;
    /** email = goes to email_queue; fallback = fallback_queue; failed = retried next run. */
    outcome: "email" | "fallback" | "failed";
    email: string | null;
    email_type: EmailType | null;
    email_source: EmailSource | null;
    verification_status: string | null;
    risk_flag: string | null;
    channel: "whatsapp" | "phone" | "none" | null;
    channel_value: string | null;
    channel_note: string | null;
    /** Why there is no queued email (fallback) or what went wrong (failed). */
    reason: string | null;
    contact_evidence: string | null;
    error: string | null;
}

const toSql = (v: unknown): SQLInputValue => {
    if (v === undefined || v === null) return null;
    if (typeof v === "boolean") return v ? 1 : 0;
    return v as SQLInputValue;
};

const params = (o: object) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, toSql(v)])) as Record<string, SQLInputValue>;

const mergeCategories = (a: string | null, b: string | null) => {
    const set = new Set([...(a ?? "").split(","), ...(b ?? "").split(",")].map((s) => s.trim()).filter(Boolean));
    return set.size ? [...set].join(", ") : null;
};

export class LeadStore {
    readonly db: DatabaseSync;

    constructor(path: string) {
        if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
        this.db = new DatabaseSync(path);
        this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
        this.db.exec(SCHEMA);
        // Databases created before stage 3 lack leads.country.
        const cols = this.db.prepare("PRAGMA table_info(leads)").all() as { name: string }[];
        if (!cols.some((c) => c.name === "country")) this.db.exec("ALTER TABLE leads ADD COLUMN country TEXT");
    }

    close() {
        this.db.close();
    }

    /**
     * Insert or merge a discovered lead. Matches an existing row by
     * (source, source_ref) first, then by dedupe key. Existing values win;
     * new data only fills gaps (and categories accumulate).
     */
    upsertLead(lead: NewLead, now = new Date().toISOString()): { id: number; inserted: boolean } {
        const existing =
            (lead.source_ref
                ? (this.db.prepare("SELECT * FROM leads WHERE source = ? AND source_ref = ?").get(lead.source, lead.source_ref) as LeadRow | undefined)
                : undefined) ?? (this.db.prepare("SELECT * FROM leads WHERE dedupe_key = ?").get(lead.dedupe_key) as LeadRow | undefined);

        if (existing) {
            // A website appearing later moves the lead out of "no website".
            const website = existing.website_url ?? lead.website_url;
            this.db
                .prepare(
                    `UPDATE leads SET
                        category = @category,
                        address = COALESCE(address, @address),
                        phone = COALESCE(phone, @phone),
                        website_url = @website_url,
                        website_domain = COALESCE(website_domain, @website_domain),
                        source_ref = COALESCE(source_ref, @source_ref),
                        country = COALESCE(country, @country),
                        high_priority = @high_priority,
                        updated_at = @now
                     WHERE id = @id`,
                )
                .run(
                    params({
                        id: existing.id,
                        category: mergeCategories(existing.category, lead.category),
                        address: lead.address,
                        phone: lead.phone,
                        website_url: website,
                        website_domain: lead.website_domain,
                        // Only fill source_ref when it is ours (same source) and not already taken.
                        source_ref: existing.source === lead.source ? lead.source_ref : null,
                        high_priority: website ? 0 : 1,
                        country: lead.country,
                        now,
                    }),
                );
            return { id: existing.id, inserted: false };
        }

        const res = this.db
            .prepare(
                `INSERT INTO leads (dedupe_key, name, category, address, phone, website_url, website_domain,
                                    source, source_ref, discovered_at, updated_at, high_priority, country)
                 VALUES (@dedupe_key, @name, @category, @address, @phone, @website_url, @website_domain,
                         @source, @source_ref, @now, @now, @high_priority, @country)`,
            )
            .run(params({ ...lead, country: lead.country ?? null, now, high_priority: lead.website_url ? 0 : 1 }));
        return { id: Number(res.lastInsertRowid), inserted: true };
    }

    /** Leads with a website that need auditing. */
    leadsToAudit(opts: { reaudit: boolean; limit?: number; ids?: number[] }): LeadRow[] {
        const where = ["l.website_url IS NOT NULL"];
        if (!opts.reaudit) where.push("(a.lead_id IS NULL OR a.status = 'failed')");
        if (opts.ids?.length) where.push(`l.id IN (${opts.ids.map(Number).join(",")})`);
        const sql = `SELECT l.* FROM leads l LEFT JOIN audits a ON a.lead_id = l.id
                     WHERE ${where.join(" AND ")} ORDER BY l.id${opts.limit ? ` LIMIT ${Number(opts.limit)}` : ""}`;
        return this.db.prepare(sql).all() as unknown as LeadRow[];
    }

    saveAudit(a: AuditRecord) {
        const cols = Object.keys(a);
        this.db
            .prepare(
                `INSERT INTO audits (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})
                 ON CONFLICT(lead_id) DO UPDATE SET ${cols
                     .filter((c) => c !== "lead_id")
                     .map((c) => `${c} = excluded.${c}`)
                     .join(", ")}`,
            )
            .run(params(a));
    }

    logFailure(leadId: number | null, stage: string, message: string, now = new Date().toISOString()) {
        this.db
            .prepare("INSERT INTO failures (lead_id, stage, message, occurred_at) VALUES (?, ?, ?, ?)")
            .run(leadId, stage, message.slice(0, 2000), now);
    }

    recentFailures(limit = 50) {
        return this.db
            .prepare(
                `SELECT f.occurred_at, f.stage, f.lead_id, l.name, f.message
                 FROM failures f LEFT JOIN leads l ON l.id = f.lead_id
                 ORDER BY f.id DESC LIMIT ?`,
            )
            .all(limit) as { occurred_at: string; stage: string; lead_id: number | null; name: string | null; message: string }[];
    }

    allLeadsWithAudits(): { lead: LeadRow; audit: AuditRow | null }[] {
        const leads = this.db.prepare("SELECT * FROM leads ORDER BY id").all() as unknown as LeadRow[];
        const audits = new Map(
            (this.db.prepare("SELECT * FROM audits").all() as unknown as AuditRow[]).map((a) => [a.lead_id, a]),
        );
        return leads.map((lead) => ({ lead, audit: audits.get(lead.id) ?? null }));
    }

    saveScore(id: number, score: number | null, breakdown: string | null, evidence: string) {
        this.db
            .prepare("UPDATE leads SET lead_score = ?, score_breakdown = ?, evidence = ? WHERE id = ?")
            .run(score, breakdown, evidence, id);
    }

    // ---- Stage 3: contacts ----

    /** Leads eligible for contact finding: scored high enough and with a loaded site. */
    leadsForContact(opts: { minScore: number; recontact: boolean; limit?: number; ids?: number[] }): { lead: LeadRow; audit: AuditRow }[] {
        const where = ["l.lead_score >= @min", "a.status = 'ok'"];
        if (!opts.recontact) where.push("(r.lead_id IS NULL OR r.outcome = 'failed')");
        if (opts.ids?.length) where.push(`l.id IN (${opts.ids.map(Number).join(",")})`);
        const rows = this.db
            .prepare(
                `SELECT l.id FROM leads l JOIN audits a ON a.lead_id = l.id LEFT JOIN contact_results r ON r.lead_id = l.id
                 WHERE ${where.join(" AND ")} ORDER BY l.lead_score DESC, l.id${opts.limit ? ` LIMIT ${Number(opts.limit)}` : ""}`,
            )
            .all({ min: opts.minScore }) as { id: number }[];
        const lead = this.db.prepare("SELECT * FROM leads WHERE id = ?");
        const audit = this.db.prepare("SELECT * FROM audits WHERE lead_id = ?");
        return rows.map(({ id }) => ({ lead: lead.get(id) as unknown as LeadRow, audit: audit.get(id) as unknown as AuditRow }));
    }

    replaceContacts(leadId: number, contacts: ContactRecord[], now = new Date().toISOString()) {
        this.db.prepare("DELETE FROM contacts WHERE lead_id = ?").run(leadId);
        const ins = this.db.prepare(
            `INSERT OR IGNORE INTO contacts (lead_id, email, email_source, source_detail, email_type, own_domain, found_at)
             VALUES (@lead_id, @email, @email_source, @source_detail, @email_type, @own_domain, @now)`,
        );
        for (const c of contacts) {
            const { email, email_source, source_detail, email_type, own_domain } = c;
            ins.run(params({ email, email_source, source_detail, email_type, own_domain, lead_id: leadId, now }));
        }
    }

    getVerification(email: string): VerificationRecord | null {
        return (this.db.prepare("SELECT * FROM email_verifications WHERE email = ?").get(email) as unknown as VerificationRecord | undefined) ?? null;
    }

    saveVerification(v: VerificationRecord) {
        this.db
            .prepare(
                `INSERT INTO email_verifications (email, status, sub_status, provider, verified_at)
                 VALUES (@email, @status, @sub_status, @provider, @verified_at)
                 ON CONFLICT(email) DO UPDATE SET status = excluded.status, sub_status = excluded.sub_status,
                     provider = excluded.provider, verified_at = excluded.verified_at`,
            )
            .run(params(v));
    }

    saveContactResult(r: ContactResult) {
        const cols = Object.keys(r);
        this.db
            .prepare(
                `INSERT INTO contact_results (${cols.join(", ")}) VALUES (${cols.map((c) => `@${c}`).join(", ")})
                 ON CONFLICT(lead_id) DO UPDATE SET ${cols
                     .filter((c) => c !== "lead_id")
                     .map((c) => `${c} = excluded.${c}`)
                     .join(", ")}`,
            )
            .run(params(r));
    }

    contactResults(): { lead: LeadRow; result: ContactResult }[] {
        const rows = this.db.prepare("SELECT * FROM contact_results ORDER BY lead_id").all() as unknown as ContactResult[];
        const lead = this.db.prepare("SELECT * FROM leads WHERE id = ?");
        return rows.map((result) => ({ lead: lead.get(result.lead_id) as unknown as LeadRow, result }));
    }

    counts() {
        const one = (sql: string) => Number((this.db.prepare(sql).get() as { n: number }).n);
        return {
            leads: one("SELECT COUNT(*) AS n FROM leads"),
            noWebsite: one("SELECT COUNT(*) AS n FROM leads WHERE website_url IS NULL"),
            audited: one("SELECT COUNT(*) AS n FROM audits WHERE status != 'failed'"),
            failedAudits: one("SELECT COUNT(*) AS n FROM audits WHERE status = 'failed'"),
            failures: one("SELECT COUNT(*) AS n FROM failures"),
            emailQueue: one("SELECT COUNT(*) AS n FROM contact_results WHERE outcome = 'email'"),
            fallbackQueue: one("SELECT COUNT(*) AS n FROM contact_results WHERE outcome = 'fallback'"),
        };
    }
}
