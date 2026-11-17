import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { createTransport } from "nodemailer";
import { SMTPServer } from "smtp-server";
import { ingestActions } from "../src/agent/actions.js";
import { loadRegions, runScout } from "../src/agent/index.js";
import { resolveConfig } from "../src/config.js";
import { LeadStore, type ContactResult } from "../src/db.js";
import { exportCsv } from "../src/export.js";
import { loadOutreachConfig } from "../src/outreach/config.js";
import { runDraft } from "../src/outreach/draft.js";
import { runSend } from "../src/outreach/send.js";
import { countryCodeFromName, currencyFor, defaultSendDays, ensureRegion, paymentExamples, radiusFromViewport, resolvePlace, regionConfig, timezoneFor, type ResolvedPlace } from "../src/regions.js";
import { dedupeKey, parseWebsite, websiteDomain } from "../src/url.js";

const base = resolveConfig({
    country: "Nigeria", country_code: "NG", city: "Lagos", radius_km: 25, language: "en", currency: "NGN",
    search_keywords: ["fashion", "skincare"], timezone: "Africa/Lagos", allowed_to_email: true, legal_basis: "NG note",
    payment_providers: ["Paystack", "Flutterwave"],
});
const outreach = () => {
    const c = loadOutreachConfig(join(import.meta.dirname, "..", "config", "outreach.json"));
    c.sender.name = "Ada Test";
    return c;
};
const dubai: ResolvedPlace = { placeRef: "place-dubai", city: "Dubai", country: "United Arab Emirates", countryCode: "AE", lat: 25.2048, lng: 55.2708, radiusKm: 30 };
const fakeResolve = async (text: string) => {
    if (/dubai/i.test(text)) return dubai;
    throw new Error(`Couldn't find a place called "${text}"`);
};

describe("region details from a place", () => {
    it("works out timezone, currency, work week and payment wording", () => {
        assert.equal(timezoneFor(25.2048, 55.2708), "Asia/Dubai");
        assert.equal(timezoneFor(30.27, -97.74), "America/Chicago");
        assert.equal(currencyFor("AE"), "AED");
        assert.equal(currencyFor("GB"), "GBP");
        assert.equal(defaultSendDays("SA"), "Sun-Thu");
        assert.equal(defaultSendDays("AE"), "Mon-Fri");
        assert.equal(paymentExamples("NG"), "Paystack or Flutterwave");
        assert.equal(paymentExamples("AE"), "Stripe, Telr or Tabby");
        assert.equal(paymentExamples("FR"), "Stripe or PayPal");
    });

    it("sizes the search from the place's viewport", () => {
        const city = { low: { latitude: 24.79, longitude: 54.89 }, high: { latitude: 25.36, longitude: 55.56 } }; // ~Dubai
        assert.equal(radiusFromViewport(city), 46, "half the diagonal");
        const wide = { low: { latitude: 24.0, longitude: 54.0 }, high: { latitude: 26.0, longitude: 56.5 } };
        assert.equal(radiusFromViewport(wide), 50, "capped at 50 km");
        const town = { low: { latitude: 6.45, longitude: 3.38 }, high: { latitude: 6.47, longitude: 3.40 } };
        assert.equal(radiusFromViewport(town), 3, "at least 3 km");
    });

    it("knows country names", () => {
        assert.equal(countryCodeFromName("Ireland"), "IE");
        assert.equal(countryCodeFromName(" republic of ireland "), "IE");
        assert.equal(countryCodeFromName("United Arab Emirates"), "AE");
        assert.equal(countryCodeFromName("gh"), "GH");
        assert.equal(countryCodeFromName("Atlantis"), null);
    });

    it("resolves a whole country even when Google leaves out the country part", async () => {
        const realFetch = globalThis.fetch;
        // What Places returns for "ireland": a country with no country address component.
        globalThis.fetch = (async () =>
            new Response(
                JSON.stringify({
                    places: [
                        {
                            id: "ChIJ-ireland",
                            displayName: { text: "Ireland" },
                            types: ["country", "political"],
                            location: { latitude: 53.41, longitude: -8.24 },
                            viewport: { low: { latitude: 51.42, longitude: -10.66 }, high: { latitude: 55.43, longitude: -5.99 } },
                            addressComponents: [],
                        },
                    ],
                }),
            )) as typeof fetch;
        try {
            const p = await resolvePlace("ireland", "k");
            assert.equal(p.countryCode, "IE");
            assert.equal(p.country, "Ireland");
            assert.ok(p.radiusKm > 200, `a country is searched across, not 50 km around its middle (got ${p.radiusKm})`);
        } finally {
            globalThis.fetch = realFetch;
        }
    });
});

describe("regions in the store", () => {
    it("keeps existing Lagos leads as region #1 and adds new places with email off", async () => {
        const store = new LeadStore(":memory:");
        const site = parseWebsite("https://lagosbrand.ng/")!;
        store.upsertLead({ name: "Old Lead", category: "fashion", address: null, phone: null, website_url: site.href, website_domain: websiteDomain(site), source: "google_places", source_ref: "old", dedupe_key: dedupeKey("x", null, site), country: "NG" });

        const lagos = store.regions.ensureDefault(base);
        assert.equal(lagos.allowed_to_email, 1, "Lagos keeps its setting");
        assert.equal(store.allLeadsWithAudits()[0]!.lead.region_id, lagos.id, "old leads join Lagos");
        assert.equal(store.regions.ensureDefault(base).id, lagos.id, "idempotent");

        const { region, created } = await ensureRegion(store.regions, "  Dubai ", { apiKey: "", language: "en", resolve: fakeResolve });
        assert.ok(created);
        assert.deepEqual(
            [region.label, region.country_code, region.timezone, region.currency, region.send_days, region.allowed_to_email],
            ["Dubai", "AE", "Asia/Dubai", "AED", "Mon-Fri", null],
            "email starts off (null) for a new country",
        );
        let calls = 0;
        const counting = async (t: string) => (calls++, fakeResolve(t));
        assert.equal((await ensureRegion(store.regions, "dubai", { apiKey: "", language: "en", resolve: counting })).created, false);
        assert.equal(calls, 0, "same name: no Google call");
        assert.equal((await ensureRegion(store.regions, "Dubai, UAE", { apiKey: "", language: "en", resolve: counting })).region.id, region.id, "same place, different words");
        await assert.rejects(ensureRegion(store.regions, "Nowhereville", { apiKey: "", language: "en", resolve: fakeResolve }), /Couldn't find/);

        const cfg = regionConfig(base, store.regions.get(region.id)!);
        assert.equal(cfg.city, "Dubai");
        assert.equal(cfg.allowed_to_email, null);
        assert.ok(cfg.payment_providers.some((p) => p.name === "Telr"), "local providers detected");
        assert.ok(cfg.payment_providers.some((p) => p.name === "Paystack"), "configured ones kept");
        store.close();
    });
});

describe("scouting a place end to end (Google mocked)", { timeout: 120_000 }, () => {
    const realFetch = globalThis.fetch;
    let dir: string;
    const queries: string[] = [];

    before(() => {
        dir = mkdtempSync(join(tmpdir(), "lead-scout-regions-"));
        process.env.GOOGLE_PLACES_API_KEY = "test";
        globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.includes("places:searchText")) {
                const body = JSON.parse(String(init?.body ?? "{}")) as { textQuery: string; pageToken?: string };
                queries.push(body.textQuery);
                const kw = body.textQuery.split(" in ")[0]!;
                return Response.json({
                    places: [
                        { id: `${kw}-1`, displayName: { text: `${kw} House Dubai` }, formattedAddress: "Al Barsha, Dubai", internationalPhoneNumber: "+971 50 123 4567", location: { latitude: 25.11, longitude: 55.2 }, userRatingCount: 40, businessStatus: "OPERATIONAL" },
                        { id: `${kw}-2`, displayName: { text: `${kw} Insta Dubai` }, formattedAddress: "Deira, Dubai", internationalPhoneNumber: "+971 4 123 4567", websiteUri: `https://instagram.com/${kw}dxb`, location: { latitude: 25.27, longitude: 55.3 }, userRatingCount: 12, businessStatus: "OPERATIONAL" },
                        { id: `${kw}-far`, displayName: { text: "Abu Dhabi shop" }, location: { latitude: 24.45, longitude: 54.38 } },
                    ],
                });
            }
            throw new Error(`unexpected fetch ${url}`);
        }) as typeof fetch;
    });
    after(() => {
        globalThis.fetch = realFetch;
        delete process.env.GOOGLE_PLACES_API_KEY;
        rmSync(dir, { recursive: true, force: true });
    });

    it("finds leads for the place and drafts WhatsApp only (email off for a new country)", async () => {
        const store = new LeadStore(join(dir, "leads.db"));
        const cfg = outreach();
        const opts = {
            stateDir: dir,
            audit: { reaudit: false, lighthouse: false, timeoutMs: 5000, perHostDelayMs: 0, screenshotsDir: join(dir, "shots"), userAgentToken: "LeadScoutTest" },
            contacts: { minScore: 60, recontact: false, maxVerify: 1, perHostDelayMs: 0, userAgentToken: "LeadScoutTest", timeoutMs: 5000 },
            discover: true,
        };
        const steps = await runScout(store, base, cfg, opts, "Dubai", ["perfume", "abayas"], fakeResolve);
        assert.ok(steps.every((s) => s.ok), JSON.stringify(steps));
        assert.match(steps.find((s) => s.step === "region")!.detail, /Dubai, United Arab Emirates \(AE\).*Asia\/Dubai, AED, email off/);
        assert.deepEqual(queries, ["perfume in Dubai", "abayas in Dubai"], "searched the region's own keywords, in Dubai");

        const leads = store.allLeadsWithAudits().map((r) => r.lead);
        assert.equal(leads.length, 4, "the Abu Dhabi result is outside the radius");
        const dubaiId = store.regions.findByLabel("Dubai")!.id;
        assert.ok(leads.every((l) => l.region_id === dubaiId && l.country === "AE"));

        const chats = store.outreach.list("channel IN ('whatsapp', 'phone')");
        assert.ok(chats.length >= 2);
        const noSite = chats.find((c) => /House Dubai/.test(store.allLeadsWithAudits().find((x) => x.lead.id === c.lead_id)!.lead.name))!;
        assert.equal(noSite.recipient, "https://wa.me/971501234567", "UAE mobile becomes a WhatsApp link");
        assert.equal(store.outreach.list("channel = 'email'").length, 0, "no email drafted while email is off");

        const snap = JSON.parse(readFileSync(join(dir, "dashboard.json"), "utf8"));
        assert.deepEqual(snap.regions.map((r: { label: string }) => r.label), ["Lagos", "Dubai"]);
        assert.equal(snap.regions[1].allowed_to_email, null);
        assert.equal(snap.leads[0].region, "Dubai");
        assert.match(readFileSync(join(dir, "output", "fallback_queue.csv"), "utf8"), /,Dubai\r\n/);
        store.close();
    });

    it("sends each region's emails only when that region allows it, in its own hours", async () => {
        const received: string[] = [];
        const server = new SMTPServer({ authOptional: true, disabledCommands: ["STARTTLS"], onData(s, session, cb) { s.on("data", () => {}); s.on("end", () => { received.push(session.envelope.rcptTo[0]!.address); cb(); }); } });
        await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
        const port = (server.server.address() as { port: number }).port;
        try {
            const store = new LeadStore(":memory:");
            store.regions.ensureDefault(base);
            const { region: dxb } = await ensureRegion(store.regions, "Dubai", { apiKey: "", language: "en", resolve: fakeResolve });
            const add = (name: string, regionId: number, country: string, email: string) => {
                const site = parseWebsite(`https://${name}.com/`)!;
                const { id } = store.upsertLead({ name, category: "fashion", address: null, phone: null, website_url: site.href, website_domain: websiteDomain(site), source: "t", source_ref: name, dedupe_key: dedupeKey(name, null, site), country, region_id: regionId });
                store.saveAudit({ lead_id: id, audited_at: "x", status: "ok", requested_url: site.href, final_url: site.href, http_status: 200, load_time_ms: 9000, load_timed_out: false, lighthouse_score: null, lighthouse_error: null, platform: "custom", platform_signal: "none", has_cart: false, has_checkout: false, cart_signal: null, payment_providers: "[]", link_in_bio_only: false, link_in_bio_host: null, whatsapp_links: 0, whatsapp_order_only: false, ssl: "valid", ssl_detail: null, local_currency_seen: false, screenshot_path: null, error: null, password_protected: false, password_signal: null, commerce_pages: "[]", unreachable_runs: 0, audit_version: 2 });
                store.saveContactResult({ lead_id: id, processed_at: "x", outcome: "email", email, email_type: "role", email_source: "mailto", verification_status: "valid", risk_flag: null, channel: "none", channel_value: null, channel_note: null, reason: null, contact_evidence: "found", error: null } satisfies ContactResult);
            };
            const lagosId = store.regions.findByLabel("Lagos")!.id;
            add("lagosbrand", lagosId, "NG", "hi@lagosbrand.com");
            add("dubaibrand", dxb.id, "AE", "hi@dubaibrand.com");
            exportCsv(store, join(mkdtempSync(join(tmpdir(), "ls-")), "l.csv"));

            const cfg = outreach();
            // Email off in Dubai: only the Lagos email is drafted.
            let d = runDraft(store, loadRegions(store, base), cfg);
            assert.equal(d.emailDrafts, 1);
            const lagosMsg = store.outreach.list("channel = 'email'")[0]!;
            assert.match(lagosMsg.body, /Lagos/);

            // Turn email on for Dubai (as the dashboard would), approve, and draft again.
            const actions = join(mkdtempSync(join(tmpdir(), "ls-act-")), "actions");
            mkdirSync(actions);
            writeFileSync(join(actions, "1.json"), JSON.stringify({ id: "r1", at: "2026-11-16T08:00:00Z", type: "set_region_email", region_id: dxb.id, allowed: true }));
            writeFileSync(join(actions, "2.json"), JSON.stringify({ id: "a1", at: "2026-11-16T08:01:00Z", type: "approve_batch", batch_id: d.batchId, items: [{ id: lagosMsg.id, approve: true }] }));
            ingestActions(store, cfg, actions);
            d = runDraft(store, loadRegions(store, base), cfg);
            assert.equal(d.emailDrafts, 1, "Dubai's email drafted once email is on");
            const dubaiMsg = store.outreach.list("channel = 'email' AND status = 'draft'")[0]!;
            assert.match(dubaiMsg.body, /Dubai/);
            writeFileSync(join(actions, "3.json"), JSON.stringify({ id: "a2", at: "2026-11-16T08:02:00Z", type: "approve_batch", batch_id: d.batchId, items: [{ id: dubaiMsg.id, approve: true }] }));
            ingestActions(store, cfg, actions);

            // 07:30 UTC Monday = 08:30 Lagos (closed), 11:30 Dubai (open): only Dubai goes.
            const transport = createTransport({ host: "127.0.0.1", port, secure: false, ignoreTLS: true });
            await runSend(store, loadRegions(store, base), cfg, { transport, from: "me@studio.ng", now: () => new Date("2026-11-16T07:30:00Z"), sleep: async () => {} });
            assert.deepEqual(received, ["hi@dubaibrand.com"]);
            // 13:00 UTC = 14:00 Lagos: Lagos goes.
            await runSend(store, loadRegions(store, base), cfg, { transport, from: "me@studio.ng", now: () => new Date("2026-11-16T13:00:00Z"), sleep: async () => {} });
            assert.deepEqual(received, ["hi@dubaibrand.com", "hi@lagosbrand.com"]);
            store.close();
        } finally {
            server.close();
        }
    });
});
