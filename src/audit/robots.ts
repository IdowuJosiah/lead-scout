import { createRequire } from "node:module";
import type { RateLimiter } from "../rateLimit.js";
import { httpGet } from "./http.js";

interface Robots {
    isAllowed(url: string, ua?: string): boolean | undefined;
    getCrawlDelay(ua?: string): number | undefined;
}
// CommonJS module whose typings declare an ES default export; load it as CJS.
const robotsParser = createRequire(import.meta.url)("robots-parser") as (url: string, contents: string) => Robots;

/**
 * robots.txt handling per RFC 9309: 2xx parsed, 4xx = no restrictions,
 * 5xx = treat as full disallow. Network errors are surfaced to the caller
 * (the host is unreachable, so the page would be too). Cached per origin.
 */

export interface RobotsVerdict {
    allowed: boolean;
    /** Crawl-delay for our agent, in ms, when the file sets one. */
    crawlDelayMs: number | null;
    /** What the verdict is based on, for evidence/logging. */
    basis: string;
}

export class RobotsChecker {
    private cache = new Map<string, Promise<{ parse: Robots | null; basis: string; allowAll: boolean }>>();

    constructor(
        private readonly userAgentToken: string,
        private readonly limiter: RateLimiter,
        private readonly timeoutMs = 10_000,
    ) {}

    private load(origin: string) {
        let p = this.cache.get(origin);
        if (!p) {
            p = (async () => {
                const robotsUrl = `${origin}/robots.txt`;
                await this.limiter.wait(new URL(origin).host);
                // Network errors propagate: caller records the host as unreachable.
                const res = await httpGet(robotsUrl, { headers: { "User-Agent": this.userAgentToken }, timeoutMs: this.timeoutMs });
                if (res.status >= 200 && res.status < 300) {
                    return { parse: robotsParser(robotsUrl, res.body), basis: `robots.txt HTTP ${res.status}`, allowAll: false };
                }
                if (res.status >= 400 && res.status < 500) {
                    return { parse: null, basis: `robots.txt HTTP ${res.status} (no restrictions)`, allowAll: true };
                }
                return { parse: null, basis: `robots.txt HTTP ${res.status} (treated as disallow)`, allowAll: false };
            })();
            this.cache.set(origin, p);
            // Don't cache transient network failures.
            p.catch(() => this.cache.delete(origin));
        }
        return p;
    }

    async check(url: string): Promise<RobotsVerdict> {
        const origin = new URL(url).origin;
        const { parse, basis, allowAll } = await this.load(origin);
        if (allowAll) return { allowed: true, crawlDelayMs: null, basis };
        if (!parse) return { allowed: false, crawlDelayMs: null, basis };
        const allowed = parse.isAllowed(url, this.userAgentToken) !== false;
        const delay = parse.getCrawlDelay(this.userAgentToken);
        return {
            allowed,
            crawlDelayMs: delay ? Math.min(delay, 60) * 1000 : null,
            basis: `${basis}, ${allowed ? "allows" : "disallows"} ${new URL(url).pathname}`,
        };
    }
}
