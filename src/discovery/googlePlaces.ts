import { RateLimiter, sleep } from "../rateLimit.js";
import type { DiscoveredLead, DiscoveryContext, DiscoverySource } from "./types.js";

/**
 * Google Places API (New) Text Search.
 * https://developers.google.com/maps/documentation/places/web-service/text-search
 *
 * Needs GOOGLE_PLACES_API_KEY. The region is a rectangle around the centre
 * (config lat/lng, or the geocoded city) used as a hard locationRestriction,
 * then results are filtered to the configured radius.
 */

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";
const FIELDS = [
    "places.id",
    "places.displayName",
    "places.formattedAddress",
    "places.nationalPhoneNumber",
    "places.internationalPhoneNumber",
    "places.websiteUri",
    "places.location",
    "nextPageToken",
].join(",");

interface Place {
    id: string;
    displayName?: { text?: string };
    formattedAddress?: string;
    nationalPhoneNumber?: string;
    internationalPhoneNumber?: string;
    websiteUri?: string;
    location?: { latitude: number; longitude: number };
}

interface SearchResponse {
    places?: Place[];
    nextPageToken?: string;
}

const EARTH_KM = 6371;
export function haversineKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
    const rad = (d: number) => (d * Math.PI) / 180;
    const dLat = rad(b.lat - a.lat);
    const dLng = rad(b.lng - a.lng);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
    return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

export function boundingBox(c: { lat: number; lng: number }, radiusKm: number) {
    const dLat = radiusKm / 111.32;
    const dLng = radiusKm / (111.32 * Math.max(Math.cos((c.lat * Math.PI) / 180), 0.01));
    return {
        low: { latitude: Math.max(c.lat - dLat, -90), longitude: Math.max(c.lng - dLng, -180) },
        high: { latitude: Math.min(c.lat + dLat, 90), longitude: Math.min(c.lng + dLng, 180) },
    };
}

export class GooglePlacesSource implements DiscoverySource {
    readonly name = "google_places";
    private centre: { lat: number; lng: number } | null = null;
    private limiter: RateLimiter | null = null;

    private apiKey(ctx: DiscoveryContext) {
        const key = (ctx.options.api_key as string | undefined) ?? process.env.GOOGLE_PLACES_API_KEY;
        if (!key) throw new Error("GOOGLE_PLACES_API_KEY is not set");
        return key;
    }

    private async post(body: object, fieldMask: string, ctx: DiscoveryContext): Promise<SearchResponse> {
        this.limiter ??= new RateLimiter(Number(ctx.options.min_interval_ms ?? 500));
        for (let attempt = 0; ; attempt++) {
            await this.limiter.wait();
            const res = await fetch(ENDPOINT, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Goog-Api-Key": this.apiKey(ctx),
                    "X-Goog-FieldMask": fieldMask,
                },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(30_000),
            });
            if (res.ok) return (await res.json()) as SearchResponse;
            const text = (await res.text()).slice(0, 500);
            if ((res.status === 429 || res.status >= 500) && attempt < 3) {
                const backoff = 2000 * 2 ** attempt;
                ctx.log.warn(`google_places: HTTP ${res.status}, retrying in ${backoff}ms`);
                await sleep(backoff);
                continue;
            }
            throw new Error(`Places API HTTP ${res.status}: ${text}`);
        }
    }

    private async resolveCentre(ctx: DiscoveryContext) {
        if (this.centre) return this.centre;
        const { config } = ctx;
        if (config.lat !== undefined && config.lng !== undefined) {
            this.centre = { lat: config.lat, lng: config.lng };
        } else {
            const res = await this.post(
                { textQuery: `${config.city}, ${config.country}`, languageCode: config.language, regionCode: config.country_code, pageSize: 1 },
                "places.location,places.formattedAddress",
                ctx,
            );
            const loc = res.places?.[0]?.location;
            if (!loc) throw new Error(`Could not geocode "${config.city}, ${config.country}"; set lat/lng in config`);
            this.centre = { lat: loc.latitude, lng: loc.longitude };
            ctx.log.info(`google_places: centre for ${config.city} resolved to ${loc.latitude},${loc.longitude}`);
        }
        return this.centre;
    }

    async *discover(keyword: string, ctx: DiscoveryContext): AsyncIterable<DiscoveredLead> {
        const { config } = ctx;
        const centre = await this.resolveCentre(ctx);
        const maxPages = Number(ctx.options.max_pages ?? 3); // API caps at 60 results (3 x 20)
        let pageToken: string | undefined;

        for (let page = 0; page < maxPages; page++) {
            const res = await this.post(
                {
                    textQuery: `${keyword} in ${config.city}`,
                    languageCode: config.language,
                    regionCode: config.country_code,
                    pageSize: 20,
                    locationRestriction: { rectangle: boundingBox(centre, config.radius_km) },
                    ...(pageToken ? { pageToken } : {}),
                },
                FIELDS,
                ctx,
            );
            for (const p of res.places ?? []) {
                if (p.location && haversineKm(centre, { lat: p.location.latitude, lng: p.location.longitude }) > config.radius_km) {
                    continue;
                }
                const name = p.displayName?.text?.trim();
                if (!name) continue;
                yield {
                    name,
                    category: keyword,
                    address: p.formattedAddress ?? null,
                    phone: p.internationalPhoneNumber ?? p.nationalPhoneNumber ?? null,
                    website: p.websiteUri ?? null,
                    sourceRef: p.id,
                };
            }
            pageToken = res.nextPageToken;
            if (!pageToken) break;
        }
    }
}
