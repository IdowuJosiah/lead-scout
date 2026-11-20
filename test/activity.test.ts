import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { judgeActivity, runActivityChecks } from "../src/activity.js";
import { LeadStore } from "../src/db.js";
import { runDraft } from "../src/outreach/draft.js";
import { resolveConfig } from "../src/config.js";
import { loadOutreachConfig } from "../src/outreach/config.js";
import { exportCsv } from "../src/export.js";
import { dedupeKey } from "../src/url.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const now = new Date("2026-11-20T00:00:00Z");
const ago = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

describe("is the business still active", () => {
    it("judges by Google's open state and the newest review", () => {
        assert.equal(judgeActivity({ businessStatus: "OPERATIONAL", reviewTimes: [ago(400), ago(30)] }, now).activity, "active");
        const old = judgeActivity({ businessStatus: "OPERATIONAL", reviewTimes: [ago(400), ago(250)] }, now);
        assert.equal(old.activity, "inactive");
        assert.match(old.note, /over 6 months ago/);
        assert.equal(judgeActivity({ businessStatus: "CLOSED_TEMPORARILY", reviewTimes: [ago(5)] }, now).activity, "inactive");
        assert.equal(judgeActivity({ businessStatus: "OPERATIONAL", reviewTimes: [] }, now).activity, "unknown");
    });

    it("checks only leads about to be contacted, caps paid calls, and keeps inactive ones out of drafts", async () => {
        const store = new LeadStore(":memory:");
        const add = (name: string, phone: string, reviews: number, source = "google_places") =>
            store.upsertLead({
                name, category: "fashion", address: `${name} st`, phone, website_url: null, website_domain: null, source, source_ref: `${name}-ref`,
                dedupe_key: dedupeKey(name, `${name} st`, null), country: "NG", user_ratings_total: reviews, business_status: "OPERATIONAL",
            }).id;
        const live = add("Live Boutique", "0803 111 2222", 30);
        const dead = add("Dead Boutique", "0803 333 4444", 12);
        const quiet = add("Quiet Boutique", "0803 555 6666", 0);
        const insta = add("Insta Boutique", "0803 777 8888", 0, "brave_search");
        exportCsv(store, join(mkdtempSync(join(tmpdir(), "ls-act-")), "leads.csv")); // score
        const calls: string[] = [];
        const fetchPlace = async (id: string) => {
            calls.push(id);
            return { businessStatus: "OPERATIONAL", reviewTimes: id.startsWith("Live") ? [ago(10)] : [ago(300)] };
        };
        const s = await runActivityChecks(store, { minScore: 60, apiKey: "k", fetchPlace, now });
        assert.deepEqual([s.active, s.inactive, s.unknown], [1, 1, 2]);
        assert.equal(calls.length, 2, "no paid call for a business with no reviews or found outside Google");
        assert.equal(store.outreach.usage("google_place_details"), 2);

        const again = await runActivityChecks(store, { minScore: 60, apiKey: "k", fetchPlace, now });
        assert.equal(again.checked, 0, "not re-checked within 30 days");

        const region = resolveConfig({ country: "Nigeria", country_code: "NG", city: "Lagos", radius_km: 10, language: "en", currency: "NGN", search_keywords: ["fashion"], timezone: "Africa/Lagos", allowed_to_email: true, legal_basis: "test" });
        const cfg = loadOutreachConfig(join(import.meta.dirname, "..", "config", "outreach.json"));
        cfg.sender.name = "Ada Test";
        runDraft(store, region, cfg, null, { requireActivityCheck: true });
        const drafted = new Set(store.outreach.list().map((r) => r.lead_id));
        assert.ok(drafted.has(live) && drafted.has(quiet) && drafted.has(insta), "active and not-yet-confirmed are drafted");
        assert.ok(!drafted.has(dead), "inactive business is never drafted");
        store.close();
    });

    it("checks businesses that already have an unsent draft, and withdraws it if they're inactive", async () => {
        const store = new LeadStore(":memory:");
        const id = store.upsertLead({ name: "Old Draft Co", category: "x", address: "1 rd", phone: "0803 999 0000", website_url: null, website_domain: null, source: "google_places", source_ref: "old", dedupe_key: "name:olddraft", country: "NG", user_ratings_total: 4 }).id;
        exportCsv(store, join(mkdtempSync(join(tmpdir(), "ls-act-")), "leads.csv"));
        const region = resolveConfig({ country: "Nigeria", country_code: "NG", city: "Lagos", radius_km: 10, language: "en", currency: "NGN", search_keywords: ["fashion"], timezone: "Africa/Lagos", allowed_to_email: true, legal_basis: "test" });
        const cfg = loadOutreachConfig(join(import.meta.dirname, "..", "config", "outreach.json"));
        cfg.sender.name = "Ada Test";
        runDraft(store, region, cfg); // drafted before activity checks existed
        assert.equal(store.outreach.forLead(id).length, 1);
        await runActivityChecks(store, { minScore: 0, apiKey: "k", now, fetchPlace: async () => ({ businessStatus: "OPERATIONAL", reviewTimes: [ago(700)] }) });
        const s = runDraft(store, region, cfg, null, { requireActivityCheck: true });
        assert.equal(s.withdrawn, 1);
        assert.equal(store.outreach.forLead(id).length, 0, "draft for an inactive business withdrawn");
        store.close();
    });

    it("stops paid lookups at the per-run cap", async () => {
        const store = new LeadStore(":memory:");
        for (let i = 0; i < 5; i++) {
            store.upsertLead({ name: `Shop ${i}`, category: "x", address: `${i} rd`, phone: "0803 000 000" + i, website_url: null, website_domain: null, source: "google_places", source_ref: `p${i}`, dedupe_key: `name:shop${i}`, country: "NG", user_ratings_total: 5 });
        }
        exportCsv(store, join(mkdtempSync(join(tmpdir(), "ls-act-")), "leads.csv"));
        let n = 0;
        const s = await runActivityChecks(store, { minScore: 0, apiKey: "k", limit: 2, now, fetchPlace: async () => (n++, { businessStatus: "OPERATIONAL", reviewTimes: [ago(1)] }) });
        assert.equal(n, 2);
        assert.equal(s.checked, 2);
        store.close();
    });
});
