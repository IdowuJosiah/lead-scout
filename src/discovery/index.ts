import type { RegionConfig } from "../config.js";
import type { LeadStore } from "../db.js";
import { errMessage, log } from "../log.js";
import { dedupeKey, parseWebsite, websiteDomain } from "../url.js";
import { GooglePlacesSource } from "./googlePlaces.js";
import { JsonFileSource } from "./jsonFile.js";
import type { DiscoverySourceFactory } from "./types.js";

/** Register new sources here. The key is the name used in config `sources`. */
export const SOURCES: Record<string, DiscoverySourceFactory> = {
    google_places: () => new GooglePlacesSource(),
    json_file: () => new JsonFileSource(),
};

export interface DiscoverySummary {
    seen: number;
    inserted: number;
    merged: number;
    failures: number;
}

export async function runDiscovery(store: LeadStore, config: RegionConfig): Promise<DiscoverySummary> {
    const summary: DiscoverySummary = { seen: 0, inserted: 0, merged: 0, failures: 0 };

    for (const sourceName of config.sources) {
        const factory = SOURCES[sourceName];
        if (!factory) {
            const msg = `Unknown discovery source "${sourceName}" (known: ${Object.keys(SOURCES).join(", ")})`;
            log.error(msg);
            store.logFailure(null, "discover", msg);
            summary.failures++;
            continue;
        }
        const source = factory();
        const ctx = { config, options: config.source_options?.[sourceName] ?? {}, log };

        for (const keyword of config.search_keywords) {
            let count = 0;
            try {
                for await (const found of source.discover(keyword, ctx)) {
                    summary.seen++;
                    count++;
                    try {
                        const site = parseWebsite(found.website);
                        if (found.website && !site) log.warn(`${source.name}: ignoring unparseable website "${found.website}" for ${found.name}`);
                        const { inserted } = store.upsertLead({
                            name: found.name,
                            category: found.category,
                            address: found.address,
                            phone: found.phone,
                            website_url: site ? site.href : null,
                            website_domain: site ? websiteDomain(site) : null,
                            source: source.name,
                            source_ref: found.sourceRef,
                            dedupe_key: dedupeKey(found.name, found.address, site),
                        });
                        if (inserted) summary.inserted++;
                        else summary.merged++;
                    } catch (err) {
                        summary.failures++;
                        const msg = `${source.name} "${keyword}": could not store ${found.name}: ${errMessage(err)}`;
                        log.error(msg);
                        store.logFailure(null, "discover", msg);
                    }
                }
                log.info(`${source.name}: "${keyword}" -> ${count} results`);
            } catch (err) {
                summary.failures++;
                const msg = `${source.name} "${keyword}" failed after ${count} results: ${errMessage(err)}`;
                log.error(msg);
                store.logFailure(null, "discover", msg);
            }
        }
    }
    return summary;
}
