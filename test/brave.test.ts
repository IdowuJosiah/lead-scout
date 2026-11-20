import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { resolveConfig } from "../src/config.js";
import { LeadStore } from "../src/db.js";
import { BraveSearchSource, instagramLinksInHtml, ownSiteInText, phoneFromText, profileFromResult } from "../src/discovery/brave.js";
import { runDiscovery } from "../src/discovery/index.js";
import { exportCsv } from "../src/export.js";
import { loadOutreachConfig } from "../src/outreach/config.js";
import { runDraft } from "../src/outreach/draft.js";
import { setOwnWebsitesInScope } from "../src/websiteClass.js";
import { join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const region = resolveConfig({
    country: "Nigeria", country_code: "NG", city: "Lagos", radius_km: 10, language: "en", currency: "NGN",
    search_keywords: ["fashion"], timezone: "Africa/Lagos", allowed_to_email: false, legal_basis: "test",
    sources: ["brave_search"], source_options: { brave_search: { networks: ["instagram", "tiktok"], blog_pages: 1 } },
});

describe("Brave Search source: parsing", () => {
    it("reads name and handle from profile results, and skips posts and pages that aren't businesses", () => {
        assert.deepEqual(profileFromResult({ url: "https://www.instagram.com/adascloset/", title: "Ada's Closet (@adascloset) • Instagram photos and videos" }), {
            network: "instagram", handle: "adascloset", url: "https://www.instagram.com/adascloset", name: "Ada's Closet",
        });
        assert.equal(profileFromResult({ url: "https://www.tiktok.com/@kemi.styles", title: "Kemi Styles (@kemi.styles) | TikTok" })?.name, "Kemi Styles");
        assert.equal(profileFromResult({ url: "https://www.facebook.com/LagosThreads/", title: "Lagos Threads | Lagos | Facebook" })?.name, "Lagos Threads");
        assert.equal(profileFromResult({ url: "https://www.instagram.com/p/C1abc/", title: "post" }), null, "a post, not a profile");
        assert.equal(profileFromResult({ url: "https://www.instagram.com/explore/tags/lagos/", title: "x" }), null);
        assert.equal(profileFromResult({ url: "https://www.tiktok.com/tag/fashion", title: "x" }), null);
        assert.equal(profileFromResult({ url: "https://example.com/blog", title: "x" }), null);
    });

    it("pulls a local phone number and spots an own website in the bio", () => {
        assert.equal(phoneFromText("Ready to wear 🇳🇬 Lagos | WhatsApp 0803 123 4567 | DM to order", "NG"), "+234 803 123 4567");
        assert.equal(phoneFromText("no number here", "NG"), null);
        assert.equal(ownSiteInText("Shop now: www.adascloset.com.ng 🛍️"), "https://www.adascloset.com.ng/");
        assert.equal(ownSiteInText("links: linktr.ee/adas and instagram.com/adas"), null, "social and link-in-bio aren't websites of their own");
    });

    it("collects Instagram profiles linked from an article", () => {
        const html = `<a href="https://www.instagram.com/shopkemi/">Kemi</a> <a href='https://instagram.com/tola.bags?igsh=1'>Tola</a>
            <a href="https://www.instagram.com/p/xyz/">a post</a> <a href="https://www.instagram.com/shopkemi">again</a>`;
        assert.deepEqual(instagramLinksInHtml(html), ["shopkemi", "tola.bags"]);
    });
});

describe("Brave Search source: end to end (API mocked)", () => {
    const realFetch = globalThis.fetch;
    const queries: string[] = [];
    before(() => {
        process.env.BRAVE_API_KEY = "test-key";
        globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
            const url = new URL(String(input));
            if (url.hostname === "api.search.brave.com") {
                assert.equal((init?.headers as Record<string, string>)["X-Subscription-Token"], "test-key");
                const q = url.searchParams.get("q")!;
                queries.push(q);
                if (q.startsWith("site:instagram.com")) {
                    return Response.json({
                        web: {
                            results: [
                                { url: "https://www.instagram.com/adascloset/", title: "Ada's Closet (@adascloset) • Instagram photos and videos", description: "2,140 Followers - Lagos ready-to-wear. WhatsApp 0803 123 4567" },
                                { url: "https://www.instagram.com/brandwithsite/", title: "Brand With Site (@brandwithsite)", description: "Lagos fashion. Shop at www.brandwithsite.com" },
                                { url: "https://www.instagram.com/londonlabel/", title: "London Label (@londonlabel)", description: "Shoreditch, London" },
                            ],
                        },
                    });
                }
                if (q.startsWith("site:tiktok.com")) {
                    return Response.json({ web: { results: [{ url: "https://www.tiktok.com/@kemistyles", title: "Kemi Styles (@kemistyles) | TikTok", description: "Lagos thrift and styling" }] } });
                }
                return Response.json({ web: { results: [{ url: "https://blog.example/best-lagos-boutiques", title: "10 best boutiques in Lagos" }] } });
            }
            if (url.href === "https://blog.example/robots.txt") return new Response("User-agent: *\nAllow: /\n");
            if (url.href === "https://blog.example/best-lagos-boutiques") {
                return new Response(`<a href="https://www.instagram.com/tola.bags/">Tola</a><a href="https://www.instagram.com/adascloset/">Ada</a>`, { headers: { "content-type": "text/html" } });
            }
            throw new Error(`unexpected fetch ${url}`);
        }) as typeof fetch;
    });
    after(() => {
        globalThis.fetch = realFetch;
        delete process.env.BRAVE_API_KEY;
    });

    it("finds social-only businesses, merges duplicates, leaves out websites, and drafts DMs or WhatsApp", async () => {
        const store = new LeadStore(":memory:");
        const d = await runDiscovery(store, region);
        assert.equal(d.failures, 0);
        assert.deepEqual(queries, ["site:instagram.com fashion Lagos", "site:tiktok.com fashion Lagos", "best fashion in Lagos instagram"]);
        const leads = store.allLeadsWithAudits().map((r) => r.lead);
        const names = leads.map((l) => l.name).sort();
        assert.deepEqual(names, ["@tola.bags", "Ada's Closet", "Brand With Site", "Kemi Styles"], "London profile dropped; Ada found twice, stored once");
        assert.equal(leads.find((l) => l.name === "Ada's Closet")!.phone, "+234 803 123 4567");

        setOwnWebsitesInScope(false);
        try {
            exportCsv(store, join(mkdtempSync(join(tmpdir(), "ls-brave-")), "leads.csv"));
            const cfg = loadOutreachConfig(join(import.meta.dirname, "..", "config", "outreach.json"));
            cfg.sender.name = "Ada Test";
            const s = runDraft(store, region, cfg);
            const rows = store.outreach.list();
            const by = (name: string) => rows.find((r) => r.lead_id === leads.find((l) => l.name === name)!.id);
            assert.equal(by("Ada's Closet")?.channel, "whatsapp", "a mobile number in the bio means WhatsApp");
            assert.equal(by("Kemi Styles")?.channel, "social", "no number: a DM on their profile");
            assert.equal(by("Kemi Styles")?.recipient, "https://www.tiktok.com/@kemistyles");
            assert.equal(by("Brand With Site"), undefined, "a website in the bio puts them out of scope");
            assert.ok(s.socialDrafts >= 1);
        } finally {
            setOwnWebsitesInScope(true);
            store.close();
        }
    });

    it("does nothing (and calls nothing) without an API key", async () => {
        delete process.env.BRAVE_API_KEY;
        const before = queries.length;
        const store = new LeadStore(":memory:");
        const found: unknown[] = [];
        for await (const l of new BraveSearchSource().discover("fashion", { config: region, options: {}, log: { info() {}, warn() {}, error() {}, debug() {} } as never })) found.push(l);
        assert.equal(found.length, 0);
        assert.equal(queries.length, before);
        store.close();
        process.env.BRAVE_API_KEY = "test-key";
    });
});
