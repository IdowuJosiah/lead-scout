/**
 * Per-key minimum spacing between requests. Keys are typically hostnames, so
 * one slow site never delays another's budget, and "global" caps overall pace.
 */
export class RateLimiter {
    private nextAt = new Map<string, number>();
    private overrides = new Map<string, number>();

    constructor(private readonly minIntervalMs: number) {}

    /** Raise the interval for one key (e.g. a robots.txt Crawl-delay). */
    setInterval(key: string, ms: number) {
        this.overrides.set(key, Math.max(ms, this.minIntervalMs));
    }

    async wait(key = "global"): Promise<void> {
        const interval = this.overrides.get(key) ?? this.minIntervalMs;
        const now = Date.now();
        const at = Math.max(now, this.nextAt.get(key) ?? 0);
        // Reserve the slot before sleeping so concurrent callers queue up.
        this.nextAt.set(key, at + interval);
        if (at > now) await sleep(at - now);
    }
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
