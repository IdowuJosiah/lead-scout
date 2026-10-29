import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createTransport } from "nodemailer";
import { simpleParser } from "mailparser";
import { SMTPServer } from "smtp-server";
import { ingestActions } from "../src/agent/actions.js";
import { runTick } from "../src/agent/index.js";
import { buildSnapshot } from "../src/agent/snapshot.js";
import { resolveConfig } from "../src/config.js";
import { LeadStore, type AuditRecord, type ContactResult } from "../src/db.js";
import { exportCsv } from "../src/export.js";
import { composeEmail, composeWhatsapp, render } from "../src/outreach/compose.js";
import { loadOutreachConfig, parseOutreachConfig, type OutreachConfig } from "../src/outreach/config.js";
import { runDraft, waLink } from "../src/outreach/draft.js";
import { applyInbound, classifyInbound, freshText, type InboundMessage } from "../src/outreach/inbox.js";
import { runSend } from "../src/outreach/send.js";
import { inSendWindow, parseDays } from "../src/outreach/window.js";
import { dedupeKey, parseWebsite, websiteDomain } from "../src/url.js";

const region = resolveConfig({
    country: "Nigeria", country_code: "NG", city: "Lagos", radius_km: 10, language: "en", currency: "NGN",
    search_keywords: ["fashion"], timezone: "Africa/Lagos", allowed_to_email: true, legal_basis: "test",
});
const baseCfg = () => {
    const c = loadOutreachConfig(join(import.meta.dirname, "..", "config", "outreach.json"));
    c.sender.name = "Ada Test";
    c.sender.business = "Test Studio";
    return c;
};

const auditRec = (leadId: number, url: string, o: Partial<AuditRecord> = {}): AuditRecord => ({
    lead_id: leadId, audited_at: "2026-01-01T00:00:00Z", status: "ok", requested_url: url, final_url: url, http_status: 200,
    load_time_ms: 9400, load_timed_out: false, lighthouse_score: 31, lighthouse_error: null, platform: "custom",
    platform_signal: "no known platform signature matched", has_cart: false, has_checkout: false, cart_signal: null,
    payment_providers: "[]", link_in_bio_only: false, link_in_bio_host: null, whatsapp_links: 0, whatsapp_order_only: false,
    ssl: "valid", ssl_detail: null, local_currency_seen: true, screenshot_path: null, error: null, password_protected: false,
    password_signal: null, commerce_pages: '["/shop/"]', unreachable_runs: 0, audit_version: 2, ...o,
});

function addLead(store: LeadStore, name: string, website: string | null, phone: string | null, extra: Record<string, unknown> = {}) {
    const site = parseWebsite(website);
    return store.upsertLead({
        name, category: "skincare", address: `${name} rd`, phone, website_url: site?.href ?? null, website_domain: site ? websiteDomain(site) : null,
        source: "google_places", source_ref: name, dedupe_key: dedupeKey(name, `${name} rd`, site), country: "NG", ...extra,
    }).id;
}

function emailResult(leadId: number, email: string, o: Partial<ContactResult> = {}): ContactResult {
    return {
        lead_id: leadId, processed_at: "2026-01-01", outcome: "email", email, email_type: "role", email_source: "mailto",
        verification_status: "valid", risk_flag: null, channel: "none", channel_value: null, channel_note: null, reason: null,
        contact_evidence: `${email} found`, error: null, ...o,
    };
}

/** A store with one emailable lead, three chat leads, and one not ready yet. */
function seeded(path = ":memory:") {
    const store = new LeadStore(path);
    const ids = {
        shop: addLead(store, "Adunni Beauty", "https://adunnibeauty.ng/", "0803 123 4567", { user_ratings_total: 80 }),
        nosite: addLead(store, "Tola Bags", null, "0805 555 1234"),
        insta: addLead(store, "Insta Glow", "https://instagram.com/instaglow", "0807 000 1111"),
        landline: addLead(store, "Landline Co", null, "+234 1 280 0000"),
        pending: addLead(store, "Pending Site", "https://pendingsite.ng/", "0809 222 3333"),
        nophone: addLead(store, "No Phone", null, null),
    };
    store.saveAudit(auditRec(ids.shop, "https://adunnibeauty.ng/"));
    store.saveAudit(auditRec(ids.pending, "https://pendingsite.ng/"));
    store.saveContactResult(emailResult(ids.shop, "hello@adunnibeauty.ng"));
    exportCsv(store, join(mkdtempSync(join(tmpdir(), "ls-csv-")), "leads.csv")); // rescore
    return { store, ids };
}

describe("outreach config", () => {
    it("the shipped file is valid", () => {
        assert.doesNotThrow(() => baseCfg());
    });
    it("rejects unknown placeholders and a missing opt-out", () => {
        const raw = JSON.parse(readFileSync(join(import.meta.dirname, "..", "config", "outreach.json"), "utf8"));
        raw.email.intro = ["Hi {brnad}"];
        assert.throws(() => parseOutreachConfig(raw), /unknown placeholder \{brnad\}/);
        const raw2 = JSON.parse(readFileSync(join(import.meta.dirname, "..", "config", "outreach.json"), "utf8"));
        raw2.whatsapp.opt_out = "";
        assert.throws(() => parseOutreachConfig(raw2), /opt out/);
    });
});

describe("compose", () => {
    it("never fills a sentence with an unmeasured value", () => {
        assert.equal(render("took {load_seconds}s", {}), null);
        assert.equal(render("hi {brand}{sender_business_suffix}", { brand: "X", sender_business_suffix: "" }), "hi X");
    });

    it("writes an email from measured issues only", () => {
        const { store, ids } = seeded();
        const lead = store.allLeadsWithAudits().find((x) => x.lead.id === ids.shop)!;
        const e = composeEmail(lead.lead, lead.audit, region, baseCfg())!;
        assert.deepEqual(e.issues, ["no_cart_or_checkout", "slow_load"], "Lighthouse is dropped when a load-time issue exists");
        assert.match(e.body, /adunnibeauty\.ng/);
        assert.match(e.body, /9\.4 seconds/);
        assert.match(e.body, /homepage and \/shop\//);
        assert.match(e.body, /reply "stop"/);
        assert.match(e.body, /Ada Test\nTest Studio/);
        assert.doesNotMatch(e.body, /\{|\}/, "no leftover placeholders");
        assert.ok(e.subject && !/\{/.test(e.subject));

        // Same lead, no load time recorded: the speed sentence can't be used.
        const noTime = composeEmail(lead.lead, { ...lead.audit!, load_time_ms: null, lighthouse_score: null }, region, baseCfg())!;
        assert.deepEqual(noTime.issues, ["no_cart_or_checkout"]);
        assert.doesNotMatch(noTime.body, /seconds/);
        store.close();
    });

    it("is stable per lead and writes WhatsApp text for a no-website lead", () => {
        const { store, ids } = seeded();
        const row = store.allLeadsWithAudits().find((x) => x.lead.id === ids.nosite)!;
        const a = composeWhatsapp(row.lead, null, region, baseCfg())!;
        assert.deepEqual(a, composeWhatsapp(row.lead, null, region, baseCfg()), "deterministic");
        assert.deepEqual(a.issues, ["no_website"]);
        assert.match(a.body, /Tola Bags/);
        assert.match(a.body, /Ada Test, I'm a web developer at Test Studio/);
        assert.match(a.body, /reply "no"/);
        store.close();
    });
});

describe("draft", () => {
    it("drafts one email batch and chat messages, once", () => {
        const { store, ids } = seeded();
        const cfg = baseCfg();
        const s = runDraft(store, region, cfg);
        assert.equal(s.emailDrafts, 1);
        assert.ok(s.batchId);
        assert.equal(s.whatsappDrafts, 2, "no-website mobile + Instagram-only mobile");
        assert.equal(s.phoneDrafts, 1, "landline gets a phone item");
        const rows = store.outreach.list();
        assert.equal(rows.find((r) => r.lead_id === ids.nosite)!.recipient, "https://wa.me/2348055551234");
        assert.equal(rows.filter((r) => r.lead_id === ids.pending).length, 0, "owned site waits for stage 3");
        assert.equal(rows.filter((r) => r.lead_id === ids.nophone).length, 0, "nothing to contact");

        const again = runDraft(store, region, cfg);
        assert.deepEqual([again.emailDrafts, again.whatsappDrafts, again.phoneDrafts], [0, 0, 0], "never drafted twice");
        assert.equal(again.batchId, s.batchId, "open batch reported");
        store.close();
    });

    it("needs a sender name and respects the do-not-contact list", () => {
        const { store, ids } = seeded();
        const cfg = baseCfg();
        assert.throws(() => runDraft(store, region, { ...cfg, sender: { ...cfg.sender, name: "" } }), /sender\.name/);
        store.outreach.suppress("0805 555 1234", "manual");
        runDraft(store, region, cfg);
        assert.equal(store.outreach.forLead(ids.nosite).length, 0);
        store.close();
    });

    it("normalises WhatsApp links", () => {
        assert.equal(waLink("https://api.whatsapp.com/send?phone=+234%20803%20123%204567&text=hi"), "https://wa.me/2348031234567");
        assert.equal(waLink("https://wa.me/2348031234567?text=Order"), "https://wa.me/2348031234567");
    });
});

describe("dashboard actions", () => {
    it("applies approvals with edits, keeps the opt-out, and ignores replays", () => {
        const { store } = seeded();
        const cfg = baseCfg();
        const { batchId } = runDraft(store, region, cfg);
        const email = store.outreach.list("channel = 'email'")[0]!;
        const chat = store.outreach.list("channel = 'whatsapp'")[0]!;
        const dir = mkdtempSync(join(tmpdir(), "ls-actions-"));
        const write = (name: string, a: unknown) => writeFileSync(join(dir, name), JSON.stringify(a));
        write("1.json", { id: "a1", at: "2026-11-02T08:00:00Z", type: "approve_batch", batch_id: batchId, items: [{ id: email.id, approve: true, subject: "Edited", body: "Edited body without opt-out" }] });
        write("2.json", { id: "a2", at: "2026-11-02T08:01:00Z", type: "whatsapp_done", outreach_id: chat.id });
        writeFileSync(join(dir, "3.json"), "{ not json");
        write("4.json", ["not", "an", "action"]);
        const r = ingestActions(store, cfg, dir);
        assert.deepEqual(r, { applied: 2, failed: 2 }, "broken file and non-action both rejected");
        assert.deepEqual(readdirSync(dir), [], "action files are consumed");
        const e = store.outreach.get(email.id)!;
        assert.equal(e.status, "approved");
        assert.equal(e.subject, "Edited");
        assert.ok(e.body.startsWith("Edited body without opt-out") && e.body.endsWith(cfg.email.opt_out), "opt-out re-added");
        assert.equal(store.outreach.get(chat.id)!.status, "sent");
        assert.equal(store.outreach.batches()[0]!.status, "approved");

        write("again.json", { id: "a1", at: "2026-11-02T08:00:00Z", type: "approve_batch", batch_id: batchId, items: [] });
        assert.deepEqual(ingestActions(store, cfg, dir), { applied: 0, failed: 0 }, "same action id is not applied twice");
        rmSync(dir, { recursive: true, force: true });
        store.close();
    });
});

describe("agent tick", () => {
    it("applies actions, skips sending without credentials, and writes the dashboard + CSVs", async () => {
        const state = mkdtempSync(join(tmpdir(), "ls-state-"));
        const { store } = seeded(join(state, "leads.db"));
        const cfg = baseCfg();
        const { batchId } = runDraft(store, region, cfg);
        mkdirSync(join(state, "actions"));
        writeFileSync(join(state, "actions", "x.json"), JSON.stringify({ id: "t1", at: "2026-11-02T08:00:00Z", type: "approve_batch", batch_id: batchId, items: store.outreach.list("batch_id = ?", batchId!).map((r) => ({ id: r.id, approve: true })) }));
        const saved = { u: process.env.SMTP_USER, p: process.env.SMTP_PASS };
        delete process.env.SMTP_USER;
        delete process.env.SMTP_PASS;
        try {
            const steps = await runTick(store, region, cfg, { stateDir: state, audit: {} as never, contacts: {} as never, discover: false });
            assert.deepEqual(steps.map((x) => [x.step, x.ok]), [["actions", true], ["inbox", true], ["send", true]]);
            assert.match(steps[2]!.detail, /no SMTP credentials/);
        } finally {
            if (saved.u) process.env.SMTP_USER = saved.u;
            if (saved.p) process.env.SMTP_PASS = saved.p;
        }
        const snap = JSON.parse(readFileSync(join(state, "dashboard.json"), "utf8"));
        assert.equal(snap.batches[0].status, "approved");
        assert.equal(snap.stats.emails_approved, 1);
        assert.equal(snap.chats.length, 3);
        assert.ok(snap.runs.tick.steps.length === 3);
        for (const f of ["leads.csv", "email_queue.csv", "fallback_queue.csv"]) assert.ok(readFileSync(join(state, "output", f), "utf8").length > 0);
        store.close();
        rmSync(state, { recursive: true, force: true });
    });
});

describe("send window", () => {
    it("reads day ranges and the region's local time", () => {
        assert.deepEqual([...parseDays("Mon-Fri")].sort(), [1, 2, 3, 4, 5]);
        assert.deepEqual([...parseDays("Fri-Mon")].sort(), [0, 1, 5, 6]);
        const w = { days: "Mon-Fri", start: "09:00", end: "17:00" };
        assert.equal(inSendWindow(new Date("2026-11-02T08:30:00Z"), w, "Africa/Lagos"), true, "Mon 09:30 Lagos");
        assert.equal(inSendWindow(new Date("2026-11-02T07:30:00Z"), w, "Africa/Lagos"), false, "Mon 08:30 Lagos");
        assert.equal(inSendWindow(new Date("2026-11-01T10:00:00Z"), w, "Africa/Lagos"), false, "Sunday");
    });
});

describe("send + inbox (real SMTP to a local server)", { timeout: 60_000 }, () => {
    const received: { to: string; raw: string }[] = [];
    let server: SMTPServer;
    let port = 0;

    before(async () => {
        server = new SMTPServer({
            authOptional: true,
            disabledCommands: ["STARTTLS"],
            onData(stream, session, cb) {
                let raw = "";
                stream.on("data", (c: Buffer) => (raw += c.toString()));
                stream.on("end", () => {
                    received.push({ to: session.envelope.rcptTo.map((r) => r.address).join(","), raw });
                    cb();
                });
            },
        });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        port = (server.server.address() as { port: number }).port;
    });
    after(() => server.close());

    const transport = () => createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true });
    const monday0930 = () => new Date("2026-11-02T08:30:00Z");

    function approvedStore(extra = 0) {
        const { store, ids } = seeded();
        for (let i = 0; i < extra; i++) {
            const id = addLead(store, `Shop ${i}`, `https://shop${i}.ng/`, null);
            store.saveAudit(auditRec(id, `https://shop${i}.ng/`));
            store.saveContactResult(emailResult(id, `info@shop${i}.ng`));
        }
        exportCsv(store, join(mkdtempSync(join(tmpdir(), "ls-csv-")), "leads.csv"));
        const cfg = baseCfg();
        const { batchId } = runDraft(store, region, cfg);
        const items = store.outreach.list("batch_id = ?", batchId!).map((r) => ({ id: r.id, approve: true }));
        const dir = mkdtempSync(join(tmpdir(), "ls-act-"));
        writeFileSync(join(dir, "a.json"), JSON.stringify({ id: `ap-${Math.random()}`, at: new Date().toISOString(), type: "approve_batch", batch_id: batchId, items }));
        ingestActions(store, cfg, dir);
        return { store, ids, cfg };
    }

    it("sends nothing outside the window", async () => {
        const { store, cfg } = approvedStore();
        const s = await runSend(store, region, cfg, { transport: transport(), from: "me@studio.ng", now: () => new Date("2026-11-01T10:00:00Z") });
        assert.equal(s.sent, 0);
        assert.match(s.stoppedBecause!, /outside the send window/);
        store.close();
    });

    it("sends approved emails with pacing, per-run limit and unsubscribe header", async () => {
        received.length = 0;
        const { store, cfg } = approvedStore(6);
        const gaps: number[] = [];
        const s = await runSend(store, region, cfg, { transport: transport(), from: "me@studio.ng", now: monday0930, sleep: async (ms) => void gaps.push(ms), random: () => 0.5 });
        assert.equal(s.sent, cfg.limits.emails_per_run, "per-run limit");
        assert.match(s.stoppedBecause!, /per-run limit/);
        assert.equal(gaps.length, s.sent - 1);
        assert.ok(gaps.every((g) => g === 120_000), "random gap between min and max");
        assert.equal(received.length, s.sent);
        const mail = await simpleParser(received[0]!.raw);
        assert.equal(mail.from?.value[0]?.address, "me@studio.ng");
        assert.match(received[0]!.raw, /^List-Unsubscribe: <mailto:me@studio\.ng\?subject=unsubscribe>/m);
        assert.match(mail.text ?? "", /reply "stop"/);
        const sent = store.outreach.list("status = 'sent'");
        assert.ok(sent.every((r) => r.message_id && r.sent_at));

        // Next run continues; nothing is sent twice.
        const before = received.length;
        await runSend(store, region, cfg, { transport: transport(), from: "me@studio.ng", now: monday0930, sleep: async () => {} });
        assert.equal(received.length - before, 2, "the remaining 2 of 7");
        assert.equal(new Set(received.map((r) => r.to)).size, received.length, "each address once");
        store.close();
    });

    it("stops at the daily limit, skips suppressed leads, and never resends an interrupted one", async () => {
        const { store, cfg } = approvedStore(3);
        const tight = { ...cfg, limits: { ...cfg.limits, daily_email_limit: 2 } } as OutreachConfig;
        const rows = store.outreach.list("status = 'approved'");
        store.outreach.suppress(rows[1]!.recipient!, "opted_out");
        store.outreach.update(rows[2]!.id, { status: "sending" });
        const s = await runSend(store, region, tight, { transport: transport(), from: "me@studio.ng", now: monday0930, sleep: async () => {} });
        assert.equal(s.sent, 2, "rows 0 and 3; row 1 is suppressed, row 2 was interrupted");
        assert.equal(store.outreach.get(rows[1]!.id)!.status, "skipped");
        assert.equal(store.outreach.get(rows[3]!.id)!.status, "sent");
        assert.equal(store.outreach.get(rows[2]!.id)!.status, "failed");
        assert.match(store.outreach.get(rows[2]!.id)!.error!, /check your Sent folder/);
        store.close();
    });

    it("reads replies, stop requests and bounces, and stops contacting them", async () => {
        const { store, cfg } = approvedStore(3);
        await runSend(store, region, cfg, { transport: transport(), from: "me@studio.ng", now: monday0930, sleep: async () => {} });
        const sent = store.outreach.list("status = 'sent'");
        assert.equal(sent.length, 4);
        const msg = (o: Partial<InboundMessage>): InboundMessage => ({ key: `k${Math.random()}`, from: null, subject: "Re: hi", text: "", date: "2026-11-03T10:00:00Z", inReplyTo: null, references: [], autoSubmitted: false, isReport: false, ...o });
        const counts = applyInbound(store, [
            msg({ from: sent[0]!.recipient, text: "Yes, let's talk on Thursday.\n\nOn Mon, 2 Nov 2026, Ada wrote:\n> stop" }),
            msg({ from: "someone.else@gmail.com", inReplyTo: sent[1]!.message_id, text: "Please STOP emailing us" }),
            msg({ from: "mailer-daemon@zoho.com", isReport: true, text: `Delivery failed for ${sent[2]!.recipient}: mailbox not found` }),
            msg({ from: sent[3]!.recipient, subject: "Automatic reply: out of office", autoSubmitted: true }),
            msg({ from: "random@spam.com", text: "buy now" }),
        ]);
        assert.deepEqual(counts, { reply: 1, opt_out: 1, bounce: 1, auto_reply: 1 });
        assert.equal(store.outreach.leadHasReplied(sent[0]!.lead_id), true);
        assert.equal(store.outreach.isSuppressed(sent[1]!.recipient), true, "opt-out suppresses the address");
        assert.equal(store.outreach.get(sent[2]!.id)!.status, "bounced");
        assert.equal(store.outreach.leadHasReplied(sent[3]!.lead_id), false, "auto-replies don't count");

        const snap = buildSnapshot(store, region, cfg);
        assert.equal(snap.stats.replies, 1);
        assert.equal(snap.stats.opt_outs, 1);
        assert.ok(JSON.stringify(snap).length > 100);
        store.close();
    });

    it("keeps the new text of a reply", () => {
        assert.equal(freshText("Sounds good\n\n> On Mon you wrote:\n> stop"), "Sounds good");
        assert.equal(classifyInbound({ key: "x", from: "a@b.ng", subject: "Re", text: "no thanks", date: null, inReplyTo: null, references: [], autoSubmitted: false, isReport: false }, { byRecipient: new Map([["a@b.ng", { id: 1 } as never]]), byMessageId: new Map() })?.kind, "opt_out");
    });
});

// Keep tmp dirs tidy when run locally.
mkdirSync(join(tmpdir(), "ls-csv-keep"), { recursive: true });
