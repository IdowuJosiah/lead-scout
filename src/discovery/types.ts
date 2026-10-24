import type { RegionConfig } from "../config.js";
import type { Logger } from "../log.js";

/** One business as reported by a discovery source, before dedupe. */
export interface DiscoveredLead {
    name: string;
    /** The product category / keyword this lead was found under. */
    category: string | null;
    address: string | null;
    phone: string | null;
    /** As listed by the source; null when the source lists none. */
    website: string | null;
    /** Stable id within the source (e.g. a Google place id), if it has one. */
    sourceRef: string | null;
    /** Average review rating, review count and open/closed state, when the source has them. */
    rating?: number | null;
    userRatingsTotal?: number | null;
    /** OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY */
    businessStatus?: string | null;
}

export interface DiscoveryContext {
    config: RegionConfig;
    /** Options for this source from config.source_options[source.name]. */
    options: Record<string, unknown>;
    log: Logger;
}

/**
 * A discovery plugin. Implementations yield leads; the runner handles
 * dedupe, storage and failure logging. Throwing from `discover` for one
 * keyword is logged and the run moves on to the next keyword.
 */
export interface DiscoverySource {
    readonly name: string;
    /** Called once per configured search keyword. */
    discover(keyword: string, ctx: DiscoveryContext): AsyncIterable<DiscoveredLead>;
}

export type DiscoverySourceFactory = () => DiscoverySource;
