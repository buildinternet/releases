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

## Org overviews

AI-generated knowledge pages (`knowledge_pages` table, scope `org`) summarize recent changelog activity into themed sections. Generation prompt + word target (~120-250, hard ceiling 300) lives in the API worker (`workers/api/src/routes/overview.ts`; the discovery worker and `regenerating-overviews` skill handle the generation side). Surfaces: `releases admin org show` prints a preview + generated-at, `releases org overview <slug>` (public, no auth) prints the full body, MCP exposes both preview and full body through a single `get_organization` tool — the default response shows a preview and callers pass `include_overview: true` to inline the full briefing. Staleness threshold is `OVERVIEW_STALE_DAYS = 30` from `@buildinternet/releases-core/overview`; past the threshold every surface still shows the overview but adds a `⚠ older than 30 days` warning. The web's `OverviewView` strips a leading `# Heading` defensively in case the model violates the no-headings rule.

## Media pipeline

Extracted media URLs go through `filterJunkMedia()` in `packages/rendering/src/media.ts` (drops tracking pixels, favicons, and AI-classified chrome), then `processMediaForR2()` downloads and uploads survivors to R2. `normalizeMediaUrl()` unwraps Next.js/Vercel image optimizer URLs (`/_next/image?url=...`, including Next `basePath` variants) to the underlying CDN asset before upload — those proxy endpoints 404 for off-origin fetchers. The web renders `r2Url ?? url`, and `FallbackImage` / `FallbackPlainImage` in `web/src/components/fallback-image.tsx` show an "Image unavailable" placeholder on load error.
