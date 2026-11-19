import countryToCurrency from "country-to-currency";
import tzlookup from "tz-lookup";
import type { DatabaseSync } from "node:sqlite";
import { normalizeProvider, type PaymentProvider, type RegionConfig } from "./config.js";
import type { LeadRow } from "./db.js";
import { haversineKm } from "./discovery/googlePlaces.js";

/**
 * Regions: any place you type ("Dubai", "Accra", "Austin, Texas") becomes a
 * stored region with everything the pipeline needs, worked out automatically:
 * Google Places gives the location, country and size; the timezone comes from
 * the coordinates and the currency from the country. New countries start with
 * email OFF: cold-email rules differ by country, so you switch it on yourself.
 */

export const REGIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS regions (
    id                INTEGER PRIMARY KEY,
    label             TEXT NOT NULL,
    place_ref         TEXT UNIQUE,
    city              TEXT NOT NULL,
    country           TEXT NOT NULL,
    country_code      TEXT NOT NULL,
    lat               REAL,
    lng               REAL,
    radius_km         REAL NOT NULL,
    timezone          TEXT NOT NULL,
    currency          TEXT NOT NULL,
    allowed_to_email  INTEGER,
    legal_basis       TEXT,
    send_days         TEXT NOT NULL,
    send_start        TEXT NOT NULL,
    send_end          TEXT NOT NULL,
    keywords          TEXT,
    active            INTEGER NOT NULL DEFAULT 1,
    created_at        TEXT NOT NULL,
    last_scouted_at   TEXT
);
`;

export interface RegionRow {
    id: number;
    label: string;
    place_ref: string | null;
    city: string;
    country: string;
    country_code: string;
    lat: number | null;
    lng: number | null;
    radius_km: number;
    timezone: string;
    currency: string;
    allowed_to_email: number | null;
    legal_basis: string | null;
    send_days: string;
    send_start: string;
    send_end: string;
    /** JSON list; null = use the default keywords. */
    keywords: string | null;
    active: number;
    created_at: string;
    last_scouted_at: string | null;
}

/** Countries whose working week is Sunday to Thursday. Everyone else: Monday to Friday. */
const SUN_THU = new Set(["SA", "KW", "QA", "OM", "BH", "EG", "IL", "JO", "IQ", "LY", "DZ", "YE", "AF"]);

export function defaultSendDays(countryCode: string): string {
    return SUN_THU.has(countryCode.toUpperCase()) ? "Sun-Thu" : "Mon-Fri";
}

/** How the email names local online payment, for the {payment_examples} placeholder. */
const PAYMENT_EXAMPLES: Record<string, string> = {
    NG: "Paystack or Flutterwave",
    GH: "Paystack or Flutterwave",
    KE: "M-Pesa or Paystack",
    ZA: "Paystack or Yoco",
    EG: "Paymob or Fawry",
    AE: "Stripe, Telr or Tabby",
    SA: "Mada, Tabby or Tamara",
    QA: "Stripe or Tabby",
    KW: "KNET or Tabby",
    IN: "Razorpay or UPI",
    PK: "JazzCash or Easypaisa",
    BR: "Pix or Mercado Pago",
    MX: "Mercado Pago or Stripe",
    NL: "iDEAL or Stripe",
    DE: "Stripe, PayPal or Klarna",
};

export function paymentExamples(countryCode: string): string {
    return PAYMENT_EXAMPLES[countryCode.toUpperCase()] ?? "Stripe or PayPal";
}

/** Extra providers worth detecting in a country, on top of the configured list. */
const COUNTRY_PROVIDERS: Record<string, (string | { name: string; domains: string[] })[]> = {
    AE: [{ name: "Telr", domains: ["telr.com"] }, { name: "Tabby", domains: ["tabby.ai"] }, { name: "Tamara", domains: ["tamara.co"] }, { name: "Checkout.com", domains: ["checkout.com"] }],
    SA: [{ name: "Tabby", domains: ["tabby.ai"] }, { name: "Tamara", domains: ["tamara.co"] }, { name: "HyperPay", domains: ["hyperpay.com"] }, { name: "Moyasar", domains: ["moyasar.com"] }],
    ZA: [{ name: "Yoco", domains: ["yoco.com"] }, { name: "PayFast", domains: ["payfast.co.za"] }],
    KE: ["mpesa", { name: "Pesapal", domains: ["pesapal.com"] }],
    EG: [{ name: "Paymob", domains: ["paymob.com", "accept.paymob.com"] }, { name: "Fawry", domains: ["fawry.com", "atfawry.com"] }],
    IN: ["razorpay", { name: "Cashfree", domains: ["cashfree.com"] }, { name: "PayU", domains: ["payu.in"] }],
    BR: [{ name: "Mercado Pago", domains: ["mercadopago.com", "mercadopago.com.br"] }, { name: "PagSeguro", domains: ["pagseguro.uol.com.br"] }],
};
const GLOBAL_PROVIDERS = ["Stripe", "PayPal", "square", "klarna"];

function providersFor(base: PaymentProvider[], countryCode: string): PaymentProvider[] {
    const extra = [...GLOBAL_PROVIDERS, ...(COUNTRY_PROVIDERS[countryCode.toUpperCase()] ?? [])].map(normalizeProvider);
    const seen = new Set(base.map((p) => p.name.toLowerCase()));
    return [...base, ...extra.filter((p) => !seen.has(p.name.toLowerCase()) && seen.add(p.name.toLowerCase()))];
}

export function currencyFor(countryCode: string): string {
    return (countryToCurrency as Record<string, string>)[countryCode.toUpperCase()] ?? "USD";
}

export function timezoneFor(lat: number, lng: number): string {
    try {
        return tzlookup(lat, lng);
    } catch {
        return "UTC";
    }
}

/** The full pipeline config for a region: defaults from config/region.json, place details from the region. */
export function regionConfig(base: RegionConfig, r: RegionRow): RegionConfig {
    const keywords = r.keywords ? (JSON.parse(r.keywords) as string[]) : null;
    const isBaseCountry = r.country_code === base.country_code;
    return {
        ...base,
        city: r.city,
        country: r.country,
        country_code: r.country_code,
        radius_km: r.radius_km,
        currency: r.currency,
        timezone: r.timezone,
        ...(r.lat != null && r.lng != null ? { lat: r.lat, lng: r.lng } : { lat: undefined, lng: undefined }),
        search_keywords: keywords?.length ? keywords : base.search_keywords,
        payment_providers: isBaseCountry ? base.payment_providers : providersFor(base.payment_providers, r.country_code),
        allowed_to_email: r.allowed_to_email == null ? null : r.allowed_to_email === 1,
        legal_basis: r.legal_basis ?? "",
        send_window: { days: r.send_days, start: r.send_start, end: r.send_end },
    };
}

// ---- Resolving a typed place --------------------------------------------------

export interface ResolvedPlace {
    placeRef: string;
    city: string;
    country: string;
    countryCode: string;
    lat: number;
    lng: number;
    radiusKm: number;
}

interface PlacesResult {
    places?: {
        id: string;
        displayName?: { text?: string };
        formattedAddress?: string;
        types?: string[];
        location?: { latitude: number; longitude: number };
        viewport?: { low: { latitude: number; longitude: number }; high: { latitude: number; longitude: number } };
        addressComponents?: { longText?: string; shortText?: string; types?: string[] }[];
    }[];
}

/** Search radius from the place's size: half the diagonal of its map viewport, kept between 3 km and max. */
export function radiusFromViewport(v: NonNullable<NonNullable<PlacesResult["places"]>[number]["viewport"]>, max = 50): number {
    const half = haversineKm({ lat: v.low.latitude, lng: v.low.longitude }, { lat: v.high.latitude, lng: v.high.longitude }) / 2;
    return Math.round(Math.min(max, Math.max(3, half)));
}

/** Largest search radius: a city stays local; a country, state or island is searched across (Google ranks the best-known first). */
export const MAX_RADIUS_KM = { city: 50, wide: 600 };
/** Place types that are a town or part of one. Anything else (country, state, island, region) is searched across its whole size. */
const CITY_TYPES = ["locality", "postal_town", "sublocality", "sublocality_level_1", "neighborhood", "postal_code", "administrative_area_level_3", "administrative_area_level_4", "route", "street_address", "premise", "establishment", "point_of_interest"];

/** "Ireland" or "Republic of Ireland" -> "IE", using the country names built into Node. */
export function countryCodeFromName(name: string | undefined): string | null {
    const want = name?.trim().toLowerCase();
    if (!want) return null;
    if (/^[a-z]{2}$/.test(want)) return want.toUpperCase();
    const names = new Intl.DisplayNames(["en"], { type: "region" });
    for (let a = 65; a <= 90; a++) {
        for (let b = 65; b <= 90; b++) {
            const code = String.fromCharCode(a, b);
            let n: string | undefined;
            try {
                n = names.of(code);
            } catch {
                continue;
            }
            if (!n || n === code) continue;
            const low = n.toLowerCase();
            if (low === want || want === `republic of ${low}` || low === `republic of ${want}`) return code;
        }
    }
    return null;
}

/** One Google Places call: "Dubai" -> location, country, size. */
export async function resolvePlace(text: string, apiKey: string, language = "en"): Promise<ResolvedPlace> {
    const res = await fetch("https://places.googleapis.com/v1/places:searchText", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Goog-Api-Key": apiKey,
            "X-Goog-FieldMask": "places.id,places.displayName,places.formattedAddress,places.types,places.location,places.viewport,places.addressComponents",
        },
        body: JSON.stringify({ textQuery: text, languageCode: language, pageSize: 1 }),
        signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) throw new Error(`Places API HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const p = ((await res.json()) as PlacesResult).places?.[0];
    if (!p?.location) throw new Error(`Couldn't find a place called "${text}". Try adding the country, e.g. "${text}, Ghana".`);
    // The country, from the address; failing that (Google sometimes leaves it out for a
    // whole country), from the place's own name or the end of its address.
    const comp = p.addressComponents?.find((c) => c.types?.includes("country"));
    const isCountry = !!p.types?.includes("country");
    const lastPart = p.formattedAddress?.split(",").pop();
    const countryCode =
        comp?.shortText?.toUpperCase() ||
        (isCountry ? countryCodeFromName(p.displayName?.text) : null) ||
        countryCodeFromName(lastPart) ||
        countryCodeFromName(text.split(",").pop());
    if (!countryCode) throw new Error(`Couldn't tell which country "${text}" is in. Try adding the country, e.g. "${text}, Ireland".`);
    const country = comp?.longText || new Intl.DisplayNames(["en"], { type: "region" }).of(countryCode) || countryCode;
    const wide = !!p.types?.length && !p.types.some((t) => CITY_TYPES.includes(t));
    return {
        placeRef: p.id,
        city: p.displayName?.text?.trim() || text.trim(),
        country,
        countryCode,
        lat: p.location.latitude,
        lng: p.location.longitude,
        radiusKm: p.viewport ? radiusFromViewport(p.viewport, wide ? MAX_RADIUS_KM.wide : MAX_RADIUS_KM.city) : 25,
    };
}

// ---- Storage ------------------------------------------------------------------

const now = () => new Date().toISOString();

export class RegionStore {
    constructor(private readonly db: DatabaseSync) {}

    list(): RegionRow[] {
        return this.db.prepare("SELECT * FROM regions ORDER BY id").all() as unknown as RegionRow[];
    }

    get(id: number): RegionRow | null {
        return (this.db.prepare("SELECT * FROM regions WHERE id = ?").get(id) as unknown as RegionRow | undefined) ?? null;
    }

    findByLabel(label: string): RegionRow | null {
        return (this.db.prepare("SELECT * FROM regions WHERE lower(label) = lower(?)").get(label.trim()) as unknown as RegionRow | undefined) ?? null;
    }

    findByPlace(placeRef: string): RegionRow | null {
        return (this.db.prepare("SELECT * FROM regions WHERE place_ref = ?").get(placeRef) as unknown as RegionRow | undefined) ?? null;
    }

    insert(r: Omit<RegionRow, "id" | "created_at" | "last_scouted_at" | "active">): number {
        const res = this.db
            .prepare(
                `INSERT INTO regions (label, place_ref, city, country, country_code, lat, lng, radius_km, timezone, currency,
                                      allowed_to_email, legal_basis, send_days, send_start, send_end, keywords, created_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(r.label, r.place_ref, r.city, r.country, r.country_code, r.lat, r.lng, r.radius_km, r.timezone, r.currency, r.allowed_to_email, r.legal_basis, r.send_days, r.send_start, r.send_end, r.keywords, now());
        return Number(res.lastInsertRowid);
    }

    setEmail(id: number, allowed: boolean) {
        this.db.prepare("UPDATE regions SET allowed_to_email = ? WHERE id = ?").run(allowed ? 1 : 0, id);
    }

    setActive(id: number, active: boolean) {
        this.db.prepare("UPDATE regions SET active = ? WHERE id = ?").run(active ? 1 : 0, id);
    }

    setArea(id: number, lat: number, lng: number, radiusKm: number) {
        this.db.prepare("UPDATE regions SET lat = ?, lng = ?, radius_km = ? WHERE id = ?").run(lat, lng, radiusKm, id);
    }

    setKeywords(id: number, keywords: string[] | null) {
        this.db.prepare("UPDATE regions SET keywords = ? WHERE id = ?").run(keywords?.length ? JSON.stringify(keywords) : null, id);
    }

    markScouted(id: number) {
        this.db.prepare("UPDATE regions SET last_scouted_at = ? WHERE id = ?").run(now(), id);
    }

    /**
     * The region from config/region.json (Lagos) as region #1, so existing
     * leads keep working. Leads with no region that are in its country join it.
     */
    ensureDefault(base: RegionConfig): RegionRow {
        const ref = `config:${base.country_code}:${base.city.toLowerCase()}`;
        let r = this.findByPlace(ref);
        if (!r) {
            const id = this.insert({
                label: base.city,
                place_ref: ref,
                city: base.city,
                country: base.country,
                country_code: base.country_code,
                lat: base.lat ?? null,
                lng: base.lng ?? null,
                radius_km: base.radius_km,
                timezone: base.timezone,
                currency: base.currency,
                allowed_to_email: base.allowed_to_email == null ? null : base.allowed_to_email ? 1 : 0,
                legal_basis: base.legal_basis,
                send_days: base.send_window.days,
                send_start: base.send_window.start,
                send_end: base.send_window.end,
                keywords: null,
            });
            r = this.get(id)!;
        }
        this.db.prepare("UPDATE leads SET region_id = ? WHERE region_id IS NULL AND (country IS NULL OR country = ?)").run(r.id, base.country_code);
        return r;
    }
}

/** Look up (or create) the region for something typed in the Scout box. */
export async function ensureRegion(
    regions: RegionStore,
    text: string,
    /** refresh: look the place up again and update its search area (Scout box), instead of trusting what was stored. */
    opts: { apiKey: string; language: string; keywords?: string[] | null; resolve?: typeof resolvePlace; refresh?: boolean },
): Promise<{ region: RegionRow; created: boolean }> {
    const label = text.trim().replace(/\s+/g, " ");
    if (!label || label.length > 80) throw new Error("Type a place name, e.g. Dubai or Austin, Texas");
    const existing = regions.findByLabel(label);
    if (existing) {
        if (opts.refresh && !existing.place_ref?.startsWith("config:")) {
            const fresh = await (opts.resolve ?? resolvePlace)(label, opts.apiKey, opts.language);
            if (fresh.countryCode === existing.country_code) regions.setArea(existing.id, fresh.lat, fresh.lng, fresh.radiusKm);
        }
        if (opts.keywords !== undefined) regions.setKeywords(existing.id, opts.keywords);
        if (!existing.active) regions.setActive(existing.id, true);
        return { region: regions.get(existing.id)!, created: false };
    }
    const place = await (opts.resolve ?? resolvePlace)(label, opts.apiKey, opts.language);
    const same = regions.findByPlace(place.placeRef);
    if (same) {
        if (opts.keywords !== undefined) regions.setKeywords(same.id, opts.keywords);
        if (!same.active) regions.setActive(same.id, true);
        return { region: regions.get(same.id)!, created: false };
    }
    const id = regions.insert({
        label,
        place_ref: place.placeRef,
        city: place.city,
        country: place.country,
        country_code: place.countryCode,
        lat: place.lat,
        lng: place.lng,
        radius_km: place.radiusKm,
        timezone: timezoneFor(place.lat, place.lng),
        currency: currencyFor(place.countryCode),
        allowed_to_email: null, // off until you switch it on for this country
        legal_basis: null,
        send_days: defaultSendDays(place.countryCode),
        send_start: "09:00",
        send_end: "17:00",
        keywords: opts.keywords?.length ? JSON.stringify(opts.keywords) : null,
    });
    return { region: regions.get(id)!, created: true };
}

/** Every region's config, and which one applies to a given lead. */
export class RegionSet {
    readonly rows: RegionRow[];
    private readonly configs = new Map<number, RegionConfig>();

    constructor(
        readonly base: RegionConfig,
        rows: RegionRow[],
    ) {
        this.rows = rows;
        for (const r of rows) this.configs.set(r.id, regionConfig(base, r));
    }

    config(regionId: number): RegionConfig | null {
        return this.configs.get(regionId) ?? null;
    }

    /** A lead's region config; leads from before regions existed fall back to the base country. */
    forLead(lead: Pick<LeadRow, "country"> & { region_id?: number | null }): RegionConfig | null {
        if (lead.region_id != null) {
            const c = this.config(lead.region_id);
            if (c) return c;
            if (this.rows.length) return null; // a region we don't know: don't guess
        }
        if (!lead.country || lead.country === this.base.country_code) return this.base;
        return null;
    }

    label(regionId: number | null | undefined): string | null {
        return this.rows.find((r) => r.id === regionId)?.label ?? null;
    }
}

/** A set with just one config, for callers (and tests) that work on a single region. */
export function singleRegionSet(config: RegionConfig): RegionSet {
    return new RegionSet(config, []);
}
