import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, before, describe, it } from "node:test";
import { queueDecision } from "../src/contact/apis.js";
import { classifyEmail, isOwnDomain, rankEmails } from "../src/contact/classify.js";
import { exportQueues } from "../src/contact/export.js";
import { decodeCfEmail, extractEmails, extractWhatsappLinks } from "../src/contact/extract.js";
import { fallbackChannel } from "../src/contact/fallback.js";
import { runContacts, type ContactOptions } from "../src/contact/index.js";
import { resolveConfig } from "../src/config.js";
import { LeadStore, type AuditRecord } from "../src/db.js";
import { dedupeKey, parseWebsite, websiteDomain } from "../src/url.js";

const cf = (email: string, key = 0x42) => [key, ...[...email].map((c) => c.charCodeAt(0) ^ key)].map((n) => n.toString(16).padStart(2, "0")).join("");

describe("extract", () => {
    it("finds mailto links and visible addresses, not script contents", () => {
        const html = `<a href="mailto:Info@Brand.ng?subject=Hi">Mail</a>
            <p>Write to ade.okafor&#64;brand.ng today.</p>
            <script>var dsn="abc@sentry.io"; var x="hidden@brand.ng";</script>
            <img src="logo@2x.png"><p>you@example.com</p>`;
        const found = extractEmails(html, "https://brand.ng/contact");
        assert.deepEqual(
            found.map((f) => [f.email, f.source]),
            [
                ["info@brand.ng", "mailto"],
                ["ade.okafor@brand.ng", "page_text"],
            ],
        );
    });

    it("decodes Cloudflare-protected addresses", () => {
        assert.equal(decodeCfEmail(cf("sales@brand.ng")), "sales@brand.ng");
        const html = `<a href="/cdn-cgi/l/email-protection#${cf("hi@brand.ng")}">x</a><span class="__cf_email__" data-cfemail="${cf("team@brand.ng")}">[email&#160;protected]</span>`;
        assert.deepEqual(
            extractEmails(html, "https://brand.ng/").map((f) => [f.email, f.source, f.note]),
            [
                ["hi@brand.ng", "mailto", "Cloudflare-protected link"],
                ["team@brand.ng", "page_text", "Cloudflare-protected address"],
            ],
        );
    });

    it("finds WhatsApp links", () => {
        assert.deepEqual(extractWhatsappLinks('<a href="https://wa.me/2348031234567">Chat</a><a href="/shop">x</a>', "https://brand.ng/"), ["https://wa.me/2348031234567"]);
    });
});

describe("classify", () => {
    it("labels personal, role and free-provider addresses", () => {
        assert.equal(classifyEmail("ade.okafor@brand.ng"), "personal");
        assert.equal(classifyEmail("info@brand.ng"), "role");
        assert.equal(classifyEmail("sales.lagos@brand.ng"), "role");
        assert.equal(classifyEmail("customer.care@brand.ng"), "role");
        assert.equal(classifyEmail("tunde@brand.ng", "generic"), "role");
        assert.equal(classifyEmail("brandng@gmail.com"), "free_provider");
        assert.equal(classifyEmail("info@yahoo.co.uk"), "free_provider");
        assert.equal(classifyEmail("info@mail.brand.ng"), "role", "mail.<domain> is not a free provider");
    });

    it("matches the site's own domain", () => {
        assert.ok(isOwnDomain("brand.ng", "www.brand.ng"));
        assert.ok(isOwnDomain("brand.ng", "shop.brand.ng"));
        assert.ok(!isOwnDomain("agency.io", "brand.ng"));
        assert.ok(!isOwnDomain("notbrand.ng", "brand.ng"));
    });

    it("ranks personal > role > free, and other businesses' addresses last", () => {
        const c = (email: string, email_type: "personal" | "role" | "free_provider", own_domain: boolean, status = "valid") => ({ email, email_type, own_domain, email_source: "page_text" as const, status });
        const ranked = rankEmails([
            c("dev@agency.io", "personal", false),
            c("brand@gmail.com", "free_provider", false),
            c("info@brand.ng", "role", true),
            c("ade@brand.ng", "personal", true, "catch-all"),
        ]).map((x) => x.email);
        assert.deepEqual(ranked, ["ade@brand.ng", "info@brand.ng", "brand@gmail.com", "dev@agency.io"]);
    });

    it("queues only valid and catch-all (flagged)", () => {
        assert.deepEqual(queueDecision("valid"), { queue: true, riskFlag: null });
        assert.equal(queueDecision("catch-all").queue, true);
        assert.match(queueDecision("catch-all").riskFlag!, /catch-all/);
        for (const s of ["invalid", "unknown", "spamtrap", "abuse", "do_not_mail", null]) assert.equal(queueDecision(s).queue, false);
    });
});

describe("fallback channel", () => {
    it("prefers the site's WhatsApp link, then a mobile number, then the phone", () => {
        assert.equal(fallbackChannel("0803 123 4567", "NG", { url: "https://wa.me/234800", page: "https://b.ng/" }).value, "https://wa.me/234800");
        assert.deepEqual(fallbackChannel("0803 123 4567", "NG", null).value, "https://wa.me/2348031234567");
        assert.equal(fallbackChannel("+1 212 555 0100", "NG", null).channel, "phone");
        assert.equal(fallbackChannel(null, "NG", null).channel, "none");
    });
});

describe("config", () => {
    it("validates the outreach fields", () => {
        const base = { country: "Nigeria", country_code: "NG", city: "Lagos", radius_km: 10, language: "en", currency: "NGN", search_keywords: ["fashion"] };
        const c = resolveConfig({ ...base, timezone: "Africa/Lagos", allowed_to_email: true });
        assert.equal(c.contact_min_score, 60);
        assert.deepEqual(c.send_window, { days: "Mon-Fri", start: "09:00", end: "17:00" });
        assert.equal(resolveConfig(base).allowed_to_email, null, "unset stays unset (treated as not allowed)");
        assert.equal(resolveConfig({ ...base, country: "NG", country_code: undefined }).country_code, "NG", "old configs still work");
        assert.throws(() => resolveConfig({ ...base, timezone: "Lagos" }), /timezone/);
        assert.throws(() => resolveConfig({ ...base, send_window: { days: "Mon-Fri", start: "9am", end: "5pm" } }), /send_window/);
        assert.throws(() => resolveConfig({ ...base, allowed_to_email: "yes" }), /allowed_to_email/);
    });
});

// ---------------------------------------------------------------------------

type Pages = Record<string, string>;
function serve(pages: Pages): Promise<{ server: Server; url: string }> {
    const server = createServer((req, res) => {
        const body = pages[req.url ?? "/"];
        res.writeHead(body === undefined ? 404 : 200, { "Content-Type": req.url === "/robots.txt" ? "text/plain" : "text/html" });
        res.end(body ?? "not found");
    });
    return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` })));
}

describe("contacts stage (end to end, APIs mocked)", { timeout: 120_000 }, () => {
    const servers: Server[] = [];
    const realFetch = globalThis.fetch;
    let dir: string;
    let calls: string[] = [];
    const zb: Record<string, string> = {
        "info@brandone.ng": "valid",
        "ade.okafor@brandtwo.ng": "invalid",
        "sales@brandthree.ng": "catch-all",
        "tunde@brand-four.invalid": "valid",
    };
    const sites: Record<string, string> = {};

    before(async () => {
        dir = mkdtempSync(join(tmpdir(), "lead-scout-contacts-"));
        const defs: Record<string, Pages> = {
            one: {
                "/robots.txt": "User-agent: *\nAllow: /",
                "/": "<h1>Brand One</h1>",
                "/contact": '<a href="mailto:info@brandone.ng?subject=Order">Email</a><footer>Site by dev@agency.io</footer><script>x="a@sentry.io"</script>',
            },
            two: {
                "/": '<a href="https://wa.me/2348099999999">Chat on WhatsApp</a>',
                "/about": "<p>Write to ade.okafor@brandtwo.ng</p>",
            },
            three: { "/": "<h1>Three</h1>", "/contact-us": `<span data-cfemail="${cf("sales@brandthree.ng")}">[email protected]</span>` },
            low: { "/": '<a href="mailto:hi@low.ng">x</a>' },
            blocked: { "/robots.txt": "User-agent: *\nDisallow: /", "/": '<a href="mailto:hidden@blocked.ng">x</a>' },
        };
        for (const [k, pages] of Object.entries(defs)) {
            const s = await serve(pages);
            servers.push(s.server);
            sites[k] = s.url;
        }
        sites.four = "http://brand-four.invalid/";

        globalThis.fetch = (async (input: string | URL) => {
            const url = new URL(String(input));
            calls.push(url.hostname);
            if (url.hostname === "api.hunter.io") {
                return Response.json({
                    data: {
                        emails: [
                            { value: "tunde@brand-four.invalid", type: "personal", confidence: 94, sources: [{ uri: "https://x" }] },
                            { value: "pattern.guess@brand-four.invalid", type: "personal", confidence: 40, sources: [] },
                            { value: "someone@other.com", type: "personal", confidence: 90, sources: [{}] },
                        ],
                    },
                });
            }
            if (url.hostname === "api.zerobounce.net") {
                const email = url.searchParams.get("email")!;
                return Response.json({ address: email, status: zb[email] ?? "unknown", sub_status: "" });
            }
            throw new Error(`unexpected fetch ${url}`);
        }) as typeof fetch;
    });

    afterEach(() => {
        calls = [];
    });

    after(() => {
        globalThis.fetch = realFetch;
        for (const s of servers) s.close();
        rmSync(dir, { recursive: true, force: true });
        delete process.env.HUNTER_API_KEY;
        delete process.env.ZEROBOUNCE_API_KEY;
    });

    const baseConfig = {
        country: "Nigeria", country_code: "NG", city: "Lagos", radius_km: 10, language: "en", currency: "NGN",
        search_keywords: ["fashion"], timezone: "Africa/Lagos", legal_basis: "B2B legitimate interest; opt-out included.",
    };
    const opts: ContactOptions = { minScore: 60, recontact: false, maxVerify: 3, perHostDelayMs: 0, userAgentToken: "LeadScoutTest", timeoutMs: 5000 };

    function seed(store: LeadStore) {
        const ids: Record<string, number> = {};
        const phones: Record<string, string> = { two: "0803 123 4567", three: "0803 765 4321" };
        for (const [k, url] of Object.entries(sites)) {
            const site = parseWebsite(url)!;
            const { id } = store.upsertLead({
                name: `Brand ${k}`, category: "fashion", address: null, phone: phones[k] ?? null, website_url: site.href,
                website_domain: websiteDomain(site), source: "test", source_ref: k, dedupe_key: dedupeKey(k, null, site), country: "NG",
            });
            ids[k] = id;
            const hasStore = k === "low"; // "low" scores 5: below the threshold
            store.saveAudit({
                lead_id: id, audited_at: "2026-01-01T00:00:00Z", status: "ok", requested_url: site.href, final_url: site.href,
                http_status: 200, load_time_ms: 900, load_timed_out: false, lighthouse_score: null, lighthouse_error: null,
                platform: "custom", platform_signal: "no known platform signature matched", has_cart: hasStore, has_checkout: hasStore,
                cart_signal: null, payment_providers: "[]", link_in_bio_only: false, link_in_bio_host: null, whatsapp_links: 0,
                whatsapp_order_only: false, ssl: "valid", ssl_detail: null, local_currency_seen: false, screenshot_path: null, error: null,
            } satisfies AuditRecord);
        }
        return ids;
    }

    it("finds, verifies, queues and falls back", async () => {
        process.env.HUNTER_API_KEY = "h";
        process.env.ZEROBOUNCE_API_KEY = "z";
        const config = resolveConfig({ ...baseConfig, allowed_to_email: true });
        const store = new LeadStore(join(dir, "a.db"));
        const ids = seed(store);

        const s = await runContacts(store, config, opts);
        assert.deepEqual(s, { processed: 5, email: 3, fallback: 2, failed: 0, skipped: 0 }, "the 'low' lead is under the threshold");
        const r = new Map(store.contactResults().map(({ lead, result }) => [lead.id, result]));

        assert.equal(r.get(ids.one!)!.email, "info@brandone.ng");
        assert.equal(r.get(ids.one!)!.email_type, "role");
        assert.equal(r.get(ids.one!)!.email_source, "mailto");
        assert.match(r.get(ids.one!)!.contact_evidence!, /mailto: link on http:\/\/127\.0\.0\.1:\d+\/contact; ZeroBounce: valid/);

        assert.equal(r.get(ids.two!)!.outcome, "fallback", "only email was invalid");
        assert.equal(r.get(ids.two!)!.channel_value, "https://wa.me/2348099999999", "site's own WhatsApp link wins over the phone");
        assert.match(r.get(ids.two!)!.reason!, /ade\.okafor@brandtwo\.ng: invalid/);

        assert.equal(r.get(ids.three!)!.email, "sales@brandthree.ng");
        assert.equal(r.get(ids.three!)!.verification_status, "catch-all");
        assert.match(r.get(ids.three!)!.risk_flag!, /catch-all/);

        assert.equal(r.get(ids.four!)!.email, "tunde@brand-four.invalid");
        assert.equal(r.get(ids.four!)!.email_source, "hunter");
        assert.equal(r.get(ids.four!)!.email_type, "personal");
        const fourContacts = store.db.prepare("SELECT email FROM contacts WHERE lead_id = ?").all(ids.four!) as { email: string }[];
        assert.deepEqual(fourContacts.map((c) => c.email), ["tunde@brand-four.invalid"], "sourceless and other-domain Hunter results dropped");

        assert.equal(r.get(ids.blocked!)!.outcome, "fallback", "robots.txt kept us off every page");
        assert.match(r.get(ids.blocked!)!.contact_evidence!, /robots\.txt disallows/);
        assert.equal(calls.filter((h) => h === "api.hunter.io").length, 1, "Hunter only for 'four': 'blocked' published nothing but its host is an IP");

        // Re-run: nothing new. --recontact: no duplicate rows, cached verifications reused.
        assert.equal((await runContacts(store, config, opts)).processed, 0);
        calls = [];
        await runContacts(store, config, { ...opts, recontact: true });
        assert.equal(store.contactResults().length, 5);
        assert.equal(calls.filter((h) => h === "api.zerobounce.net").length, 0, "verification cache used");

        // Queues
        const q = { email: join(dir, "email_queue.csv"), fallback: join(dir, "fallback_queue.csv") };
        assert.deepEqual(exportQueues(store, config, q), { email: 3, fallback: 2 });
        const emailCsv = readFileSync(q.email, "utf8").trim().split("\r\n");
        assert.equal(emailCsv[0], "name,email,email_type,verification_status,evidence,lead_score,country,risk_flag,email_source,website,timezone,send_window,legal_basis");
        assert.ok(emailCsv.slice(1).every((l) => l.includes(",NG,")));
        assert.ok(!readFileSync(q.email, "utf8").includes("ade.okafor@brandtwo.ng"), "invalid addresses never queued");
        const fallbackCsv = readFileSync(q.fallback, "utf8");
        assert.match(fallbackCsv, /https:\/\/wa\.me\/2348099999999/);

        // Turning email off for the region moves everyone to the fallback queue at export.
        const off = resolveConfig({ ...baseConfig, allowed_to_email: false });
        assert.deepEqual(exportQueues(store, off, q), { email: 0, fallback: 5 });
        assert.match(readFileSync(q.fallback, "utf8"), /email not permitted for region NG/);
        store.close();
    });

    it("blocks email entirely when the region disallows it, without calling paid APIs", async () => {
        process.env.HUNTER_API_KEY = "h";
        process.env.ZEROBOUNCE_API_KEY = "z";
        const store = new LeadStore(join(dir, "b.db"));
        seed(store);
        const s = await runContacts(store, resolveConfig({ ...baseConfig, allowed_to_email: false }), opts);
        assert.equal(s.email, 0);
        assert.equal(s.fallback, 5);
        assert.deepEqual(calls, [], "no Hunter or ZeroBounce calls");
        store.close();
    });

    it("never queues unverified email when no ZeroBounce key is set", async () => {
        process.env.HUNTER_API_KEY = "h";
        delete process.env.ZEROBOUNCE_API_KEY;
        const store = new LeadStore(join(dir, "c.db"));
        const ids = seed(store);
        const s = await runContacts(store, resolveConfig({ ...baseConfig, allowed_to_email: true }), opts);
        assert.equal(s.email, 0);
        const one = store.contactResults().find((x) => x.lead.id === ids.one)!.result;
        assert.match(one.reason!, /info@brandone\.ng: not verified, no ZeroBounce key/);
        assert.equal(one.channel, "none", "no phone and no WhatsApp link on the site");
        store.close();
    });
});
