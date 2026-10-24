# lead-scout

A TypeScript CLI that finds small-to-medium brands in a region, audits their
web presence on a mobile viewport, and ranks them by how much they need an
ecommerce site. Plain Node, with no framework.

```
discover -> audit -> contacts -> export
   |          |          |          output/leads.csv, output/screenshots/*.png
   +----------+----------+-------> output/email_queue.csv, output/fallback_queue.csv
              SQLite (data/leads.db)
```

## Setup

```bash
git clone https://github.com/IdowuJosiah/lead-scout.git
cd lead-scout
npm install
npx playwright install chromium      # once, if Chromium isn't already installed
export GOOGLE_PLACES_API_KEY=...      # Places API (New) must be enabled for the key
export HUNTER_API_KEY=...             # stage 3 only
export ZEROBOUNCE_API_KEY=...         # stage 3 only
```

Node 22.19+ is required (it uses the built-in `node:sqlite`, so there's no native addon to compile).

## Usage

```bash
npm run cli -- run                       # discover + audit + contacts + export
npm run cli -- discover                  # stage 1 only
npm run cli -- audit --no-lighthouse     # stage 2, fast mode
npm run cli -- audit --upgrade           # re-check leads audited by an older version
npm run cli -- audit --reaudit --ids 12,40
npm run cli -- contacts --dry-run        # stage 3: show paid calls needed, spend nothing
npm run cli -- contacts                  # stage 3: asks before any paid call
npm run cli -- reconcile                 # re-score, clean stage 3 results, report, rewrite CSVs
npm run cli -- export                    # rescore and write all CSVs
npm run cli -- failures                  # per-lead failure log
npm run cli -- stats
npm run cli -- --help                    # all flags
```

Flags override `config/region.json`. Example:
`npm run cli -- discover --city Abuja --radius-km 15 --keywords "skincare,perfume"`.

## Config (`config/region.json`)

| key | meaning |
|---|---|
| `country` | Country name, used in searches (e.g. `Nigeria`) |
| `country_code` | ISO code (e.g. `NG`): Places `regionCode`, phone parsing, the `country` column in the queues. Older configs that put the code in `country` still work |
| `timezone` | IANA timezone (e.g. `Africa/Lagos`), written to the queues with `send_window` |
| `send_window` | When outreach may go out, local time: `{ "days": "Mon-Fri", "start": "09:00", "end": "17:00" }` |
| `allowed_to_email` | `true` or `false`. **Unset counts as false**: nothing is queued for email |
| `legal_basis` | Short free-text note on why contacting these businesses is permitted; copied into `email_queue.csv`. You are responsible for checking it |
| `contact_min_score` | Stage 3 only processes leads scoring at least this (default 60) |
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

Google Places also gives each lead's `rating`, `user_ratings_total` (review
count) and `business_status`. Permanently closed businesses are not scored.
Leads discovered before these fields existed get them the next time discovery
finds them.

Dedupe works on website domain. On shared hosts (instagram.com/x, wa.me/…,
linktr.ee/x) it uses host + profile instead. With no website, it uses
normalised name + address. A `(source, source_ref)` match is checked first,
so re-running discovery merges instead of duplicating. Leads with no website
get `high_priority = 1`.

## Website classes

Every lead's listed website gets one class (`website_class` in the CSV):

| class | meaning |
|---|---|
| `none` | no website listed |
| `owned_site` | the brand's own domain, which loaded |
| `social` | an Instagram / Facebook / TikTok / X profile |
| `messaging` | a chat link: wa.me, api.whatsapp.com, t.me, m.me |
| `link_in_bio` | Linktree, Beacons, bio.link and similar |
| `hosted_storefront` | a shop on a platform's domain: Bumpa, Selar, Paystack/Flutterwave stores, Jumia, Konga, Jiji, myshopify.com, wixsite.com, … |
| `dead_listing` | proven not to exist: DNS failure, connection refused, HTTP 404/410, or a parked/for-sale domain |

An own domain that redirects to Instagram or a marketplace takes the class of where it lands.

## Stage 2: audit

The audit runs only for leads with a website. Each lead goes through these steps:

1. **URL class.** Social profiles and chat links are recorded from the URL and not loaded. Link-in-bio pages (Linktree etc.) are flagged and then loaded if robots.txt allows.
2. **robots.txt** (RFC 9309), checked against the `LeadScout` token. 4xx means no rules and 5xx means disallow. `Crawl-delay` is honoured. If HTTPS refuses the connection, it falls back to plain HTTP once.
3. **Playwright, Pixel 7 profile.** Records the load time (Navigation Timing `loadEventEnd`), HTTP status and final URL, and saves a viewport screenshot.
4. **Detection** on the homepage (`src/audit/detect.ts`). Every hit records the signal that matched:
   - platform (Shopify / WooCommerce / Wix / Squarespace / BigCommerce / Ecwid / Bumpa / Selar / WordPress / `custom` = no known signature)
   - cart / checkout links, buttons and forms. If the homepage has none, up to 3 of the site's own shop pages (`/shop`, `/products`, `/collections`, …) are loaded and checked too
   - a password page (e.g. Shopify's "opening soon" `/password` page): the store exists but is closed to the public
   - a parked or for-sale domain, which makes it a `dead_listing`
   - configured payment providers, from network requests, page source or text
   - WhatsApp links. A site counts as *WhatsApp-order-only* when it has WhatsApp links and no cart or checkout.
5. **SSL**: whether the page loaded over HTTPS with a valid cert. An invalid cert is recorded, then the page is loaded anyway. For sites served over HTTP, port 443 is probed.
6. **Lighthouse** mobile performance score, run in the same Chromium. Skip it with `--no-lighthouse`; it adds roughly 20s per site. When our own page load timed out, Lighthouse is skipped, so the two results can never contradict each other.

Requests to a host are spaced at least `--delay-ms` apart (default 3s). The audit is sequential.

| status | meaning | scored? |
|---|---|---|
| `ok` | loaded and inspected | yes |
| `dead` | DNS failure, connection refused, HTTP 404/410, parked domain | yes (`dead_listing`) |
| `unreachable` | transient: timeout with no response, HTTP 5xx, reset | only after failing on 2 separate runs (retried automatically) |
| `social_profile` / `messaging_link` | the listed website is a profile or chat link | yes |
| `robots_disallowed` | robots.txt forbids it, so nothing was fetched | only if the URL itself is link-in-bio |
| `blocked` | 401/403/429, usually a bot wall | no |
| `failed` | internal error, nothing reliable measured | no (retried next run) |

Re-running `audit` processes only new leads, `failed` ones, and sites that
were `unreachable` once. `--upgrade` also redoes audits made by an older
version of these checks. `--reaudit` redoes everything. There is one audit row per lead, and its screenshot is
overwritten. Each lead's failure goes to the `failures` table and stderr, and
the run carries on.

## Scoring (`src/scoring.ts`)

All weights and thresholds are in that one file.

```
no website                    = 100
otherwise: baseline 5
  + the largest primary gap:  dead listing 90 · social only 90 · link-in-bio only 90 · chat link only 85
                              WhatsApp-order-only 85 · unreachable on 2 runs 80 · password-protected 70
                              no cart/checkout 60 · hosted storefront 40
  + secondary issues:         load timeout 30 | >10s 25 | >5s 15 · Lighthouse <50 20 | <90 8 (not after a timeout)
                              no valid SSL 10 · store with no detected payment provider 5
  capped at 99, so "no website" always ranks first
```

Bands: high ≥ 60, medium ≥ 25, low < 25. A good modern store scores 5.
Leads that couldn't be inspected get **no score**, not a guess. Neither do
permanently closed businesses. Ties are broken by Google review count (more
reviews first), then name.

## Stage 3: contacts (email first)

The contacts stage runs for leads with `lead_score >= contact_min_score` and
an `owned_site`. Hosted storefronts, social profiles and chat links are never
contacted this way. For each lead:

1. **Site pages.** It fetches the homepage, `/contact`, `/about` and `/contact-us`, respecting robots.txt and the rate limits, and extracts `mailto:` links and addresses in visible text (Cloudflare-protected ones included). Addresses in scripts are ignored.
2. **Domain rule.** Only addresses at the lead's own domain, or at a free mailbox provider (gmail, yahoo, …), are kept. Free-mailbox addresses are flagged. Anything at another business's domain is dropped and noted in the evidence, e.g. the web designer's `dev@agency.io` in the footer.
3. **Hunter.** If the site published no usable address, it runs a [Hunter](https://hunter.io) domain search, keeping only addresses Hunter actually saw on the web at that domain. It never guesses an address from a pattern.
4. **Classification.** Each address is classed `personal`, `role` (info@, hello@, sales@…) or `free_provider`. The preference order is personal > role > free_provider.
5. **ZeroBounce** verifies the best few (`--max-verify`, default 3). Only `valid` addresses, or `catch-all` ones with a risk flag, are queued. Invalid, unknown, spamtrap and do-not-mail addresses never are.
6. **Fallback.** A lead with no usable email goes to `fallback_queue.csv` with its best other channel, in this order: a WhatsApp link the site publishes; a `wa.me` link built from a listed *mobile* number (whether that number uses WhatsApp isn't checked); otherwise the phone number.

If `allowed_to_email` is not `true`, no paid lookups run and every lead goes to the fallback queue.

**Paid calls are cached and confirmed.** Hunter results are cached per domain
and ZeroBounce results per address in SQLite, so nothing is paid for twice.
Before any paid call, the run does all the free work first, then prints
exactly how many Hunter and ZeroBounce calls it needs, and asks:

```
About to make 7 paid call(s): 2 Hunter, 5 ZeroBounce (+ up to 6 ZeroBounce for addresses Hunter returns), for 6 lead(s). Continue? [y/N]
```

Answer `n` and nothing is spent: those leads stay pending for a later run.
`--dry-run` shows the numbers and stops. `--yes` approves without asking, which
is needed when there's no terminal to answer in.

### `reconcile`

`npm run cli -- reconcile` brings stored results in line with the current
rules, without fetching anything or making any paid call:

1. It re-scores every lead with the current logic.
2. It removes stage 3 results for leads whose website is not an `owned_site`, and any queued email at a domain other than the lead's own. Free-provider emails stay, with a flag.
3. It prints how many emails were invalidated and why, then rewrites all three CSVs from the database.

Invalidated leads are processed again by the next `contacts` run, using every cached lookup.

### Queue files

`email_queue.csv` has these columns: name, email, email_type, verification_status, evidence, lead_score, country, then risk_flag, email_source, website, timezone, send_window, legal_basis.

`fallback_queue.csv` has these columns: name, channel, contact, channel_note, phone, reason, lead_score, country, website, evidence, timezone, send_window.

Both are rebuilt from the database each time, and sorted by score, then by review count.

## Output: `output/leads.csv`

The CSV is kept up to date while the tool runs. It is written after
discovery, again every 5 audited sites (change this with `--csv-every <n>`,
or use `0` for only at the end), and when the run finishes. Pressing
**Ctrl+C** also writes it before stopping. Everything audited so far is saved,
and the next `audit` run continues from where it stopped.

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

- Cart detection covers the homepage plus up to 3 linked shop pages. A store that only shows its cart deeper than that reads as "not found", and the evidence names the pages that were checked.
- `personal` means "not a known role mailbox". The tool can't confirm that an address belongs to a named person.
- Platform detection is signature-based. Unknown or headless stacks show as `custom`.
- Node's `http`/`fetch` ignore `HTTPS_PROXY`. Chromium uses it when set.
