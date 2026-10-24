import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PageSnapshot } from "../src/audit/detect.js";
import { countWhatsappLinks, detectCommerce, detectPaymentProviders, detectPlatform, localCurrencySeen } from "../src/audit/detect.js";
import { normalizeProvider, resolveConfig } from "../src/config.js";
import { LeadStore, type AuditRecord, type AuditRow } from "../src/db.js";
import { buildEvidence } from "../src/evidence.js";
import { csvCell } from "../src/export.js";
import { boundingBox, haversineKm } from "../src/discovery/googlePlaces.js";
import { compareLeads, scoreLead, priorityOf, WEIGHTS } from "../src/scoring.js";
import { classifyUrl, dedupeKey, parseWebsite } from "../src/url.js";

const snap = (o: Partial<PageSnapshot>): PageSnapshot => ({
    finalUrl: "https://shop.example/",
    html: "",
    headers: {},
    requestUrls: [],
    links: [],
    buttons: [],
    formActions: [],
    generator: null,
    text: "",
    ...o,
});

const audit = (o: Partial<AuditRow>): AuditRow => ({
    lead_id: 1,
    audited_at: "2026-01-01T00:00:00.000Z",
    status: "ok",
    requested_url: "https://shop.example/",
    final_url: "https://shop.example/",
    http_status: 200,
    load_time_ms: 1200,
    load_timed_out: 0,
    lighthouse_score: 95,
    lighthouse_error: null,
    platform: "Shopify",
    platform_signal: "requests to cdn.shopify.com",
    has_cart: 1,
    has_checkout: 1,
    cart_signal: "cart link /cart",
    payment_providers: JSON.stringify([{ name: "Paystack", signal: "request to js.paystack.co" }]),
    link_in_bio_only: 0,
    link_in_bio_host: null,
    whatsapp_links: 0,
    whatsapp_order_only: 0,
    ssl: "valid",
    ssl_detail: "served over HTTPS with a valid certificate",
    local_currency_seen: 1,
    screenshot_path: "output/screenshots/1-shop-example.png",
    error: null,
    password_protected: 0,
    password_signal: null,
    commerce_pages: "[]",
    unreachable_runs: 0,
    audit_version: 2,
    ...o,
});

describe("url", () => {
    it("parses bare domains and rejects junk", () => {
        assert.equal(parseWebsite("example.com")?.href, "https://example.com/");
        assert.equal(parseWebsite("http://Example.com/shop")?.hostname, "example.com");
        assert.equal(parseWebsite("not a url"), null);
        assert.equal(parseWebsite("mailto:a@b.com"), null);
        assert.equal(parseWebsite(""), null);
    });

    it("classifies social, link-in-bio and WhatsApp URLs", () => {
        assert.deepEqual(classifyUrl(new URL("https://www.instagram.com/brand")), { kind: "social", host: "instagram.com" });
        assert.deepEqual(classifyUrl(new URL("https://linktr.ee/brand")), { kind: "link_in_bio", host: "linktr.ee" });
        assert.equal(classifyUrl(new URL("https://wa.me/2348000000000")).kind, "messaging");
        assert.equal(classifyUrl(new URL("https://t.me/brand")).kind, "messaging");
        assert.equal(classifyUrl(new URL("https://brand.bumpa.shop")).kind, "hosted_storefront");
        assert.equal(classifyUrl(new URL("https://jiji.ng/shop/brand")).kind, "hosted_storefront");
        assert.equal(classifyUrl(new URL("https://brand.com")).kind, "owned_site");
    });

    it("dedupes by domain, but not across shared hosts", () => {
        assert.equal(dedupeKey("A", null, new URL("https://www.brand.com/x")), dedupeKey("B", "elsewhere", new URL("http://brand.com")));
        assert.notEqual(dedupeKey("A", null, new URL("https://instagram.com/a")), dedupeKey("B", null, new URL("https://instagram.com/b")));
        assert.notEqual(
            dedupeKey("A", null, new URL("https://api.whatsapp.com/send?phone=111")),
            dedupeKey("B", null, new URL("https://api.whatsapp.com/send?phone=222")),
        );
        assert.equal(dedupeKey("Ade's Wigs", "12 Allen Ave, Ikeja", null), dedupeKey("ADE'S  WIGS", "12 Allen Ave., Ikeja", null));
    });
});

describe("config", () => {
    const base = { country: "NG", city: "Lagos", radius_km: 10, language: "en", currency: "ngn", search_keywords: ["fashion"], payment_providers: ["Paystack"] };

    it("applies CLI overrides", () => {
        const c = resolveConfig(base, { city: "Abuja", radius_km: "5", keywords: "skincare, jewelry" });
        assert.equal(c.city, "Abuja");
        assert.equal(c.radius_km, 5);
        assert.deepEqual(c.search_keywords, ["skincare", "jewelry"]);
        assert.equal(c.currency, "NGN");
        assert.deepEqual(c.sources, ["google_places"]);
    });

    it("rejects invalid config", () => {
        assert.throws(() => resolveConfig({ ...base, radius_km: -1 }), /radius_km/);
        assert.throws(() => resolveConfig({ ...base, search_keywords: [] }), /search_keywords/);
        assert.throws(() => resolveConfig({ ...base, lat: 6.5 }), /lat and lng/);
    });

    it("resolves provider names and domains", () => {
        assert.deepEqual(normalizeProvider("Paystack").domains, ["paystack.co", "paystack.com"]);
        assert.equal(normalizeProvider("Paystack").matchText, false);
        assert.deepEqual(normalizeProvider("pay.example.com"), { name: "pay.example.com", domains: ["pay.example.com"], matchText: false });
        assert.equal(normalizeProvider("SomeLocalPay").matchText, true);
    });
});

describe("geo", () => {
    it("box contains the radius", () => {
        const c = { lat: 6.5244, lng: 3.3792 };
        const box = boundingBox(c, 25);
        assert.ok(haversineKm(c, { lat: box.high.latitude, lng: c.lng }) >= 24.9);
        assert.ok(haversineKm(c, { lat: c.lat, lng: box.high.longitude }) >= 24.9);
    });
});

describe("detect", () => {
    it("detects platforms from concrete signals", () => {
        assert.equal(detectPlatform(snap({ requestUrls: ["https://cdn.shopify.com/s/files/x.js"] })).value, "Shopify");
        assert.equal(detectPlatform(snap({ html: '<link href="/wp-content/plugins/woocommerce/a.css">' })).value, "WooCommerce");
        assert.equal(detectPlatform(snap({ html: '<link href="/wp-content/themes/x.css">' })).value, "WordPress");
        assert.equal(detectPlatform(snap({ headers: { "x-wix-request-id": "1" } })).value, "Wix");
        assert.equal(detectPlatform(snap({ html: "static1.squarespace.com" })).value, "Squarespace");
        assert.deepEqual(detectPlatform(snap({})), { value: "custom", signal: "no known platform signature matched" });
    });

    it("finds cart/checkout but ignores WhatsApp 'buy' links", () => {
        const c = detectCommerce(snap({ links: [{ href: "https://shop.example/cart", text: "Bag" }], buttons: ["Add to cart"] }));
        assert.equal(c.hasCart, true);
        assert.equal(c.hasCheckout, false);

        const wa = snap({ links: [{ href: "https://wa.me/234800?text=checkout", text: "Order on WhatsApp" }] });
        assert.deepEqual(detectCommerce(wa), { hasCart: false, hasCheckout: false, signals: [] });
        assert.equal(countWhatsappLinks(wa), 1);
    });

    it("matches payment providers by request, source, and (opt-in) text", () => {
        const providers = ["Paystack", "Stripe", "LocalPay"].map(normalizeProvider);
        const found = detectPaymentProviders(
            snap({ requestUrls: ["https://js.paystack.co/v1/inline.js"], text: "Stripe midi dress. Pay with LocalPay" }),
            providers,
        );
        assert.deepEqual(
            detectPaymentProviders(snap({ html: '<a href="https://paystack.com/pay/x">' }), providers),
            [{ value: "Paystack", signal: "paystack.com referenced in page source" }],
        );
        assert.deepEqual(detectPaymentProviders(snap({ html: "notpaystack.community" }), providers), []);
        assert.deepEqual(found, [
            { value: "Paystack", signal: "request to js.paystack.co" },
            { value: "LocalPay", signal: '"LocalPay" in page text' },
        ]);
    });

    it("spots local currency", () => {
        assert.equal(localCurrencySeen(snap({ text: "Price ₦12,000" }), "NGN").value, true);
        assert.equal(localCurrencySeen(snap({ text: "$12" }), "NGN").value, false);
    });
});

describe("scoring", () => {
    const site = { website_url: "https://shop.example/" };

    it("no website scores 100", () => {
        assert.equal(scoreLead({ website_url: null }, null).score, 100);
    });

    it("orders the cases as specified", () => {
        const good = scoreLead(site, audit({})).score!;
        const slow = scoreLead(site, audit({ load_time_ms: 11_000, lighthouse_score: 30 })).score!;
        const noCheckout = scoreLead(site, audit({ has_cart: 0, has_checkout: 0, payment_providers: "[]" })).score!;
        const insta = scoreLead({ website_url: "https://instagram.com/brand" }, null).score!;
        assert.equal(good, WEIGHTS.baseline);
        assert.equal(priorityOf(good), "low");
        assert.equal(priorityOf(slow), "medium");
        assert.equal(priorityOf(noCheckout), "high");
        assert.ok(good < slow && slow < noCheckout && noCheckout < insta && insta < 100);
    });

    it("classifies the listed website and scores each class", () => {
        const s = (url: string, a: Parameters<typeof audit>[0] | null = null) => scoreLead({ website_url: url }, a ? audit(a) : null);
        assert.equal(s("https://instagram.com/brand").websiteClass, "social");
        assert.equal(s("https://wa.me/2348000000000").websiteClass, "messaging");
        assert.equal(s("https://t.me/brandshop").score, WEIGHTS.baseline + WEIGHTS.messagingOnly);
        assert.equal(s("https://linktr.ee/brand").score, WEIGHTS.baseline + WEIGHTS.linkInBioOnly);
        const hosted = s("https://brand.bumpa.shop/", { final_url: "https://brand.bumpa.shop/" });
        assert.equal(hosted.websiteClass, "hosted_storefront");
        assert.equal(hosted.score, WEIGHTS.baseline + WEIGHTS.hostedStorefront);
        const dead = s("https://gone.example/", { status: "dead", error: "net::ERR_NAME_NOT_RESOLVED" });
        assert.deepEqual([dead.websiteClass, dead.score], ["dead_listing", WEIGHTS.baseline + WEIGHTS.deadListing]);
        assert.equal(s("https://brand.example/", { final_url: "https://instagram.com/brand" }).websiteClass, "social", "own domain redirecting to Instagram");
        const locked = s("https://brand.example/", { password_protected: 1, has_cart: 0, has_checkout: 0 });
        assert.equal(locked.score, WEIGHTS.baseline + WEIGHTS.passwordProtected);
    });

    it("does not score what was not measured", () => {
        assert.equal(scoreLead(site, null).score, null);
        assert.equal(scoreLead(site, audit({ status: "robots_disallowed" })).score, null);
        assert.equal(scoreLead(site, audit({ status: "failed" })).score, null);
        assert.equal(scoreLead(site, audit({ status: "blocked" })).score, null);
        // link-in-bio is known from the URL even when robots.txt blocks loading
        assert.equal(scoreLead({ website_url: "https://linktr.ee/brand" }, audit({ status: "robots_disallowed" })).score, WEIGHTS.baseline + WEIGHTS.linkInBioOnly);
        assert.equal(scoreLead({ website_url: "https://x.example/", business_status: "CLOSED_PERMANENTLY" }, null).score, null);
    });

    it("scores a transient failure only once it repeats", () => {
        assert.equal(scoreLead(site, audit({ status: "unreachable", unreachable_runs: 1 })).score, null);
        assert.equal(scoreLead(site, audit({ status: "unreachable", unreachable_runs: 2 })).score, WEIGHTS.baseline + WEIGHTS.siteUnreachable);
    });

    it("ignores Lighthouse when the page load timed out", () => {
        const s = scoreLead(site, audit({ load_timed_out: 1, load_time_ms: null, lighthouse_score: 20 }));
        assert.equal(s.score, WEIGHTS.baseline + WEIGHTS.loadTimedOut);
        assert.doesNotMatch(s.breakdown!, /lighthouse/);
    });

    it("primary gaps do not stack", () => {
        const s = scoreLead(site, audit({ has_cart: 0, has_checkout: 0, whatsapp_links: 2, whatsapp_order_only: 1, lighthouse_score: 95, payment_providers: "[]" }));
        assert.equal(s.score, WEIGHTS.baseline + WEIGHTS.whatsappOrderOnly);
    });

    it("breaks score ties by Google review count", () => {
        const rows = [
            { name: "A", lead_score: 65, user_ratings_total: 3 },
            { name: "B", lead_score: 65, user_ratings_total: 240 },
            { name: "C", lead_score: 90, user_ratings_total: null },
            { name: "D", lead_score: null, user_ratings_total: 999 },
        ];
        assert.deepEqual(rows.sort(compareLeads).map((r) => r.name), ["C", "B", "A", "D"]);
    });
});

describe("evidence", () => {
    const lead = { id: 1, dedupe_key: "k", name: "Brand", category: "fashion", address: null, phone: null, website_url: "https://shop.example/", website_domain: "shop.example", source: "google_places", source_ref: "p1", discovered_at: "", updated_at: "", high_priority: 0, lead_score: null, score_breakdown: null, evidence: null, country: "NG" };

    it("states only recorded facts", () => {
        const e = buildEvidence(lead, audit({ lighthouse_score: null, payment_providers: null, has_cart: 0, has_checkout: 0, platform: "custom", platform_signal: "no known platform signature matched" }));
        assert.match(e, /loaded in 1\.2s on Pixel 7 viewport/);
        assert.match(e, /no cart or checkout found on homepage/);
        assert.doesNotMatch(e, /Lighthouse/);
        assert.doesNotMatch(e, /payment/);
        assert.doesNotMatch(e, /\n/);
    });

    it("handles no website and unaudited leads", () => {
        assert.equal(buildEvidence({ ...lead, website_url: null }, null), "No website listed by google_places");
        assert.equal(buildEvidence(lead, null), "Not audited yet");
    });
});

describe("csv", () => {
    it("escapes and neutralises formulas", () => {
        assert.equal(csvCell('a,"b"'), '"a,""b"""');
        assert.equal(csvCell("=HYPERLINK(1)"), "'=HYPERLINK(1)");
        assert.equal(csvCell("+234 800 000 0000"), "+234 800 000 0000");
        assert.equal(csvCell(null), "");
    });
});

describe("store", () => {
    const newLead = (o: Partial<Parameters<LeadStore["upsertLead"]>[0]> = {}) => ({
        name: "Brand",
        category: "fashion",
        address: "1 Road",
        phone: null,
        website_url: null,
        website_domain: null,
        source: "google_places",
        source_ref: "place-1",
        dedupe_key: dedupeKey("Brand", "1 Road", null),
        ...o,
    });

    it("re-running discovery does not duplicate rows", () => {
        const s = new LeadStore(":memory:");
        assert.equal(s.upsertLead(newLead()).inserted, true);
        assert.equal(s.upsertLead(newLead()).inserted, false);
        assert.equal(s.upsertLead(newLead({ category: "jewelry", phone: "+234" })).inserted, false);
        assert.equal(s.counts().leads, 1);
        const row = s.allLeadsWithAudits()[0]!.lead;
        assert.equal(row.category, "fashion, jewelry");
        assert.equal(row.phone, "+234");
        assert.equal(row.high_priority, 1);

        // Same domain from another source merges too.
        const site = new URL("https://brand.com");
        s.upsertLead(newLead({ source_ref: "place-2", name: "Brand Ikeja", website_url: site.href, website_domain: "brand.com", dedupe_key: dedupeKey("x", null, site) }));
        s.upsertLead(newLead({ source: "json_file", source_ref: null, name: "Brand Co", website_url: site.href, website_domain: "brand.com", dedupe_key: dedupeKey("y", null, site) }));
        assert.equal(s.counts().leads, 2);
        s.close();
    });

    it("re-running audit upserts one row per lead", () => {
        const s = new LeadStore(":memory:");
        const site = new URL("https://brand.com");
        const { id } = s.upsertLead(newLead({ website_url: site.href, website_domain: "brand.com", dedupe_key: dedupeKey("x", null, site) }));
        assert.equal(s.leadsToAudit({ reaudit: false }).length, 1);
        const rec = { ...audit({}), lead_id: id, load_timed_out: false, has_cart: true, has_checkout: true, link_in_bio_only: false, whatsapp_order_only: false, local_currency_seen: true } as AuditRecord;
        s.saveAudit({ ...rec, status: "failed" });
        assert.equal(s.leadsToAudit({ reaudit: false }).length, 1, "failed audits are retried");
        s.saveAudit(rec);
        assert.equal(s.leadsToAudit({ reaudit: false }).length, 0);
        assert.equal(s.leadsToAudit({ reaudit: true }).length, 1);
        assert.equal(s.allLeadsWithAudits().filter((r) => r.audit).length, 1);
        s.close();
    });
});
