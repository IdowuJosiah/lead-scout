import { readFileSync } from "node:fs";

/** A payment provider to look for on audited sites. */
export interface PaymentProvider {
    name: string;
    /** Hostnames whose requests/references count as a detection (suffix match). */
    domains: string[];
    /**
     * Also count the provider's name in visible page text. Off by default for
     * providers with known domains ("Stripe" also names a dress pattern).
     */
    matchText: boolean;
}

export interface RegionConfig {
    country: string;
    city: string;
    radius_km: number;
    language: string;
    currency: string;
    search_keywords: string[];
    payment_providers: PaymentProvider[];
    sources: string[];
    /** Optional search centre. Resolved from city + country when absent. */
    lat?: number;
    lng?: number;
    /** Per-source options, keyed by source name. */
    source_options?: Record<string, Record<string, unknown>>;
}

/** Domains for well-known providers, so config can list plain names. */
const KNOWN_PROVIDER_DOMAINS: Record<string, string[]> = {
    paystack: ["paystack.co", "paystack.com"],
    flutterwave: ["flutterwave.com"],
    stripe: ["stripe.com", "stripe.network"],
    paypal: ["paypal.com", "paypalobjects.com"],
    monnify: ["monnify.com"],
    interswitch: ["interswitchng.com", "interswitchgroup.com"],
    remita: ["remita.net"],
    opay: ["opayweb.com", "opaycheckout.com"],
    squad: ["squadco.com"],
    mpesa: ["safaricom.co.ke"],
    razorpay: ["razorpay.com"],
    square: ["squareup.com", "squarecdn.com"],
    klarna: ["klarna.com", "klarnaservices.com"],
};

export function normalizeProvider(entry: unknown): PaymentProvider {
    if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed.includes(".")) {
            return { name: trimmed, domains: [trimmed.toLowerCase()], matchText: false };
        }
        const domains = KNOWN_PROVIDER_DOMAINS[trimmed.toLowerCase()] ?? [];
        return { name: trimmed, domains, matchText: domains.length === 0 };
    }
    if (entry && typeof entry === "object" && typeof (entry as { name?: unknown }).name === "string") {
        const { name, domains, match_text } = entry as { name: string; domains?: unknown; match_text?: unknown };
        const list = Array.isArray(domains) ? domains.filter((d): d is string => typeof d === "string") : [];
        const resolved = list.length ? list.map((d) => d.toLowerCase()) : (KNOWN_PROVIDER_DOMAINS[name.toLowerCase()] ?? []);
        return { name, domains: resolved, matchText: typeof match_text === "boolean" ? match_text : resolved.length === 0 };
    }
    throw new Error(`Invalid payment_providers entry: ${JSON.stringify(entry)}`);
}

export function loadConfigFile(path: string): Record<string, unknown> {
    try {
        return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    } catch (err) {
        throw new Error(`Could not read config ${path}: ${(err as Error).message}`);
    }
}

/** Flag values from the CLI that may override config keys. */
export interface ConfigOverrides {
    country?: string;
    city?: string;
    radius_km?: string;
    language?: string;
    currency?: string;
    keywords?: string;
    payment_providers?: string;
    sources?: string;
    lat?: string;
    lng?: string;
}

const splitList = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);

export function resolveConfig(raw: Record<string, unknown>, o: ConfigOverrides = {}): RegionConfig {
    const merged: Record<string, unknown> = { ...raw };
    if (o.country !== undefined) merged.country = o.country;
    if (o.city !== undefined) merged.city = o.city;
    if (o.radius_km !== undefined) merged.radius_km = Number(o.radius_km);
    if (o.language !== undefined) merged.language = o.language;
    if (o.currency !== undefined) merged.currency = o.currency;
    if (o.keywords !== undefined) merged.search_keywords = splitList(o.keywords);
    if (o.payment_providers !== undefined) merged.payment_providers = splitList(o.payment_providers);
    if (o.sources !== undefined) merged.sources = splitList(o.sources);
    if (o.lat !== undefined) merged.lat = Number(o.lat);
    if (o.lng !== undefined) merged.lng = Number(o.lng);

    const errors: string[] = [];
    const str = (k: string) => {
        const v = merged[k];
        if (typeof v !== "string" || !v.trim()) errors.push(`${k} must be a non-empty string`);
        return typeof v === "string" ? v.trim() : "";
    };
    const country = str("country");
    const city = str("city");
    const language = str("language");
    const currency = str("currency").toUpperCase();

    const radius = merged.radius_km;
    if (typeof radius !== "number" || !Number.isFinite(radius) || radius <= 0) {
        errors.push("radius_km must be a positive number");
    }
    const keywords = merged.search_keywords;
    if (!Array.isArray(keywords) || !keywords.length || !keywords.every((k) => typeof k === "string")) {
        errors.push("search_keywords must be a non-empty list of strings");
    }
    const providers = Array.isArray(merged.payment_providers) ? merged.payment_providers : [];
    const sources = Array.isArray(merged.sources) && merged.sources.length ? merged.sources : ["google_places"];

    const lat = merged.lat;
    const lng = merged.lng;
    const hasCentre = typeof lat === "number" && typeof lng === "number" && Number.isFinite(lat) && Number.isFinite(lng);
    if ((lat != null || lng != null) && !hasCentre) errors.push("lat and lng must both be numbers when set");

    if (errors.length) throw new Error(`Invalid config:\n  - ${errors.join("\n  - ")}`);

    return {
        country,
        city,
        radius_km: radius as number,
        language,
        currency,
        search_keywords: keywords as string[],
        payment_providers: providers.map(normalizeProvider),
        sources: sources.map(String),
        ...(hasCentre ? { lat: lat as number, lng: lng as number } : {}),
        source_options: (merged.source_options as RegionConfig["source_options"]) ?? {},
    };
}
