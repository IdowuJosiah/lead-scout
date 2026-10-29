import { ImapFlow } from "imapflow";
import { simpleParser, type AddressObject } from "mailparser";
import type { LeadStore } from "../db.js";
import { errMessage, log } from "../log.js";
import type { OutreachRow } from "./store.js";

/**
 * Reads the mailbox for answers to sent emails: replies, "stop" requests,
 * bounces and auto-replies. Anyone who replied or opted out is never
 * contacted again; bounced addresses are suppressed.
 */

export interface InboundMessage {
    /** Message-ID, or a UID-based fallback. */
    key: string;
    from: string | null;
    subject: string | null;
    text: string;
    date: string | null;
    inReplyTo: string | null;
    references: string[];
    autoSubmitted: boolean;
    /** A delivery-status report (bounce). */
    isReport: boolean;
}

export type InboundKind = "reply" | "opt_out" | "bounce" | "auto_reply";

const OPT_OUT = /\b(stop|unsubscribe|remove me|take me off|opt[ -]?out|not interested|no thanks|don'?t (contact|email|message) me)\b/i;
const AUTO_SUBJECT = /^(auto(matic)?[ -]?reply|out of (the )?office|away|vacation|undeliverable|delivery status notification)/i;

/** The new part of a reply: drop quoted lines and everything from "On ... wrote:". */
export function freshText(text: string): string {
    const lines: string[] = [];
    for (const line of text.split(/\r?\n/)) {
        if (/^\s*>/.test(line)) continue;
        if (/^\s*On .+wrote:\s*$/i.test(line) || /^-{2,}\s*Original Message/i.test(line) || /^From: .+/i.test(line)) break;
        lines.push(line);
    }
    return lines.join("\n").trim();
}

const norm = (id: string) => id.trim().replace(/^<|>$/g, "").toLowerCase();

export function classifyInbound(
    msg: InboundMessage,
    ctx: { byRecipient: Map<string, OutreachRow>; byMessageId: Map<string, OutreachRow> },
): { kind: InboundKind; outreach: OutreachRow } | null {
    const from = msg.from?.toLowerCase() ?? "";
    const threadIds = [msg.inReplyTo, ...msg.references].filter((x): x is string => !!x).map(norm);
    const threadMatch = threadIds.map((id) => ctx.byMessageId.get(id)).find(Boolean);

    if (msg.isReport || /^(mailer-daemon|postmaster)@/.test(from)) {
        // Which of our recipients bounced: the thread, or an address we emailed named in the report.
        const lower = msg.text.toLowerCase();
        const hit = threadMatch ?? [...ctx.byRecipient.entries()].find(([addr]) => lower.includes(addr))?.[1];
        return hit ? { kind: "bounce", outreach: hit } : null;
    }
    const outreach = ctx.byRecipient.get(from) ?? threadMatch;
    if (!outreach) return null;
    if (msg.autoSubmitted || AUTO_SUBJECT.test(msg.subject ?? "")) return { kind: "auto_reply", outreach };
    if (OPT_OUT.test(freshText(msg.text).slice(0, 500)) || OPT_OUT.test(msg.subject ?? "")) return { kind: "opt_out", outreach };
    return { kind: "reply", outreach };
}

/** Apply classified messages to the store. Returns counts by kind. */
export function applyInbound(store: LeadStore, messages: InboundMessage[]): Record<InboundKind, number> {
    const o = store.outreach;
    const sent = o.list("channel = 'email' AND status IN ('sent', 'bounced')");
    const ctx = {
        byRecipient: new Map(sent.filter((r) => r.recipient).map((r) => [r.recipient!.toLowerCase(), r])),
        byMessageId: new Map(sent.filter((r) => r.message_id).map((r) => [norm(r.message_id!), r])),
    };
    const counts: Record<InboundKind, number> = { reply: 0, opt_out: 0, bounce: 0, auto_reply: 0 };
    const leads = new Map(store.allLeadsWithAudits().map(({ lead }) => [lead.id, lead]));
    for (const msg of messages) {
        const c = classifyInbound(msg, ctx);
        if (!c) continue;
        const isNew = o.addReply({
            message_key: msg.key,
            lead_id: c.outreach.lead_id,
            outreach_id: c.outreach.id,
            kind: c.kind,
            from_addr: msg.from,
            subject: msg.subject,
            snippet: freshText(msg.text).slice(0, 300),
            received_at: msg.date,
        });
        if (!isNew) continue;
        counts[c.kind]++;
        const recipient = c.outreach.recipient;
        if (c.kind === "bounce") {
            o.update(c.outreach.id, { status: "bounced", error: "bounced" });
            if (recipient) o.suppress(recipient, "bounced");
        } else if (c.kind === "opt_out") {
            if (recipient) o.suppress(recipient, "opted_out");
            const phone = leads.get(c.outreach.lead_id)?.phone;
            if (phone) o.suppress(phone, "opted_out");
        } else if (c.kind === "reply") {
            if (recipient) o.suppress(recipient, "replied");
        }
    }
    return counts;
}

export interface ImapSettings {
    host: string;
    port: number;
    user: string;
    pass: string;
}

/** IMAP settings from the environment; falls back to the SMTP login. Defaults are Zoho Mail's. */
export function imapSettingsFromEnv(env = process.env): ImapSettings | null {
    const user = (env.IMAP_USER || env.SMTP_USER)?.trim();
    const pass = (env.IMAP_PASS || env.SMTP_PASS)?.trim();
    if (!user || !pass) return null;
    return { host: env.IMAP_HOST?.trim() || "imap.zoho.com", port: Number(env.IMAP_PORT || 993), user, pass };
}

const addr = (a: AddressObject | AddressObject[] | undefined) => (Array.isArray(a) ? a[0] : a)?.value[0]?.address ?? null;

/** Fetch INBOX messages newer than the last run (first run: last 30 days), at most `max`. */
export async function fetchInbox(store: LeadStore, s: ImapSettings, max = 300): Promise<InboundMessage[]> {
    const o = store.outreach;
    const client = new ImapFlow({ host: s.host, port: s.port, secure: s.port === 993, auth: { user: s.user, pass: s.pass }, logger: false });
    await client.connect();
    const out: InboundMessage[] = [];
    try {
        const box = await client.mailboxOpen("INBOX", { readOnly: true });
        const validity = String(box.uidValidity);
        const lastUid = o.getState("imap_uid_validity") === validity ? Number(o.getState("imap_last_uid") ?? 0) : 0;
        const query = lastUid ? { uid: `${lastUid + 1}:*` } : { since: new Date(Date.now() - 30 * 24 * 3600 * 1000) };
        const uids = ((await client.search(query, { uid: true })) || []).filter((u) => u > lastUid).slice(-max);
        let maxUid = lastUid;
        for (const uid of uids) {
            const m = await client.fetchOne(String(uid), { source: true }, { uid: true });
            if (!m || !m.source) continue;
            maxUid = Math.max(maxUid, uid);
            try {
                const p = await simpleParser(m.source);
                const header = (k: string) => {
                    const v = p.headers.get(k);
                    return typeof v === "string" ? v : v ? JSON.stringify(v) : "";
                };
                const refs = p.references ? (Array.isArray(p.references) ? p.references : [p.references]) : [];
                out.push({
                    key: p.messageId ?? `uid:${validity}:${uid}`,
                    from: addr(p.from),
                    subject: p.subject ?? null,
                    text: (p.text ?? "").slice(0, 20_000),
                    date: (p.date ?? new Date()).toISOString(),
                    inReplyTo: p.inReplyTo ?? null,
                    references: refs,
                    autoSubmitted: /auto-(replied|generated)/i.test(header("auto-submitted")) || !!p.headers.get("x-autoreply") || !!p.headers.get("x-autorespond"),
                    isReport: /multipart\/report/i.test(header("content-type")),
                });
            } catch (err) {
                log.warn(`inbox: could not parse message ${uid}: ${errMessage(err)}`);
            }
        }
        o.setState("imap_uid_validity", validity);
        o.setState("imap_last_uid", String(maxUid));
    } finally {
        await client.logout().catch(() => {});
    }
    return out;
}
