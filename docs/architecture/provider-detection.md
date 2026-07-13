# Provider detection

When a source is onboarded, we try to recognize the **hosting platform** behind
its changelog (Mintlify, Ghost, Blume, …) so we can skip guesswork and route
straight to the best ingestion method — a known RSS path, a `.md` suffix, or a
crawl pattern. Detection is a pure, table-driven lookup, consumed by `evaluate.ts`
during onboarding. The code lives in [`packages/ai/src/providers/`](../../packages/ai/src/providers/):

- [`definitions.ts`](../../packages/ai/src/providers/definitions.ts) — the `PROVIDERS` table (data; the source of truth for what we recognize).
- [`detect.ts`](../../packages/ai/src/providers/detect.ts) — the detection pipeline (fixed machinery; doesn't grow per provider).
- [`types.ts`](../../packages/ai/src/providers/types.ts) — the `ProviderDef` / `ProviderHints` shapes.
- [`index.ts`](../../packages/ai/src/providers/index.ts) — the public barrel (`@releases/ai-internal/providers`).

This doc is the engineering reference: how detection works, every platform we
currently recognize, and the recipe for adding a new one. For the operational
onboarding view (what an agent does with a URL), see the
[`finding-changelogs`](../../.claude/skills/finding-changelogs/SKILL.md) skill.

## How detection works

`detectProvider(url)` runs three signals in order and returns on the first hit:

1. **URL** (`detectFromUrl`) — hostname matches a provider's known CNAME target
   or `hostPatterns`. No network. Fast path for platforms served from a branded
   domain (e.g. `*.mintlify.app`).
2. **DNS** (`detectViaDns`) — resolves the hostname's `CNAME` via
   DNS-over-HTTPS and matches it against `provider.cnames`. Catches custom
   domains that still point at the platform's infra.
3. **HTTP** (`detectFromHttpSignals`) — fetches the page and matches
   `provider.headers` (response headers) and `provider.htmlPatterns` (substrings
   in the HTML).

Matching is **first-match-wins** in array order, so more-specific providers must
be listed before looser ones (see the Document360-before-Ghost note in the
table).

> **⚠️ `htmlPatterns` only sees `<head>`.** `fetchHttpSignals` streams the
> response body only until `</head>` (or 32 KB). A marker that lives in `<body>`
> — a footer badge, a search widget's bootstrap `<script>`, a nav data-attribute
> — will **never** match. Pick a marker you've confirmed sits inside `<head>`:
> an inline `<script>`, a `<meta>`/`<link>`, or an asset URL in a head `<link>`.

Once detected, the provider's `id` is stored on `SourceMetadata.provider`, and
its `hints` drive follow-up probes:

| `ProviderHints` field | Effect                                                                                                                                                                                                                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feedPaths`           | Candidate RSS/Atom/JSON-feed paths probed by `tryProviderFeeds`. Each is tried both origin-relative (`{origin}{path}`) and changelog-relative (`{origin}{changelogPath}{path}`), so onboarding from either the site root or the `/changelog` page resolves the feed. |
| `markdownSuffix`      | If true, probe `{url}.md` for a raw-markdown mirror.                                                                                                                                                                                                                 |
| `changelogPaths`      | Well-known changelog locations to try when the input URL is a bare domain.                                                                                                                                                                                           |
| `crawlPattern`        | Glob for multi-page (per-entry) changelogs consumed by crawl mode.                                                                                                                                                                                                   |
| `preferredType`       | `"feed"` or `"scrape"` — the default ingestion route.                                                                                                                                                                                                                |
| `staticContent`       | Content is present in the initial HTML (no JS render). Lets the scrape path use Cloudflare's crawl API with `render: false` (~10–30× faster).                                                                                                                        |

## Supported platforms

Snapshot of `PROVIDERS` — the code is authoritative. **Feed** = an RSS/Atom/JSON
feed we can consume directly; **Scrape** = per-page HTML (crawl or single-page).

### Feed-based

| Platform            | Detection signal                                                   | Feed path(s)                                         | Notes                                                                                                                                                        |
| ------------------- | ------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Mintlify            | CNAME `mintlify.app/.dev`, `x-mintlify` header, `mintlify` in head | `/rss.xml`                                           | `.md` suffix works; static.                                                                                                                                  |
| Fern                | CNAME `buildwithfern.com`, `buildwithfern`/`fern-docs` in head     | `/changelog.rss`, `/docs/changelog.rss`              | Static. `<generator>` = `buildwithfern.com`.                                                                                                                 |
| ReadMe              | CNAME `readme.io`, `x-readme-version` header                       | `/changelog.rss`                                     | —                                                                                                                                                            |
| Docusaurus          | `docusaurus`/`__docusaurus` in head                                | `/blog/rss.xml`, `/blog/atom.xml`, `/blog/feed.json` | Static.                                                                                                                                                      |
| Ghost               | `x-ghost-cache-status` header, `ghost-` in head, CNAME `ghost.io`  | `/rss/`, `/rss`                                      | Static. Listed **after** Document360 (its bundle emits a `ghost-`-ish token).                                                                                |
| WordPress           | `wp-content`/`wp-json` in head                                     | `/feed/`, `/feed`                                    | Static.                                                                                                                                                      |
| Hashnode            | CNAME `hashnode.network/.dev`, `hashnode` in head                  | `/rss.xml`                                           | Static.                                                                                                                                                      |
| Nextra              | `nextra`/`__nextra` in head                                        | `/feed.xml`, `/rss.xml`                              | Static.                                                                                                                                                      |
| VitePress           | `vitepress`/`VPContent` in head                                    | `/feed.xml`, `/feed.rss`                             | Static.                                                                                                                                                      |
| Blume               | `blume-theme`/`data-blume-` in head                                | `/changelog/rss.xml`, `/rss.xml`                     | Self-hosted Astro generator. RSS items are title-only → auto-enriched by following each entry link. Feed served as generic `application/xml` (body-sniffed). |
| Vercel/Next.js Docs | `__next` in head                                                   | `/feed.xml`, `/rss.xml`, `/changelog/rss.xml`        | —                                                                                                                                                            |
| Productboard        | CNAME `productboard.com`, `productboard` in head                   | `/changelog.rss`, `/changelog/feed`                  | —                                                                                                                                                            |
| Headway             | CNAME `headwayapp.co`, `headway-widget` in head                    | `/feed`                                              | —                                                                                                                                                            |
| Beamer              | CNAME `getbeamer.com`, `beamer` in head                            | `/feed`                                              | —                                                                                                                                                            |
| LaunchNotes         | CNAME `launchnotes.io/.com`, `launchnotes` in head                 | `/rss`                                               | —                                                                                                                                                            |

### Scrape-based

| Platform              | Detection signal                                         | Route                                                    | Notes                                                                                                     |
| --------------------- | -------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| GitBook               | CNAME `gitbook.io`, `gitbook` in head                    | scrape                                                   | —                                                                                                         |
| Document360           | `document360` in head                                    | scrape (static)                                          | No public feed; single-page "what's new". Listed **before** Ghost.                                        |
| Notion (Super/Potion) | CNAME `super.so`/`potion.so`, `notion-` in head          | crawl `/**`                                              | —                                                                                                         |
| Intercom              | CNAME `intercom.help`, `x-intercom-version` header       | crawl `/en/articles/**`                                  | —                                                                                                         |
| Zendesk               | CNAME `zendesk.com`, `x-zendesk-request-id` header       | Help Center API (`type: "feed"` + `metadata.helpCenter`) | Section index is JS-rendered; ingest via the articles.json endpoint, not RSS. See [ingest.md](ingest.md). |
| Help Scout            | CNAME `helpscoutdocs.com`, `helpscout`/`beacon-` in head | crawl `/article/**`                                      | —                                                                                                         |
| Freshdesk             | CNAME `freshdesk.com`, `x-freshdesk-api-version` header  | crawl `/support/solutions/articles/**`                   | —                                                                                                         |
| Confluence            | CNAME `atlassian.net`, `confluence`/`atlassian` in head  | scrape                                                   | —                                                                                                         |
| Canny                 | CNAME `canny.io`, `canny` in head                        | scrape                                                   | —                                                                                                         |

## Adding a new provider

The whole change is usually one `PROVIDERS` entry plus a test. **Investigate the
live site first** — don't guess paths or markers; fetch and confirm every one.
Blume ([`id: "blume"`](../../packages/ai/src/providers/definitions.ts)) is a clean worked
example of every step below.

1. **Confirm it's a distinct platform.** Is there a fingerprint you can detect
   reliably across _customer_ sites, not just the vendor's own site? (og:site_name
   and page titles are vendor-specific and won't generalize.)

2. **Find an in-`<head>` detection marker.** Fetch the page and check the byte
   offset of your candidate marker against `</head>`:

   ```
   curl -sL -A 'ReleasesBot/1.0' <url> -o page.html
   python3 -c "h=open('page.html').read(); e=h.lower().find('</head>'); \
     i=h.find('<marker>'); print('in_head:', 0<=i<e)"
   ```

   Prefer a stable CNAME or a custom response header when one exists (cheapest,
   most robust). Fall back to an HTML marker that lives in `<head>` — an inline
   `<script>` string, a `<meta>`, or a head `<link>` asset URL.

3. **Find the feed (or decide it's scrape).** Probe candidate feed paths against
   the live site and record which return valid XML/JSON. List the most specific
   absolute path **first** in `feedPaths` so onboarding from the site root still
   resolves it (autodiscovery `<link>` tags often live only on the changelog
   page). Note the feed's `content-type`: if it's generic `application/xml` /
   `text/xml`, `tryProviderFeeds` body-sniffs it — no extra work, but be aware
   `classifyFeedMime` alone won't recognize it.

4. **Check whether feed items carry bodies.** Some feeds (Blume, some help
   centers) emit title-only items. That's fine — if each item's `link` is a clean
   permalink (`isEnrichableUrl`), the feed is auto-flagged `summary-only` and the
   enricher fetches each entry for content. If the links are `#fragment`s into one
   shared page, enrichment can't isolate entries — prefer `scrape`. See
   [`feed-depth.ts`](../../packages/adapters/src/feed-depth.ts).

5. **Set `staticContent`** if the content is in the initial HTML (no loading
   spinners, no `<div id="root"></div>` shell) — enables the fast no-render
   scrape path.

6. **Place the entry correctly.** The entry goes in
   [`definitions.ts`](../../packages/ai/src/providers/definitions.ts), and
   detection is first-match-wins. If your marker could be a substring of another
   provider's marker (or vice-versa), order matters — put the more specific one
   first (cf. Document360 before Ghost).

7. **Add a test** in [`packages/ai/src/providers/detect.test.ts`](../../packages/ai/src/providers/detect.test.ts):
   assert `detectProviderFromHtml(headFragment)` returns your id and that
   `getProviderHints(id)` returns the expected feed routing. Keep the head
   fragment realistic (only what actually appears before `</head>`).

8. **Update the docs.** Add a row to the table above and to the
   [`finding-changelogs`](../../.claude/skills/finding-changelogs/SKILL.md) skill's
   capabilities table.

Verify end-to-end against the live site before finishing — run
`evaluateChangelog(url)` from both the root and the `/changelog` URL and confirm
it resolves to the feed with high confidence.
