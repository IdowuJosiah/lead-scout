import { createTransport, type Transporter } from "nodemailer";
import type { RegionConfig } from "../config.js";
import { emailAllowed } from "../contact/index.js";
import type { LeadStore } from "../db.js";
import { errMessage, log } from "../log.js";
import { sleep } from "../rateLimit.js";
import type { OutreachConfig } from "./config.js";
import { inSendWindow, localParts } from "./window.js";

export interface MailSettings {
    host: string;
    port: number;
    user: string;
    pass: string;
    from: string;
}

/** SMTP settings from the environment. Defaults are Zoho Mail's. */
export function mailSettingsFromEnv(env = process.env): MailSettings | null {
    const user = env.SMTP_USER?.trim();
    const pass = env.SMTP_PASS?.trim();
    if (!user || !pass) return null;
    return {
        host: env.SMTP_HOST?.trim() || "smtp.zoho.com",
        port: Number(env.SMTP_PORT || 465),
        user,
        pass,
        from: env.SMTP_FROM?.trim() || user,
    };
}

export function smtpTransport(s: MailSettings): Transporter {
    return createTransport({ host: s.host, port: s.port, secure: s.port === 465, auth: { user: s.user, pass: s.pass } });
}

export interface SendDeps {
    transport: Transporter;
    from: string;
    now?: () => Date;
    sleep?: (ms: number) => Promise<void>;
    random?: () => number;
}

export interface SendSummary {
    sent: number;
    failed: number;
    skipped: number;
    /** Why nothing (more) was sent, if so. */
    stoppedBecause: string | null;
}

/**
 * Send approved emails: only inside the region's send window, at most
 * emails_per_run per run and daily_email_limit per local day, with a random
 * gap between messages. Re-checks the do-not-contact list right before each.
 */
export async function runSend(store: LeadStore, region: RegionConfig, cfg: OutreachConfig, deps: SendDeps): Promise<SendSummary> {
    const o = store.outreach;
    const now = deps.now ?? (() => new Date());
    const wait = deps.sleep ?? sleep;
    const random = deps.random ?? Math.random;
    const summary: SendSummary = { sent: 0, failed: 0, skipped: 0, stoppedBecause: null };

    // A row left in "sending" means a run died mid-send: never risk sending twice.
    for (const row of o.list("channel = 'email' AND status = 'sending'")) {
        o.update(row.id, { status: "failed", error: "interrupted while sending; check your Sent folder before re-approving" });
    }

    const stop = (why: string) => {
        summary.stoppedBecause = why;
        log.info(`send: ${why}`);
        return summary;
    };
    if (!emailAllowed(region)) return stop(`allowed_to_email is not true for ${region.country_code}`);

    const queue = o.list("channel = 'email' AND status = 'approved'");
    if (!queue.length) return stop("nothing approved to send");

    const leads = new Map(store.allLeadsWithAudits().map(({ lead }) => [lead.id, lead]));
    for (const row of queue) {
        const t = now();
        if (!inSendWindow(t, region.send_window, region.timezone)) return stop(`outside the send window (${region.send_window.days} ${region.send_window.start}-${region.send_window.end} ${region.timezone})`);
        const today = localParts(t, region.timezone).dateKey;
        const sentToday = o.list("channel = 'email' AND status = 'sent' AND sent_at IS NOT NULL").filter((r) => localParts(new Date(r.sent_at!), region.timezone).dateKey === today).length;
        if (sentToday >= cfg.limits.daily_email_limit) return stop(`daily limit reached (${cfg.limits.daily_email_limit})`);
        if (summary.sent >= cfg.limits.emails_per_run) return stop(`per-run limit reached (${cfg.limits.emails_per_run}); the rest go out on the next run`);

        const lead = leads.get(row.lead_id);
        const reason = !lead
            ? "lead no longer exists"
            : (lead.country ?? region.country_code) !== region.country_code
              ? `lead is in region ${lead.country}`
              : o.leadHasReplied(row.lead_id)
                ? "lead has replied"
                : o.isSuppressed(row.recipient)
                  ? "address is on the do-not-contact list"
                  : !row.recipient
                    ? "no recipient"
                    : null;
        if (reason) {
            o.update(row.id, { status: "skipped", error: reason });
            summary.skipped++;
            continue;
        }

        if (summary.sent > 0) {
            const gap = cfg.limits.min_gap_seconds + random() * (cfg.limits.max_gap_seconds - cfg.limits.min_gap_seconds);
            await wait(Math.round(gap * 1000));
        }
        o.update(row.id, { status: "sending" });
        try {
            const info = await deps.transport.sendMail({
                from: { name: cfg.sender.name, address: deps.from },
                to: row.recipient!,
                replyTo: deps.from,
                subject: row.subject ?? "",
                text: row.body,
                headers: { "List-Unsubscribe": `<mailto:${deps.from}?subject=unsubscribe>` },
            });
            o.update(row.id, { status: "sent", sent_at: now().toISOString(), message_id: info.messageId ?? null, error: null });
            summary.sent++;
            log.info(`send: #${row.id} to ${row.recipient} (${lead!.name})`);
        } catch (err) {
            o.update(row.id, { status: "failed", error: errMessage(err) });
            summary.failed++;
            store.logFailure(row.lead_id, "send", errMessage(err));
            log.error(`send: #${row.id} to ${row.recipient} failed: ${errMessage(err)}`);
        }
    }
    o.settleBatches();
    log.info(`send: ${summary.sent} sent, ${summary.failed} failed, ${summary.skipped} skipped`);
    return summary;
}
