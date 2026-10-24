import { createServer } from "node:net";
import { join } from "node:path";
import { chromium, type Browser } from "playwright";
import type { RegionConfig } from "../config.js";
import type { AuditRecord, LeadRow, LeadStore } from "../db.js";
import { errMessage, log } from "../log.js";
import { RateLimiter } from "../rateLimit.js";
import { classifyUrl, parseWebsite } from "../url.js";
import { countWhatsappLinks, detectCommerce, detectPaymentProviders, detectPlatform, linkInBioHost, localCurrencySeen } from "./detect.js";
import { lighthouseMobileScore } from "./lighthouse.js";
import { loadPage } from "./page.js";
import { RobotsChecker } from "./robots.js";
import { probeHttps, type SslResult } from "./ssl.js";

export interface AuditOptions {
    reaudit: boolean;
    limit?: number;
    ids?: number[];
    lighthouse: boolean;
    timeoutMs: number;
    /** Minimum spacing between requests to the same host. */
    perHostDelayMs: number;
    screenshotsDir: string;
    /** Product token used for robots.txt matching and appended to the UA. */
    userAgentToken: string;
}

const freePort = () =>
    new Promise<number>((resolve, reject) => {
        const srv = createServer();
        srv.unref();
        srv.on("error", reject);
        srv.listen(0, "127.0.0.1", () => {
            const { port } = srv.address() as { port: number };
            srv.close(() => resolve(port));
        });
    });

async function launch(): Promise<{ browser: Browser; port: number }> {
    const port = await freePort();
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const browser = await chromium.launch({
        args: [`--remote-debugging-port=${port}`],
        ...(proxy ? { proxy: { server: proxy, bypass: "localhost,127.0.0.1" } } : {}),
    });
    return { browser, port };
}

const blank = (lead: LeadRow): AuditRecord => ({
    lead_id: lead.id,
    audited_at: new Date().toISOString(),
    status: "failed",
    requested_url: lead.website_url,
    final_url: null,
    http_status: null,
    load_time_ms: null,
    load_timed_out: null,
    lighthouse_score: null,
    lighthouse_error: null,
    platform: null,
    platform_signal: null,
    has_cart: null,
    has_checkout: null,
    cart_signal: null,
    payment_providers: null,
    link_in_bio_only: null,
    link_in_bio_host: null,
    whatsapp_links: null,
    whatsapp_order_only: null,
    ssl: null,
    ssl_detail: null,
    local_currency_seen: null,
    screenshot_path: null,
    error: null,
});

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

export class Auditor {
    private browser: Browser | null = null;
    private port = 0;
    private readonly limiter: RateLimiter;
    private readonly robots: RobotsChecker;

    constructor(
        private readonly config: RegionConfig,
        private readonly opts: AuditOptions,
    ) {
        this.limiter = new RateLimiter(opts.perHostDelayMs);
        this.robots = new RobotsChecker(opts.userAgentToken, this.limiter);
    }

    private async ensureBrowser() {
        if (this.browser?.isConnected()) return this.browser;
        await this.browser?.close().catch(() => {});
        ({ browser: this.browser, port: this.port } = await launch());
        return this.browser;
    }

    async close() {
        await this.browser?.close().catch(() => {});
    }

    async audit(lead: LeadRow): Promise<AuditRecord> {
        const rec = blank(lead);
        const url = parseWebsite(lead.website_url);
        if (!url) {
            rec.error = `unparseable website URL: ${lead.website_url}`;
            return rec;
        }
        rec.requested_url = url.href;
        const cls = classifyUrl(url);

        if (cls.kind === "social") {
            return { ...rec, status: "social_profile", link_in_bio_only: true, link_in_bio_host: cls.host };
        }
        if (cls.kind === "whatsapp") {
            return { ...rec, status: "whatsapp_link", whatsapp_order_only: true };
        }
        if (cls.kind === "link_in_bio") {
            rec.link_in_bio_only = true;
            rec.link_in_bio_host = cls.host;
        }

        // robots.txt first; a network failure here means the host is unreachable.
        let verdict;
        let httpsFailure: string | null = null;
        try {
            verdict = await this.robots.check(url.href);
        } catch (err) {
            // Many small sites only speak plain HTTP: fall back once before giving up.
            if (url.protocol !== "https:") return { ...rec, status: "unreachable", error: `robots.txt request failed: ${errMessage(err)}` };
            httpsFailure = errMessage(err);
            url.protocol = "http:";
            try {
                verdict = await this.robots.check(url.href);
            } catch (err2) {
                return { ...rec, status: "unreachable", error: `robots.txt request failed over HTTPS (${httpsFailure}) and HTTP (${errMessage(err2)})` };
            }
            rec.requested_url = url.href;
            log.debug(`lead ${lead.id}: HTTPS failed (${httpsFailure}); auditing ${url.href}`);
        }
        if (verdict.crawlDelayMs) this.limiter.setInterval(url.host, verdict.crawlDelayMs);
        if (!verdict.allowed) return { ...rec, status: "robots_disallowed", error: verdict.basis };

        const browser = await this.ensureBrowser();
        const screenshotPath = join(this.opts.screenshotsDir, `${lead.id}-${slug(url.hostname)}.png`);
        const loadOpts = { timeoutMs: this.opts.timeoutMs, userAgentSuffix: this.opts.userAgentToken, screenshotPath };

        await this.limiter.wait(url.host);
        let load = await loadPage(browser, url.href, { ...loadOpts, ignoreHttpsErrors: false });
        let ssl: SslResult | null = null;
        if (load.kind === "cert_error") {
            ssl = { ssl: "invalid", detail: `browser rejected certificate: ${load.code}` };
            await this.limiter.wait(url.host);
            load = await loadPage(browser, url.href, { ...loadOpts, ignoreHttpsErrors: true });
        }
        if (load.kind === "cert_error") throw new Error(`certificate error persisted with ignoreHTTPSErrors: ${load.code}`);
        if (load.kind === "unreachable") {
            return { ...rec, status: "unreachable", error: load.error, ssl: ssl?.ssl ?? null, ssl_detail: ssl?.detail ?? null };
        }

        rec.final_url = load.finalUrl;
        rec.http_status = load.httpStatus;
        rec.load_time_ms = load.loadTimeMs;
        rec.load_timed_out = load.timedOut;
        rec.screenshot_path = load.screenshotPath;
        if (load.screenshotError) log.warn(`lead ${lead.id}: screenshot failed: ${load.screenshotError}`);

        const status = load.httpStatus ?? 0;
        if ([401, 403, 429].includes(status)) {
            // Usually a bot wall, which says nothing about the brand's site.
            return { ...rec, status: "blocked", error: `HTTP ${status} returned to the audit browser (likely bot protection)` };
        }
        if (status >= 400) return { ...rec, status: "unreachable", error: `homepage returned HTTP ${status}` };

        const s = load.snapshot;
        const finalLib = linkInBioHost(load.finalUrl);
        if (finalLib) {
            rec.link_in_bio_only = true;
            rec.link_in_bio_host = finalLib;
        }
        const platform = detectPlatform(s);
        const commerce = detectCommerce(s);
        const providers = detectPaymentProviders(s, this.config.payment_providers);
        const wa = countWhatsappLinks(s);
        const currency = localCurrencySeen(s, this.config.currency);

        Object.assign(rec, {
            status: "ok",
            platform: platform.value,
            platform_signal: platform.signal,
            has_cart: commerce.hasCart,
            has_checkout: commerce.hasCheckout,
            cart_signal: commerce.signals.join(", ") || null,
            payment_providers: JSON.stringify(providers.map((p) => ({ name: p.value, signal: p.signal }))),
            whatsapp_links: wa,
            whatsapp_order_only: wa > 0 && !commerce.hasCart && !commerce.hasCheckout,
            local_currency_seen: currency.value,
        } satisfies Partial<AuditRecord>);

        if (!ssl) {
            const final = new URL(load.finalUrl);
            if (final.protocol === "https:") ssl = { ssl: "valid", detail: "served over HTTPS with a valid certificate" };
            else if (httpsFailure) ssl = { ssl: "none", detail: `served over HTTP; HTTPS request failed: ${httpsFailure}` };
            else {
                await this.limiter.wait(final.host);
                ssl = await probeHttps(final.hostname);
                ssl.detail = `served over HTTP; ${ssl.detail}`;
            }
        }
        rec.ssl = ssl.ssl;
        rec.ssl_detail = ssl.detail;

        if (this.opts.lighthouse) {
            const final = new URL(load.finalUrl);
            const allowed = final.origin === url.origin ? true : await this.robots.check(final.href).then((v) => v.allowed, () => false);
            if (!allowed) rec.lighthouse_error = "skipped: robots.txt disallows the redirected URL";
            else {
                await this.limiter.wait(final.host);
                const lh = await lighthouseMobileScore(load.finalUrl, this.port, { locale: this.config.language, timeoutMs: 120_000 });
                rec.lighthouse_score = lh.score;
                rec.lighthouse_error = lh.error;
                if (lh.error) log.warn(`lead ${lead.id}: Lighthouse: ${lh.error}`);
            }
        }
        return rec;
    }
}

export interface AuditSummary {
    attempted: number;
    byStatus: Record<string, number>;
}

/** Audit every pending lead. One lead's failure is logged and never stops the run. */
export async function runAudit(store: LeadStore, config: RegionConfig, opts: AuditOptions): Promise<AuditSummary> {
    const leads = store.leadsToAudit({ reaudit: opts.reaudit, limit: opts.limit, ids: opts.ids });
    const summary: AuditSummary = { attempted: 0, byStatus: {} };
    log.info(`audit: ${leads.length} lead(s) to audit`);
    if (!leads.length) return summary;

    const auditor = new Auditor(config, opts);
    try {
        for (const [i, lead] of leads.entries()) {
            summary.attempted++;
            let rec: AuditRecord;
            try {
                rec = await auditor.audit(lead);
            } catch (err) {
                rec = { ...blank(lead), error: errMessage(err) };
            }
            try {
                store.saveAudit(rec);
                if (rec.status === "failed" || rec.status === "unreachable") {
                    store.logFailure(lead.id, "audit", `${rec.status}: ${rec.error}`);
                }
            } catch (err) {
                log.error(`lead ${lead.id}: could not save audit: ${errMessage(err)}`);
                store.logFailure(lead.id, "audit", `save failed: ${errMessage(err)}`);
            }
            summary.byStatus[rec.status] = (summary.byStatus[rec.status] ?? 0) + 1;
            const line = `[${i + 1}/${leads.length}] #${lead.id} ${lead.name} (${lead.website_url}): ${rec.status}${rec.error ? ` - ${rec.error}` : ""}`;
            if (rec.status === "failed") log.warn(line);
            else log.info(line);
        }
    } finally {
        await auditor.close();
    }
    return summary;
}
