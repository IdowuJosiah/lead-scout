import { RateLimiter, sleep } from "../rateLimit.js";

/** Raised for problems that will affect every request (bad key, no credits). */
export class ApiConfigError extends Error {}

async function getJson(url: string, limiter: RateLimiter, label: string): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
        await limiter.wait();
        const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
        const text = await res.text();
        if (res.ok) return JSON.parse(text);
        if ((res.status === 429 || res.status >= 500) && attempt < 3) {
            await sleep(2000 * 2 ** attempt);
            continue;
        }
        const detail = text.slice(0, 300);
        if (res.status === 401 || res.status === 403 || res.status === 402) {
            throw new ApiConfigError(`${label} HTTP ${res.status}: ${detail}`);
        }
        throw new Error(`${label} HTTP ${res.status}: ${detail}`);
    }
}

// ---- Hunter ----------------------------------------------------------------

export interface HunterEmail {
    value: string;
    /** Hunter's own label: "personal" or "generic". */
    type: string | null;
    confidence: number | null;
    /** Number of public web pages Hunter saw the address on. */
    sourceCount: number;
}

/**
 * Hunter domain search: https://hunter.io/api-documentation/v2#domain-search
 * Only addresses Hunter actually saw on the web (sources > 0) at this domain
 * are returned. Hunter's inferred email "pattern" is ignored.
 */
export class HunterClient {
    private limiter = new RateLimiter(1000);
    constructor(private readonly apiKey: string) {}

    async domainSearch(domain: string): Promise<HunterEmail[]> {
        const url = `https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=10&api_key=${encodeURIComponent(this.apiKey)}`;
        const body = (await getJson(url, this.limiter, "Hunter")) as {
            data?: { emails?: { value?: string; type?: string; confidence?: number; sources?: unknown[] }[] };
        };
        return (body.data?.emails ?? [])
            .filter((e) => typeof e.value === "string" && e.value.toLowerCase().endsWith(`@${domain.toLowerCase()}`))
            .map((e) => ({
                value: e.value!.toLowerCase(),
                type: e.type ?? null,
                confidence: typeof e.confidence === "number" ? e.confidence : null,
                sourceCount: Array.isArray(e.sources) ? e.sources.length : 0,
            }))
            .filter((e) => e.sourceCount > 0);
    }

    /**
     * Hunter email verifier: https://hunter.io/api-documentation/v2#email-verifier
     * Statuses: valid, invalid, accept_all, webmail, disposable, unknown.
     * accept_all is reported as "catch-all" so the queue rules treat both providers alike.
     */
    async verify(email: string): Promise<Verification> {
        const url = `https://api.hunter.io/v2/email-verifier?email=${encodeURIComponent(email)}&api_key=${encodeURIComponent(this.apiKey)}`;
        // A slow check answers 202 with no result yet; asking again returns it (counted once).
        for (let attempt = 0; attempt < 4; attempt++) {
            const body = (await getJson(url, this.limiter, "Hunter verifier")) as { data?: { status?: string; score?: number } };
            const status = body.data?.status?.toLowerCase();
            if (status) {
                return { status: status === "accept_all" ? "catch-all" : status, subStatus: body.data?.score != null ? `score ${body.data.score}` : null };
            }
            await sleep(5000);
        }
        throw new Error("Hunter verifier: no result after 4 tries");
    }
}

/** Anything that can check an address; the result is cached per email. */
export interface Verifier {
    name: "hunter" | "zerobounce";
    validate(email: string): Promise<Verification>;
}

/** Which verifier to use: EMAIL_VERIFIER=zerobounce opts back in to ZeroBounce; Hunter otherwise. */
export function verifierName(env = process.env): "hunter" | "zerobounce" {
    return env.EMAIL_VERIFIER?.trim().toLowerCase() === "zerobounce" ? "zerobounce" : "hunter";
}

// ---- ZeroBounce ------------------------------------------------------------

export interface Verification {
    status: string;
    subStatus: string | null;
}

/** ZeroBounce single validation: https://www.zerobounce.net/docs/email-validation-api-quickstart/ */
export class ZeroBounceClient {
    private limiter = new RateLimiter(250);
    constructor(private readonly apiKey: string) {}

    async validate(email: string): Promise<Verification> {
        const url = `https://api.zerobounce.net/v2/validate?api_key=${encodeURIComponent(this.apiKey)}&email=${encodeURIComponent(email)}&ip_address=`;
        const body = (await getJson(url, this.limiter, "ZeroBounce")) as { status?: string; sub_status?: string; error?: string };
        if (body.error) {
            const msg = `ZeroBounce: ${body.error}`;
            throw /key|credit/i.test(body.error) ? new ApiConfigError(msg) : new Error(msg);
        }
        if (!body.status) throw new Error("ZeroBounce returned no status");
        return { status: body.status.toLowerCase(), subStatus: body.sub_status || null };
    }
}

/** Which verification results may be emailed, and with what warning. */
export function queueDecision(status: string | null): { queue: boolean; riskFlag: string | null } {
    if (status === "valid") return { queue: true, riskFlag: null };
    if (status === "catch-all") return { queue: true, riskFlag: "catch-all domain: the server accepts any address, so this mailbox could not be confirmed" };
    return { queue: false, riskFlag: null };
}
