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
import { LeadStore, type AuditRecord, type ContactResult } from "../src/db.js";
import { exportCsv } from "../src/export.js";
import { overrideHost } from "../src/audit/http.js";
import { formatReconcileReport, reconcileContacts } from "../src/contact/reconcile.js";
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
function serve(pages: Pages): Promise<{ server: Server; port: number }> {
    const server = createServer((req, res) => {
        const body = pages[req.url ?? "/"];
        res.writeHead(body === undefined ? 404 : 200, { "Content-Type": req.url === "/robots.txt" ? "text/plain" : "text/html" });
        res.end(body ?? "not found");
    });
    return new Promise((r) => server.listen(0, "127.0.0.1", () => r({ server, port: (server.address() as { port: number }).port })));
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
        "tunde@brandfour.ng": "valid",
        "glowbysade@gmail.com": "valid",
    };
    const hunterByDomain: Record<string, unknown[]> = {
        "brandfour.ng": [
            { value: "tunde@brandfour.ng", type: "personal", confidence: 94, sources: [{ uri: "https://x" }] },
            { value: "pattern.guess@brandfour.ng", type: "personal", confidence: 40, sources: [] },
            { value: "someone@other.com", type: "personal", confidence: 90, sources: [{}] },
        ],
    };
    // name -> listed website
    const sites: Record<string, string> = {};

    before(async () => {
        dir = mkdtempSync(join(tmpdir(), "lead-scout-contacts-"));
        const defs: Record<string, Pages> = {
            "brandone.ng": {
                "/robots.txt": "User-agent: *\nAllow: /",
                "/": "<h1>Brand One</h1>",
                "/contact": '<a href="mailto:info@brandone.ng?subject=Order">Email</a><footer>Site by dev@agency.io</footer><script>x="a@sentry.io"</script>',
            },
            "brandtwo.ng": {
                "/": '<a href="https://wa.me/2348099999999">Chat on WhatsApp</a>',
                "/about": "<p>Write to ade.okafor@brandtwo.ng</p>",
            },
            "brandthree.ng": { "/": "<h1>Three</h1>", "/contact-us": `<span data-cfemail="${cf("sales@brandthree.ng")}">[email protected]</span>` },
            "brandfour.ng": { "/": "<h1>Four</h1><p>Made by hello@webagency.ng</p>" },
            "glow.ng": { "/": "<p>Orders: glowbysade@gmail.com</p>" },
            "low.ng": { "/": '<a href="mailto:hi@low.ng">x</a>' },
            "private.ng": { "/robots.txt": "User-agent: *\nDisallow: /", "/": '<a href="mailto:hidden@private.ng">x</a>' },
        };
        for (const [host, pages] of Object.entries(defs)) {
            const s = await serve(pages);
            servers.push(s.server);
            overrideHost(host, "127.0.0.1");
            sites[host] = `http://${host}:${s.port}/`;
        }
        sites["brand.bumpa.shop"] = "https://brand.bumpa.shop/"; // hosted storefront: never contacted

        globalThis.fetch = (async (input: string | URL) => {
            const url = new URL(String(input));
            calls.push(url.hostname);
            if (url.hostname === "api.hunter.io") return Response.json({ data: { emails: hunterByDomain[url.searchParams.get("domain")!] ?? [] } });
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
        for (const host of Object.keys(sites)) overrideHost(host, null);
        rmSync(dir, { recursive: true, force: true });
        delete process.env.HUNTER_API_KEY;
        delete process.env.ZEROBOUNCE_API_KEY;
    });

    const baseConfig = {
        country: "Nigeria", country_code: "NG", city: "Lagos", radius_km: 10, language: "en", currency: "NGN",
        search_keywords: ["fashion"], timezone: "Africa/Lagos", legal_basis: "B2B legitimate interest; opt-out included.",
    };
    const approve = async () => true;
    const opts: ContactOptions = { minScore: 60, recontact: false, maxVerify: 3, perHostDelayMs: 0, userAgentToken: "LeadScoutTest", timeoutMs: 5000, confirm: approve };
    const paid = () => calls.filter((h) => h === "api.hunter.io" || h === "api.zerobounce.net").length;

    function seed(store: LeadStore) {
        const ids: Record<string, number> = {};
        const phones: Record<string, string> = { "brandtwo.ng": "0803 123 4567" };
        const reviews: Record<string, number> = { "brandone.ng": 12, "brandthree.ng": 300 };
        for (const [host, url] of Object.entries(sites)) {
            const site = parseWebsite(url)!;
            const { id } = store.upsertLead({
                name: host, category: "fashion", address: null, phone: phones[host] ?? null, website_url: site.href,
                website_domain: websiteDomain(site), source: "test", source_ref: host, dedupe_key: dedupeKey(host, null, site), country: "NG",
                user_ratings_total: reviews[host] ?? null,
            });
            ids[host] = id;
            const hasStore = host === "low.ng"; // scores 5: below the threshold
            store.saveAudit({
                lead_id: id, audited_at: "2026-01-01T00:00:00Z", status: "ok", requested_url: site.href, final_url: site.href,
                http_status: 200, load_time_ms: 900, load_timed_out: false, lighthouse_score: null, lighthouse_error: null,
                platform: "custom", platform_signal: "no known platform signature matched", has_cart: hasStore, has_checkout: hasStore,
                cart_signal: null, payment_providers: "[]", link_in_bio_only: false, link_in_bio_host: null, whatsapp_links: 0,
                whatsapp_order_only: false, ssl: "valid", ssl_detail: null, local_currency_seen: false, screenshot_path: null, error: null,
                password_protected: false, password_signal: null, commerce_pages: "[]", unreachable_runs: 0, audit_version: 2,
            } satisfies AuditRecord);
        }
        return ids;
    }
    const resultOf = (store: LeadStore, id: number) => store.contactResults().find((r) => r.lead.id === id)?.result;

    it("finds, verifies, queues and falls back, owned sites only", async () => {
        process.env.HUNTER_API_KEY = "h";
        process.env.ZEROBOUNCE_API_KEY = "z";
        const config = resolveConfig({ ...baseConfig, allowed_to_email: true });
        const store = new LeadStore(join(dir, "a.db"));
        const ids = seed(store);

        const s = await runContacts(store, config, opts);
        assert.equal(s.skipped, 1, "the hosted storefront is skipped");
        assert.deepEqual([s.processed, s.email, s.fallback, s.failed], [6, 4, 2, 0], "the 'low' lead is under the threshold");
        assert.deepEqual(s.plan, { leads: 6, hunterCalls: 2, hunterCached: 0, zeroBounceCalls: 4, zeroBounceCached: 0, zeroBounceUpTo: 6 });

        const one = resultOf(store, ids["brandone.ng"]!)!;
        assert.deepEqual([one.email, one.email_type, one.email_source], ["info@brandone.ng", "role", "mailto"]);
        assert.match(one.contact_evidence!, /ignored 1 address\(es\) at other domains \(dev@agency\.io\)/);

        const two = resultOf(store, ids["brandtwo.ng"]!)!;
        assert.equal(two.outcome, "fallback", "only email was invalid");
        assert.equal(two.channel_value, "https://wa.me/2348099999999", "site's own WhatsApp link wins over the phone");
        assert.match(two.reason!, /ade\.okafor@brandtwo\.ng: invalid/);

        const three = resultOf(store, ids["brandthree.ng"]!)!;
        assert.deepEqual([three.email, three.verification_status], ["sales@brandthree.ng", "catch-all"]);
        assert.match(three.risk_flag!, /catch-all/);

        const four = resultOf(store, ids["brandfour.ng"]!)!;
        assert.deepEqual([four.email, four.email_source, four.email_type], ["tunde@brandfour.ng", "hunter", "personal"], "agency address ignored, so Hunter ran");
        const fourContacts = store.db.prepare("SELECT email FROM contacts WHERE lead_id = ?").all(ids["brandfour.ng"]!) as { email: string }[];
        assert.deepEqual(fourContacts.map((c) => c.email), ["tunde@brandfour.ng"], "sourceless and other-domain Hunter results dropped");

        const glow = resultOf(store, ids["glow.ng"]!)!;
        assert.equal(glow.email, "glowbysade@gmail.com", "free-provider address is allowed...");
        assert.match(glow.risk_flag!, /free mailbox \(gmail\.com\)/, "...but flagged");

        assert.equal(resultOf(store, ids["private.ng"]!)!.outcome, "fallback");
        assert.equal(resultOf(store, ids["brand.bumpa.shop"]!), undefined);

        // Re-run with --recontact: everything is cached, so no paid call and no question asked.
        assert.equal(paid(), 7, "first run: 2 Hunter + 5 ZeroBounce (4 site addresses + 1 from Hunter)");
        calls = [];
        let asked = false;
        const again = await runContacts(store, config, { ...opts, recontact: true, confirm: async () => (asked = true) });
        assert.equal(paid(), 0);
        assert.equal(asked, false);
        assert.deepEqual(again.plan, { leads: 0, hunterCalls: 0, hunterCached: 2, zeroBounceCalls: 0, zeroBounceCached: 5, zeroBounceUpTo: 0 });
        assert.equal(store.contactResults().length, 6, "no duplicate rows");

        // Queues, ordered by score then review count.
        const q = { email: join(dir, "email_queue.csv"), fallback: join(dir, "fallback_queue.csv") };
        exportCsv(store, join(dir, "leads.csv"));
        assert.deepEqual(exportQueues(store, config, q), { email: 4, fallback: 2 });
        const emailCsv = readFileSync(q.email, "utf8").trim().split("\r\n");
        assert.equal(emailCsv[0], "name,email,email_type,verification_status,evidence,lead_score,country,risk_flag,email_source,website,timezone,send_window,legal_basis");
        assert.ok(emailCsv[1]!.startsWith("brandthree.ng,"), "300 reviews beats 12 at the same score");
        assert.ok(!readFileSync(q.email, "utf8").includes("ade.okafor@brandtwo.ng"), "invalid addresses never queued");
        assert.match(readFileSync(q.fallback, "utf8"), /https:\/\/wa\.me\/2348099999999/);

        // Turning email off for the region moves everyone to the fallback queue at export.
        const off = resolveConfig({ ...baseConfig, allowed_to_email: false });
        assert.deepEqual(exportQueues(store, off, q), { email: 0, fallback: 6 });
        assert.match(readFileSync(q.fallback, "utf8"), /email not permitted for region NG/);
        store.close();
    });

    it("asks before paid calls; declining or a dry run spends nothing", async () => {
        process.env.HUNTER_API_KEY = "h";
        process.env.ZEROBOUNCE_API_KEY = "z";
        const config = resolveConfig({ ...baseConfig, allowed_to_email: true });
        const store = new LeadStore(join(dir, "confirm.db"));
        seed(store);

        const dry = await runContacts(store, config, { ...opts, dryRun: true });
        assert.equal(dry.plan!.hunterCalls + dry.plan!.zeroBounceCalls, 6);
        assert.equal(store.contactResults().length, 0, "dry run saves nothing");

        const declined = await runContacts(store, config, { ...opts, confirm: async () => false });
        assert.equal(paid(), 0, "no paid call after a no");
        assert.equal(declined.deferred, 6, "every eligible lead needs a paid call here");
        assert.equal(declined.processed, 0);
        assert.equal(store.contactResults().length, 0, "deferred leads get no result, so they stay pending");

        const approved = await runContacts(store, config, opts);
        assert.equal(approved.processed, 6, "deferred leads are picked up next time");
        store.close();
    });

    it("blocks email entirely when the region disallows it, without calling paid APIs", async () => {
        process.env.HUNTER_API_KEY = "h";
        process.env.ZEROBOUNCE_API_KEY = "z";
        const store = new LeadStore(join(dir, "b.db"));
        seed(store);
        const s = await runContacts(store, resolveConfig({ ...baseConfig, allowed_to_email: false }), opts);
        assert.deepEqual([s.email, s.fallback], [0, 6]);
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
        const one = resultOf(store, ids["brandone.ng"]!)!;
        assert.match(one.reason!, /info@brandone\.ng: not verified/);
        assert.equal(one.channel, "none", "no phone and no WhatsApp link on the site");
        store.close();
    });

    it("reconcile invalidates results that break the current rules and reports why", async () => {
        const store = new LeadStore(join(dir, "r.db"));
        const ids = seed(store);
        const config = resolveConfig({ ...baseConfig, allowed_to_email: true });
        // Results as an older version could have stored them.
        const old = (id: number, email: string, extra: Partial<ContactResult> = {}) => {
            store.saveContactResult({
                lead_id: id, processed_at: "2026-01-01", outcome: "email", email, email_type: "role", email_source: "page_text",
                verification_status: "valid", risk_flag: null, channel: "none", channel_value: null, channel_note: null,
                reason: null, contact_evidence: `${email} found`, error: null, ...extra,
            });
            store.replaceContacts(id, [{ email, email_source: "page_text", source_detail: null, email_type: "role", own_domain: false }]);
        };
        old(ids["brandone.ng"]!, "dev@agency.io"); // other business's domain
        old(ids["glow.ng"]!, "glowbysade@gmail.com"); // free provider: keep, flag
        old(ids["brandthree.ng"]!, "sales@brandthree.ng"); // fine
        old(ids["brand.bumpa.shop"]!, "shop@bumpa.shop"); // not an owned site

        const report = reconcileContacts(store);
        assert.deepEqual(report.notOwnedSite, { hosted_storefront: { results: 1, emails: 1 } });
        assert.deepEqual(report.domainMismatch.map((m) => m.email), ["dev@agency.io"]);
        assert.deepEqual(report.freeProviderFlagged.map((f) => f.email), ["glowbysade@gmail.com"]);
        const text = formatReconcileReport(report);
        assert.match(text, /Emails invalidated: 2/);
        assert.match(text, /website is hosted_storefront/);
        assert.match(text, /email domain does not match the lead's own site: 1/);

        assert.equal(resultOf(store, ids["brandone.ng"]!), undefined, "invalidated lead is re-processed next run");
        assert.match(resultOf(store, ids["glow.ng"]!)!.risk_flag!, /free mailbox/);
        assert.equal(reconcileContacts(store).domainMismatch.length, 0, "reconcile is idempotent");

        const q = { email: join(dir, "r_email.csv"), fallback: join(dir, "r_fallback.csv") };
        assert.deepEqual(exportQueues(store, config, q), { email: 2, fallback: 0 });
        store.close();
    });
});
