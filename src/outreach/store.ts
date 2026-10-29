import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/**
 * Outreach state: drafts, batches you approve, what was sent, replies, the
 * do-not-contact list and paid API usage. One outreach row per lead per
 * channel, ever, so a brand is never cold-emailed twice.
 */
export const OUTREACH_SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
    id           INTEGER PRIMARY KEY,
    created_at   TEXT NOT NULL,
    status       TEXT NOT NULL,          -- awaiting_approval | approved | done
    approved_at  TEXT
);

CREATE TABLE IF NOT EXISTS outreach (
    id           INTEGER PRIMARY KEY,
    lead_id      INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
    channel      TEXT NOT NULL,          -- email | whatsapp | phone
    recipient    TEXT,                   -- email address, wa.me link, or phone number
    subject      TEXT,
    body         TEXT NOT NULL,
    issues       TEXT,                   -- JSON list of the issue keys the message states
    status       TEXT NOT NULL,          -- draft | approved | sending | sent | skipped | failed | bounced
    batch_id     INTEGER REFERENCES batches(id),
    created_at   TEXT NOT NULL,
    approved_at  TEXT,
    sent_at      TEXT,
    message_id   TEXT,
    error        TEXT,
    UNIQUE (lead_id, channel)
);

CREATE TABLE IF NOT EXISTS suppression (
    key         TEXT PRIMARY KEY,        -- lowercased email address, or phone digits
    reason      TEXT NOT NULL,           -- opted_out | bounced | replied | manual
    created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS replies (
    id           INTEGER PRIMARY KEY,
    message_key  TEXT NOT NULL UNIQUE,   -- Message-ID (or UID) of the inbound mail
    lead_id      INTEGER,
    outreach_id  INTEGER,
    kind         TEXT NOT NULL,          -- reply | opt_out | bounce | auto_reply
    from_addr    TEXT,
    subject      TEXT,
    snippet      TEXT,
    received_at  TEXT
);

CREATE TABLE IF NOT EXISTS api_usage (
    month     TEXT NOT NULL,
    provider  TEXT NOT NULL,
    calls     INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (month, provider)
);

CREATE TABLE IF NOT EXISTS agent_state (
    key    TEXT PRIMARY KEY,
    value  TEXT
);

CREATE TABLE IF NOT EXISTS processed_actions (
    id            TEXT PRIMARY KEY,
    processed_at  TEXT NOT NULL
);
`;

export type OutreachChannel = "email" | "whatsapp" | "phone";
export type OutreachStatus = "draft" | "approved" | "sending" | "sent" | "skipped" | "failed" | "bounced";

export interface OutreachRow {
    id: number;
    lead_id: number;
    channel: OutreachChannel;
    recipient: string | null;
    subject: string | null;
    body: string;
    issues: string | null;
    status: OutreachStatus;
    batch_id: number | null;
    created_at: string;
    approved_at: string | null;
    sent_at: string | null;
    message_id: string | null;
    error: string | null;
}

export interface ReplyRow {
    id: number;
    message_key: string;
    lead_id: number | null;
    outreach_id: number | null;
    kind: "reply" | "opt_out" | "bounce" | "auto_reply";
    from_addr: string | null;
    subject: string | null;
    snippet: string | null;
    received_at: string | null;
}

const now = () => new Date().toISOString();
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);

/** Phone numbers and emails are suppressed by a normalised key. */
export function suppressionKey(value: string): string {
    const v = value.trim().toLowerCase();
    if (v.includes("@")) return v.replace(/^mailto:/, "");
    const digits = v.replace(/\D/g, "");
    return digits || v;
}

export class OutreachStore {
    constructor(private readonly db: DatabaseSync) {}

    get(id: number): OutreachRow | null {
        return (this.db.prepare("SELECT * FROM outreach WHERE id = ?").get(id) as unknown as OutreachRow | undefined) ?? null;
    }

    forLead(leadId: number): OutreachRow[] {
        return this.db.prepare("SELECT * FROM outreach WHERE lead_id = ? ORDER BY id").all(leadId) as unknown as OutreachRow[];
    }

    hasOutreach(leadId: number, channel?: OutreachChannel): boolean {
        const row = channel
            ? this.db.prepare("SELECT 1 FROM outreach WHERE lead_id = ? AND channel = ?").get(leadId, channel)
            : this.db.prepare("SELECT 1 FROM outreach WHERE lead_id = ?").get(leadId);
        return !!row;
    }

    /** Insert a draft; returns null if this lead already has outreach on this channel. */
    addDraft(d: { lead_id: number; channel: OutreachChannel; recipient: string | null; subject: string | null; body: string; issues: string[]; batch_id: number | null }): number | null {
        const res = this.db
            .prepare(
                `INSERT OR IGNORE INTO outreach (lead_id, channel, recipient, subject, body, issues, status, batch_id, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?)`,
            )
            .run(d.lead_id, d.channel, d.recipient, d.subject, d.body, JSON.stringify(d.issues), d.batch_id, now());
        return res.changes ? Number(res.lastInsertRowid) : null;
    }

    update(id: number, fields: Partial<Omit<OutreachRow, "id" | "lead_id" | "channel">>) {
        const cols = Object.keys(fields);
        if (!cols.length) return;
        const values = cols.map((c) => (fields as Record<string, unknown>)[c] ?? null) as SQLInputValue[];
        this.db.prepare(`UPDATE outreach SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...values, id);
    }

    list(where = "1 = 1", ...params: SQLInputValue[]): OutreachRow[] {
        return this.db.prepare(`SELECT * FROM outreach WHERE ${where} ORDER BY id`).all(...params) as unknown as OutreachRow[];
    }

    createBatch(): number {
        return Number(this.db.prepare("INSERT INTO batches (created_at, status) VALUES (?, 'awaiting_approval')").run(now()).lastInsertRowid);
    }

    batches(): { id: number; created_at: string; status: string; approved_at: string | null }[] {
        return this.db.prepare("SELECT * FROM batches ORDER BY id DESC").all() as { id: number; created_at: string; status: string; approved_at: string | null }[];
    }

    openBatch(): number | null {
        const row = this.db.prepare("SELECT id FROM batches WHERE status = 'awaiting_approval' ORDER BY id LIMIT 1").get() as { id: number } | undefined;
        return row?.id ?? null;
    }

    setBatchStatus(id: number, status: string) {
        this.db.prepare(`UPDATE batches SET status = ?, approved_at = CASE WHEN ? = 'approved' THEN ? ELSE approved_at END WHERE id = ?`).run(status, status, now(), id);
    }

    /** Close batches whose emails are all finished. */
    settleBatches() {
        this.db.exec(`UPDATE batches SET status = 'done' WHERE status = 'approved'
            AND NOT EXISTS (SELECT 1 FROM outreach o WHERE o.batch_id = batches.id AND o.status IN ('approved', 'sending'))`);
    }

    suppress(value: string, reason: string) {
        this.db.prepare("INSERT OR IGNORE INTO suppression (key, reason, created_at) VALUES (?, ?, ?)").run(suppressionKey(value), reason, now());
    }

    isSuppressed(value: string | null): boolean {
        if (!value) return false;
        return !!this.db.prepare("SELECT 1 FROM suppression WHERE key = ?").get(suppressionKey(value));
    }

    leadHasReplied(leadId: number): boolean {
        return !!this.db.prepare("SELECT 1 FROM replies WHERE lead_id = ? AND kind IN ('reply', 'opt_out')").get(leadId);
    }

    addReply(r: Omit<ReplyRow, "id">): boolean {
        const res = this.db
            .prepare(
                `INSERT OR IGNORE INTO replies (message_key, lead_id, outreach_id, kind, from_addr, subject, snippet, received_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(r.message_key, r.lead_id, r.outreach_id, r.kind, r.from_addr, r.subject, r.snippet, r.received_at);
        return res.changes > 0;
    }

    replies(limit = 200): ReplyRow[] {
        return this.db.prepare("SELECT * FROM replies ORDER BY received_at DESC, id DESC LIMIT ?").all(limit) as unknown as ReplyRow[];
    }

    usage(provider: string, month = monthKey()): number {
        const row = this.db.prepare("SELECT calls FROM api_usage WHERE month = ? AND provider = ?").get(month, provider) as { calls: number } | undefined;
        return row?.calls ?? 0;
    }

    recordUsage(provider: string, calls = 1, month = monthKey()) {
        this.db
            .prepare("INSERT INTO api_usage (month, provider, calls) VALUES (?, ?, ?) ON CONFLICT(month, provider) DO UPDATE SET calls = calls + excluded.calls")
            .run(month, provider, calls);
    }

    getState(key: string): string | null {
        return (this.db.prepare("SELECT value FROM agent_state WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
    }

    setState(key: string, value: string) {
        this.db.prepare("INSERT INTO agent_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
    }

    actionProcessed(id: string): boolean {
        return !!this.db.prepare("SELECT 1 FROM processed_actions WHERE id = ?").get(id);
    }

    markActionProcessed(id: string) {
        this.db.prepare("INSERT OR IGNORE INTO processed_actions (id, processed_at) VALUES (?, ?)").run(id, now());
    }
}
