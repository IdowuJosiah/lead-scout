# lead-scout

A TypeScript CLI that finds small-to-medium brands in a region, audits their
web presence on a mobile viewport, and ranks them by how much they need an
ecommerce site. Plain Node, with no framework.

```
discover  ->  SQLite (data/leads.db)  ->  audit  ->  export  ->  output/leads.csv
                                                          output/screenshots/*.png
```

## Setup

```bash
git clone https://github.com/IdowuJosiah/lead-scout.git
cd lead-scout
npm install
npx playwright install chromium      # once, if Chromium isn't already installed
export GOOGLE_PLACES_API_KEY=...      # Places API (New) must be enabled for the key
```

Node 22.19+ is required (it uses the built-in `node:sqlite`, so there's no native addon to compile).

## Usage

```bash
npm run cli -- run                       # discover + audit + export
npm run cli -- discover                  # stage 1 only
npm run cli -- audit --no-lighthouse     # stage 2, fast mode
npm run cli -- audit --reaudit --ids 12,40
npm run cli -- export                    # rescore and write leads.csv
npm run cli -- failures                  # per-lead failure log
npm run cli -- stats
npm run cli -- --help                    # all flags
```

Flags override `config/region.json`. Example:
`npm run cli -- discover --city Abuja --radius-km 15 --keywords "skincare,perfume"`.

## Config (`config/region.json`)

| key | meaning |
|---|---|
| `country` | ISO code. Used as the Places `regionCode` |
| `city`, `radius_km` | Search area. The centre is geocoded from the city unless `lat`/`lng` are set. Results outside the radius are dropped |
| `language` | Places `languageCode` and Lighthouse locale |
| `currency` | Recorded as `local_currency_on_homepage` when the code or a distinctive symbol (₦, £, €…) appears |
| `search_keywords` | Product categories. One search per keyword per source |
| `payment_providers` | Names (`"Paystack"`), domains (`"pay.example.com"`) or `{ "name", "domains", "match_text" }`. Known names map to their domains. Name-in-text matching is on only for providers with no known domains |
| `sources` | Discovery plugins to run (default `["google_places"]`) |
| `source_options` | Per-source options, e.g. `{ "json_file": { "path": "leads.json" } }` |

## Stage 1: discovery plugins

A source implements `DiscoverySource` (`src/discovery/types.ts`). It yields
`{ name, category, address, phone, website, sourceRef }` per keyword. The
runner handles dedupe, storage and failure logging. To add one, write the
class and register it in `SOURCES` in `src/discovery/index.ts`.

Bundled sources:

- `google_places`: Places API (New) Text Search. The search is restricted to a box around the centre, then filtered to the radius. It reads up to 60 results per keyword and is rate-limited, with backoff on 429/5xx.
- `json_file`: a hand-collected JSON array, for directories or marketplaces you scrape or copy by hand.

Dedupe works on website domain. On shared hosts (instagram.com/x, wa.me/…,
linktr.ee/x) it uses host + profile instead. With no website, it uses
normalised name + address. A `(source, source_ref)` match is checked first,
so re-running discovery merges instead of duplicating. Leads with no website
get `high_priority = 1`.

## Stage 2: audit

The audit runs only for leads with a website. Each lead goes through these steps:

1. **URL class.** Social profiles and WhatsApp links are recorded from the URL and not loaded. Link-in-bio pages (Linktree etc.) are flagged and then loaded if robots.txt allows.
2. **robots.txt** (RFC 9309), checked against the `LeadScout` token. 4xx means no rules and 5xx means disallow. `Crawl-delay` is honoured. If HTTPS refuses the connection, it falls back to plain HTTP once.
3. **Playwright, Pixel 7 profile.** Records the load time (Navigation Timing `loadEventEnd`), HTTP status and final URL, and saves a viewport screenshot.
4. **Detection** on the homepage (`src/audit/detect.ts`). Every hit records the signal that matched:
   - platform (Shopify / WooCommerce / Wix / Squarespace / BigCommerce / Ecwid / Bumpa / Selar / WordPress / `custom` = no known signature)
   - cart / checkout links, buttons and forms
   - configured payment providers, from network requests, page source or text
   - WhatsApp links. A site counts as *WhatsApp-order-only* when it has WhatsApp links and no cart or checkout.
5. **SSL**: whether the page loaded over HTTPS with a valid cert. An invalid cert is recorded, then the page is loaded anyway. For sites served over HTTP, port 443 is probed.
6. **Lighthouse** mobile performance score, run in the same Chromium. Skip it with `--no-lighthouse`; it adds roughly 20s per site.

Requests to a host are spaced at least `--delay-ms` apart (default 3s). The audit is sequential.

| status | meaning | scored? |
|---|---|---|
| `ok` | loaded and inspected | yes |
| `unreachable` | DNS/connection failure, timeout with no response, or HTTP 404/5xx | yes (broken site) |
| `social_profile` / `whatsapp_link` | the listed website is a profile or chat link | yes |
| `robots_disallowed` | robots.txt forbids it, so nothing was fetched | only if the URL itself is link-in-bio |
| `blocked` | 401/403/429, usually a bot wall | no |
| `failed` | internal error, nothing reliable measured | no (retried next run) |

Re-running `audit` processes only new leads and `failed` ones. `--reaudit`
redoes everything. There is one audit row per lead, and its screenshot is
overwritten. Each lead's failure goes to the `failures` table and stderr, and
the run carries on.

## Scoring (`src/scoring.ts`)

All weights and thresholds are in that one file.

```
no website                    = 100
otherwise: baseline 5
  + the largest primary gap:  link-in-bio only 90 · WhatsApp-order-only 85 · unreachable 80 · no cart/checkout 60
  + secondary issues:         load timeout 30 | >10s 25 | >5s 15 · Lighthouse <50 20 | <90 8
                              no valid SSL 10 · store with no detected payment provider 5
  capped at 99, so "no website" always ranks first
```

Bands: high ≥ 60, medium ≥ 25, low < 25. A good modern store scores 5.
Leads that couldn't be inspected get **no score**, not a guess.

## Output: `output/leads.csv`

Sorted by `lead_score` descending, with unscored leads last. Columns include
the audit fields, `screenshot_path`, `score_breakdown` and `evidence`.

`evidence` is a single line assembled only from stored measurements, e.g.
`https://brand.ng/ loaded in 6.2s on Pixel 7 viewport; HTTP 200; Lighthouse mobile performance 34/100; platform Wix (x-wix-request-id response header); no cart or checkout found on homepage; 2 WhatsApp link(s) on homepage; valid HTTPS`.
Negative findings are scoped to what was checked ("on homepage"). Nothing is inferred.

## Tests

```bash
npm test                  # unit tests + end-to-end audit against local fixture sites
LIGHTHOUSE=1 npm test     # also run Lighthouse in the end-to-end test
npm run typecheck
```

## Limits

- Only the homepage is inspected. A store whose cart or payment script appears only on deeper pages reads as "not found on homepage". The evidence wording says so.
- Platform detection is signature-based. Unknown or headless stacks show as `custom`.
- Node's `http`/`fetch` ignore `HTTPS_PROXY`. Chromium uses it when set.
