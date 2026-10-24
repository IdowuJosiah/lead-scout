import { readFileSync } from "node:fs";
import type { DiscoveredLead, DiscoveryContext, DiscoverySource } from "./types.js";

/**
 * Leads from a local JSON file: an array of
 * { name, category?, address?, phone?, website?, id? }.
 * Useful for hand-collected lists from directories or marketplaces.
 * Configure with source_options.json_file.path. Entries whose category does
 * not match the keyword are skipped, so each entry is read once per category;
 * entries with no category are yielded under the first keyword only.
 */
export class JsonFileSource implements DiscoverySource {
    readonly name = "json_file";

    async *discover(keyword: string, ctx: DiscoveryContext): AsyncIterable<DiscoveredLead> {
        const path = ctx.options.path;
        if (typeof path !== "string") throw new Error("source_options.json_file.path is not set");
        const rows = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!Array.isArray(rows)) throw new Error(`${path} must contain a JSON array`);
        const first = ctx.config.search_keywords[0];

        for (const r of rows as Record<string, unknown>[]) {
            const s = (k: string) => (typeof r[k] === "string" && (r[k] as string).trim() ? (r[k] as string).trim() : null);
            const name = s("name");
            if (!name) continue;
            const category = s("category");
            if (category ? category.toLowerCase() !== keyword.toLowerCase() : keyword !== first) continue;
            yield {
                name,
                category: category ?? null,
                address: s("address"),
                phone: s("phone"),
                website: s("website"),
                sourceRef: s("id"),
                rating: typeof r.rating === "number" ? r.rating : null,
                userRatingsTotal: typeof r.user_ratings_total === "number" ? r.user_ratings_total : null,
                businessStatus: s("business_status"),
            };
        }
    }
}
