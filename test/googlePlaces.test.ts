import assert from "node:assert/strict";
import { after, it } from "node:test";
import { resolveConfig } from "../src/config.js";
import { GooglePlacesSource } from "../src/discovery/googlePlaces.js";
import { log } from "../src/log.js";

const realFetch = globalThis.fetch;
after(() => {
    globalThis.fetch = realFetch;
});

it("geocodes the city, pages through results and enforces the radius", async () => {
    const calls: { body: Record<string, unknown>; headers: Record<string, string> }[] = [];
    globalThis.fetch = (async (_url: string, init: RequestInit) => {
        const body = JSON.parse(init.body as string);
        calls.push({ body, headers: init.headers as Record<string, string> });
        const json =
            calls.length === 1
                ? { places: [{ location: { latitude: 6.5, longitude: 3.4 } }] }
                : calls.length === 2
                  ? {
                        places: [
                            { id: "p1", displayName: { text: "Near Brand" }, websiteUri: "https://near.example", location: { latitude: 6.51, longitude: 3.41 } },
                            { id: "p2", displayName: { text: "Far Brand" }, location: { latitude: 7.5, longitude: 3.4 } },
                        ],
                        nextPageToken: "t2",
                    }
                  : { places: [{ id: "p3", displayName: { text: "No Site" }, nationalPhoneNumber: "0801", location: { latitude: 6.5, longitude: 3.4 } }] };
        return new Response(JSON.stringify(json), { status: 200 });
    }) as typeof fetch;

    const config = resolveConfig({ country: "NG", city: "Lagos", radius_km: 20, language: "en", currency: "NGN", search_keywords: ["fashion"] });
    const leads = [];
    for await (const l of new GooglePlacesSource().discover("fashion", { config, options: { api_key: "k", min_interval_ms: 0 }, log })) leads.push(l);

    assert.deepEqual(leads.map((l) => l.name), ["Near Brand", "No Site"], "Far Brand (~110km) filtered out");
    assert.equal(leads[0]!.website, "https://near.example");
    assert.equal(leads[1]!.website, null);
    assert.equal(leads[1]!.phone, "0801");
    assert.equal(calls[1]!.body.textQuery, "fashion in Lagos");
    assert.equal(calls[1]!.headers["X-Goog-Api-Key"], "k");
    assert.ok(calls[1]!.body.locationRestriction);
    assert.equal(calls[2]!.body.pageToken, "t2");
});
