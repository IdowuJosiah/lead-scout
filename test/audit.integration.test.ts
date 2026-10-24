import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { runAudit } from "../src/audit/index.js";
import { resolveConfig } from "../src/config.js";
import { LeadStore } from "../src/db.js";
import { exportCsv } from "../src/export.js";
import { dedupeKey, parseWebsite, websiteDomain } from "../src/url.js";

/**
 * End-to-end audit against local fixture sites (real Chromium via Playwright).
 * Lighthouse is exercised when LIGHTHOUSE=1, since it adds ~20s per site.
 */

type Route = (path: string) => { status?: number; body: string; delayMs?: number; type?: string };

function serve(route: Route): Promise<{ server: Server; url: string }> {
    const server = createServer((req, res) => {
        const r = route(req.url ?? "/");
        setTimeout(() => {
            res.writeHead(r.status ?? 200, { "Content-Type": r.type ?? "text/html; charset=utf-8" });
            res.end(r.body);
        }, r.delayMs ?? 0);
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/` })));
}

const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64").toString("latin1");

const SITES: Record<string, Route> = {
    store: (p) =>
        p === "/robots.txt"
            ? { body: "User-agent: *\nAllow: /\n", type: "text/plain" }
            : {
                  body: `<!doctype html><html><head><title>Store</title><!-- cdn.shopify.com --></head><body>
                    <h1>Ankara Dresses</h1><p>₦25,000</p>
                    <a href="/cart">Cart</a> <button>Add to cart</button>
                    <a href="https://paystack.com/pay/brand">Pay</a></body></html>`,
              },
    whatsapp: (p) =>
        p === "/robots.txt"
            ? { status: 404, body: "" }
            : p === "/slow.png"
              ? { body: PNG_1PX, type: "image/png", delayMs: 5500 }
              : {
                    body: `<!doctype html><html><body><h1>Bead jewelry</h1><img src="/slow.png" alt="necklace">
                      <a href="https://wa.me/2348000000000?text=I%20want%20to%20order">Order on WhatsApp</a></body></html>`,
                },
    private: (p) => (p === "/robots.txt" ? { body: "User-agent: *\nDisallow: /\n", type: "text/plain" } : { body: "<h1>secret</h1>" }),
    broken: (p) => (p === "/robots.txt" ? { status: 404, body: "" } : { status: 500, body: "Internal error" }),
};

describe("audit (end to end)", { timeout: 300_000 }, () => {
    const servers: Server[] = [];
    const urls: Record<string, string> = {};
    let dir: string;

    before(async () => {
        dir = mkdtempSync(join(tmpdir(), "lead-scout-"));
        for (const [name, route] of Object.entries(SITES)) {
            const s = await serve(route);
            servers.push(s.server);
            urls[name] = s.url;
        }
        // A port nobody listens on.
        const dead = await serve(() => ({ body: "" }));
        urls.dead = dead.url;
        await new Promise((r) => dead.server.close(r));
    });

    after(() => {
        for (const s of servers) s.close();
        rmSync(dir, { recursive: true, force: true });
    });

    it("audits, scores and exports each kind of site", async () => {
        const store = new LeadStore(join(dir, "leads.db"));
        const add = (name: string, website: string | null) => {
            const site = parseWebsite(website);
            return store.upsertLead({
                name,
                category: "fashion",
                address: `${name} street`,
                phone: null,
                website_url: site?.href ?? null,
                website_domain: site ? websiteDomain(site) : null,
                source: "test",
                source_ref: name,
                dedupe_key: dedupeKey(name, `${name} street`, site),
            }).id;
        };
        const ids = {
            store: add("Store", urls.store!),
            whatsapp: add("Beads", urls.whatsapp!),
            private: add("Private", urls.private!),
            broken: add("Broken", urls.broken!),
            dead: add("Dead", urls.dead!),
            insta: add("Insta", "https://instagram.com/somebrand"),
            none: add("NoSite", null),
        };

        const config = resolveConfig({
            country: "NG",
            city: "Lagos",
            radius_km: 10,
            language: "en",
            currency: "NGN",
            search_keywords: ["fashion"],
            payment_providers: ["Paystack", "Stripe"],
        });
        const opts = {
            reaudit: false,
            lighthouse: process.env.LIGHTHOUSE === "1",
            timeoutMs: 20_000,
            perHostDelayMs: 50,
            screenshotsDir: join(dir, "shots"),
            userAgentToken: "LeadScoutTest",
        };
        const summary = await runAudit(store, config, opts);
        assert.equal(summary.attempted, 6, "no-website lead is not audited");

        const byId = new Map(store.allLeadsWithAudits().map((r) => [r.lead.id, r]));
        const a = (k: keyof typeof ids) => byId.get(ids[k])!.audit!;

        assert.equal(a("store").status, "ok");
        assert.equal(a("store").platform, "Shopify");
        assert.equal(a("store").has_cart, 1);
        assert.equal(a("store").ssl, "none");
        assert.equal(a("store").local_currency_seen, 1);
        assert.deepEqual(JSON.parse(a("store").payment_providers!), [{ name: "Paystack", signal: "paystack.com referenced in page source" }]);
        assert.ok(existsSync(a("store").screenshot_path!), "screenshot written");
        if (opts.lighthouse) assert.equal(typeof a("store").lighthouse_score, "number", a("store").lighthouse_error ?? "");

        assert.equal(a("whatsapp").status, "ok");
        assert.equal(a("whatsapp").whatsapp_order_only, 1);
        assert.ok(a("whatsapp").load_time_ms! >= 5000, `slow image delays load (${a("whatsapp").load_time_ms}ms)`);
        assert.equal(a("whatsapp").platform, "custom");

        assert.equal(a("private").status, "robots_disallowed");
        assert.equal(a("private").screenshot_path, null, "nothing fetched past robots.txt");
        assert.equal(a("broken").status, "unreachable");
        assert.equal(a("dead").status, "unreachable");
        assert.match(a("dead").error!, /robots\.txt request failed/);
        assert.equal(a("insta").status, "social_profile");

        // Re-running does nothing new; --reaudit replaces rows rather than adding.
        assert.equal((await runAudit(store, config, opts)).attempted, 0);
        await runAudit(store, config, { ...opts, reaudit: true, ids: [ids.store] });
        assert.equal(store.allLeadsWithAudits().filter((r) => r.audit).length, 6);

        const out = join(dir, "leads.csv");
        assert.equal(exportCsv(store, out), 7);
        const lines = readFileSync(out, "utf8").trim().split("\r\n");
        assert.equal(lines.length, 8);
        assert.match(lines[1]!, /^100,high,NoSite,/);
        const scores = lines.slice(1).map((l) => (l.startsWith(",") ? -1 : Number(l.split(",")[0])));
        assert.deepEqual(scores, [...scores].sort((x, y) => y - x), "sorted by lead_score desc");
        const storeLine = lines.find((l) => l.includes(",Store,"))!;
        assert.match(storeLine, /,low,/);
        assert.match(storeLine, /platform Shopify \(""cdn\.shopify\.com"" in page source\)/);
        const privateLine = lines.find((l) => l.includes(",Private,"))!;
        assert.match(privateLine, /^,,Private,/, "unmeasured lead is not scored");
        store.close();
    });
});
