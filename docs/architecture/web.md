# Web surfaces

## Changelog range API (Context7-style slicing)

`GET /v1/sources/:slug/changelog` accepts `?offset=<chars>` plus one of `?limit=<chars>` (char mode) or `?tokens=<n>` (token mode, cl100k*base via `js-tiktoken/lite`). Slicing is heading-aware — start snaps forward to the next `##` heading (offset=0 preserved so preamble is kept). In char mode, end snaps to the \_last* heading inside `(start, start+limit]`, overshooting to the next heading when a single section is bigger than `limit`. In token mode, we walk forward section-by-section and stop at the last heading that keeps the slice ≤ `tokens`, with the same overshoot rule. `tokens` takes precedence over `limit` when both are passed.

Recommended brackets: 2000/5000/10000/20000 tokens. The response always includes `offset`, `limit`, `nextOffset`, `totalChars`, `totalTokens`; token-mode responses also include `tokens` (requested budget) and `sliceTokens` (actual encoded count). `totalTokens` is cached in the `source_changelog_files.tokens` column on upsert — the route falls back to a size-capped live encode for rows that predate the column (the cap lives in `@buildinternet/releases-core/tokens#countTokensSafe` (source at `packages/core/src/tokens.ts`), currently 256KB → chars/4 fallback above that to bound request latency).

**Consequence:** files over 256KB carry an approximated `totalTokens` (not an exact cl100k_base count); `sliceTokens` stays exact because slicer chunks always fit under the cap. Chain successive calls via `nextOffset` to reconstruct the file exactly. With no range params the full file is returned (back-compat).

Shared slicer + response builder: `@buildinternet/releases-core/changelog-slice#sliceChangelog`/`#buildChangelogResponse` (source at `packages/core/src/changelog-slice.ts`) — used by `workers/api/src/routes/sources.ts`. Exposed over MCP as part of `get_catalog_entry` for source-kind entries (`workers/mcp/src/tools.ts`; pass `include_changelog: true` or any `changelog_path` / `changelog_offset` / `changelog_limit` / `changelog_tokens` param) and over the OSS CLI as `releases admin source changelog <slug> [--offset N] [--limit N | --tokens N] [--json]`. The web changelog tab fetches only the first 40k chars on tab nav and lazy-loads subsequent chunks via `web/src/components/changelog-stream.tsx`.

## GitHub CHANGELOG file ingestion

For `github` sources, the canonical `CHANGELOG.md` (or `CHANGES.md` / `HISTORY.md` / `RELEASES.md` / `NEWS.md`) is fetched alongside tagged releases and stored in the `source_changelog_files` table (single row per source in v1 — monorepo package CHANGELOGs are deferred to v2). The fetch uses one `GET /repos/{owner}/{repo}/contents/` root listing followed by one `raw.githubusercontent.com` request, caps content at 1MB, and refresh piggybacks on every GitHub fetch — the upsert short-circuits on `contentHash` so unchanged files only touch `fetchedAt`.

Refresh runs in `workers/api/src/cron/poll-fetch.ts#refreshChangelogFile` on every GitHub fetch (cron or ad-hoc via `POST /v1/sources/:slug/fetch`). Shared filename list + source of truth: `packages/adapters/src/github.ts#fetchChangelogFile`. The web surfaces the file in a "Changelog" tab on the source detail page via `GET /v1/sources/:slug/changelog`. Refresh also runs the chunk embedding pipeline (`packages/search/src/embed-changelog-pipeline.ts` → `chunkChangelog` → diff → embed only changed chunks → upsert to `CHANGELOG_CHUNKS_INDEX`) and reconciles the `source_changelog_chunks` table in the same pass so semantic search stays in sync with the file content.

## Open Graph images

Next.js's `opengraph-image.tsx` file convention (one per route segment, cascading). Shared template + helpers live in `web/src/lib/og.tsx` (renders via `next/og`'s `ImageResponse`) with pure helpers carved into `web/src/lib/og-helpers.ts` so they're unit-testable without the Next runtime.

`renderOgImage` picks the bleed variant (blurred hero + dark overlay) when `heroImage` is a non-null data URI, else the text-only card; `renderOgImageSplit` is exported but currently unused (kept as a ready template for future variants). `resolveHeroImage` fetches candidate media, rejects tiny thumbnails via URL markers + content-type/size bounds (`isJunkMediaUrl` + `isHeroImageResponse`), and returns a base64 data URI. `resolveAvatarUrl` prefers `org.avatarUrl` and falls back to `github.com/{handle}.png` (redirect resolved server-side for Satori).

Dynamic routes carry `revalidate = 86400` so first-render cost amortizes across 24h of CDN hits; static routes (`/`, `/docs/*`) render at build. Tests in `tests/unit/og-helpers.test.ts`.

## On-demand lookup field in search responses

`GET /v1/search` (lexical + hybrid) and the MCP `search` / `search_releases` tools include a `lookup` field when the query parses as a `{org}/{repo}` GitHub coordinate **and** the in-DB search returned zero hits (no orgs, no catalog entries, no release/changelog-chunk hits). When either condition fails, the route skips the lookup call and `lookup` is `null`. Shape:

```ts
lookup: {
  status: "indexed" | "existing" | "empty" | "not_found" | "deferred";
  source?: { id, slug, name, url, discovery };
  releases?: Release[];        // inline preview; present on indexed / existing
  relatedOrg: {                // "did you mean" rail; null when org is unknown
    org: { id, slug, name };
    sources: Source[];         // top-5 sibling sources by recent activity
  } | null;
} | null
```

`lookup` is `null` when the query was not coordinate-shaped or when existing search hits were found. Web rendering of this field (source card + inline releases + relatedOrg rail) is a follow-up to issue #611.

## Org overviews

AI-generated knowledge pages (`knowledge_pages` table, scope `org`) summarize recent changelog activity into themed sections. Generation prompt + word target (~120-250, hard ceiling 300) lives in the API worker (`workers/api/src/routes/overview.ts`; the discovery worker and `regenerating-overviews` skill handle the generation side). Surfaces: `releases admin org get` prints a preview + generated-at, `releases org overview <slug>` (public, no auth) prints the full body, MCP exposes both preview and full body through a single `get_organization` tool — the default response shows a preview and callers pass `include_overview: true` to inline the full briefing. Staleness threshold is `OVERVIEW_STALE_DAYS = 30` from `@buildinternet/releases-core/overview`; past the threshold every surface still shows the overview but adds a `⚠ older than 30 days` warning. The web's `OverviewView` strips a leading `# Heading` defensively in case the model violates the no-headings rule.

**Planning manifest (#715).** `GET /v1/admin/overviews` (admin-only) returns a paginated, sortable list of every org with the freshness signals an orchestrator needs to plan a maintenance sweep — `overviewUpdatedAt`, `lastContributingReleaseAt`, `orgLastActivity`, and crucially `releasesSinceOverview` (the count of releases shipped since the overview was generated). Each row carries a `staleness` of `missing | behind | fresh`. Filters: `staleDays=N` (include `behind` rows whose overview is at least N days old), `missing=true` (include rows with no overview at all), `hasActivity=true` (drop orgs with zero recent releases). With `format=plan`, each row also gets `action` (`missing | refresh | skip`) and `needsFetch` (true when active sources exist but ingest is lagging — the threshold is 7 days without a release). The `?check=true` query on `/v1/orgs/:slug/overview/inputs` returns a lightweight pre-flight payload (`{orgSlug, selected, totalAvailable, hasExistingContent, wouldRegenerate, windowDays}`) so an orchestrator can decide whether to dispatch without paying for the full release-content + media hydration.

## Category metadata overlay

The fixed `CATEGORIES` taxonomy (`packages/core/src/categories.ts`) stays the source of truth for valid slugs — adding one is still a code change. The optional `categories` table (`packages/core/src/schema.ts`, migration `20260511000000_categories_metadata.sql`) overlays editable presentation on top: per-slug `name` override (else `categoryDisplayName(slug)` runs the title-casing), `description` (the byline on `/categories/<slug>` and `/categories` list), and `aliases` (JSON string array of alternative slugs that redirect to the canonical row). A category with no customization has no row in the table.

Read surface:

- `GET /v1/categories` — every canonical slug, with `aliases`, `description`, counts. Missing rows fall through to defaults.
- `GET /v1/categories/:slug` — canonical only renders detail; alias input returns `301 Moved Permanently` to the canonical URL. `GET /v1/categories/:slug/releases` resolves alias internally (no redirect on the feed endpoint to avoid breaking cursor pagination).

Write surface (admin-only, gated by `publicReadRoutes` → `publicReadAuthMiddleware`'s SAFE_METHODS check):

- `PATCH /v1/categories/:slug` — upserts `name`, `description`, and/or `aliases`. Each alias is validated against `CATEGORY_ALIAS_RE`, can't shadow a canonical slug, and can't already be claimed by another row (cross-row uniqueness is enforced in the handler; SQL stores aliases as JSON so there's no unique index).

Write-path alias resolution: `POST/PATCH /v1/orgs` and `POST/PATCH /v1/products` call `resolveCategoryInput()` (in `workers/api/src/lib/category-alias.ts`) on the body's `category` field, so `"e-commerce"` lands in `organizations.category` / `products.category` as `"commerce"`. The helper composes `loadAliasMap()` (one `SELECT slug, aliases FROM categories`) with the pure `resolveCategorySlug()` core helper.

Web: `/categories/[slug]/page.tsx` re-bounces the browser when the API's response `slug` differs from the URL slug — fetch follows the API's 301 transparently, so an alias landing surfaces as `detail.slug !== slug` and the handler calls Next's `redirect()`.

## Collections

Curated, named groups of orgs that drive a "playlist" page (e.g. `/collections/frontier-ai-labs`). Independent of the fixed `category` taxonomy, so a collection can mix orgs across categories or surface a tighter subset than any category covers. Schema is two tables: `collections` (slug-keyed) and `collection_members` (`collection_id`, `org_id`, `position`).

Read surface:

- `GET /v1/collections` — list with member counts.
- `GET /v1/collections/:slug` — detail, member orgs joined through `organizations_public` so hidden/`on_demand` orgs don't leak.
- `GET /v1/collections/:slug/releases` — interleaved cross-org feed. Cursor shape and ordering match `/v1/orgs/:slug/releases`, so the same web cursor parser drives both surfaces.

Write surface (admin-only, gated by `publicReadAuthMiddleware`'s SAFE_METHODS check via the `publicReadRoutes` allowlist):

- `POST /v1/collections`, `PATCH /v1/collections/:slug`, `DELETE /v1/collections/:slug` — CRUD on the collection itself. Slug rename is allowed via PATCH.
- `PUT /v1/collections/:slug/members` — replace membership atomically (delete + insert; D1 has no transaction primitive). The handler resolves every member in at most two `IN` queries (one for `org_…` ids, one for slugs) before touching the join table. Position defaults to array index, so order = order.
- `POST /v1/collections/:slug/members`, `DELETE /v1/collections/:slug/members/:org` — single-member add/remove. `:org` accepts either an `org_…` id or a slug.

Web: `web/src/app/collections/[slug]/page.tsx` renders the header + member chips, then `CollectionReleaseList` for the paginated feed. Each row carries an `org` discriminator the byline uses to label which lab a release came from.

Seed model: the first collection (`frontier-ai-labs`) is created via migration (`20260507000003_seed_frontier_ai_labs.sql`); the CLI admin commands are the layer above the write API. Membership is intentionally curated — orgs onboarded later are not retroactively added to existing collections.

## Media handling

At ingest time, `normalizeMediaUrl()` in `packages/rendering/src/media-url.ts` rewrites Next.js/Vercel image-optimizer proxy URLs (`/_next/image?url=...`, including Next `basePath` variants) to the underlying CDN asset — those proxy endpoints 404 for off-origin fetchers, so the raw `url` query param is extracted and stored instead. Outside that rewrite, media URLs are stored verbatim in the `media` column as third-party-hosted URLs; there is no ingest-time upload to R2. Ingest-time R2 mirroring (junk filtering + upload) is planned but not yet implemented; see #1033.

The `released-media` R2 bucket currently holds org avatars (`orgs/{slug}.{ext}`, written by `scripts/upload-org-avatars.ts`) and handles ad-hoc uploads via the auth-gated `PUT /v1/media/:key` endpoint in `workers/api/src/routes/media.ts`.

`FallbackImage` / `FallbackPlainImage` in `web/src/components/fallback-image.tsx` show an "Image unavailable" placeholder when a third-party URL fails to load.
