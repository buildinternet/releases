# Web surfaces

## Product-first URL resolution (#1190)

The bare second segment is a **product**: `/[org]/[slug]` resolves product-first, falling back to a source. Phases 1–2 (#1187, #1189) made the product the default feed + link unit; #1190 flipped the namespace so products own the clean coordinate and sources are demoted toward an ID-keyed surface.

**Resolution** (`web/src/app/[orgSlug]/[slug]/page.tsx` calls `GET /v1/orgs/:org/resolve/:slug`, a one-round-trip discriminated `{ kind: "product" | "source" }` payload — `workers/api/src/routes/products.ts`):

| Path                    | resolves to           | Action                                              |
| ----------------------- | --------------------- | --------------------------------------------------- |
| `/[org]/[slug]`         | product               | render product                                      |
| `/[org]/[slug]`         | source (non-shadowed) | render source                                       |
| `/[org]/[slug]`         | nothing               | 404                                                 |
| `/[org]/product/[slug]` | (any)                 | 308 → `/[org]/[slug]`                               |
| `/sources/[id]`         | member source         | render source (canonical home for shadowed sources) |
| `/sources/[id]`         | orphan source         | 308 → `/[org]/[sourceSlug]`                         |

Because a **shadowed** source's slug _is_ its product's slug, product-first resolution returns the product directly — no redirect, no broken URL; the bare URL's content just flips from source to product. Of ~71 member sources, ~23 collide; only those need `/sources/:id`. Non-shadowed members and all orphans keep their bare URL.

- **Seam:** `web/src/lib/links.ts` is the single path builder for the web component tree — `productPath` emits bare, `sourceIdPath(id)` → `/sources/:id`. Server-rendered markdown/XML (`packages/rendering/src/formatters.ts`), the rename `revalidatePath`, and IndexNow construct product URLs independently and were swept to bare alongside the flip.
- **Machine format routes stay at `/product/`:** `/api/format/[orgSlug]/product/[productSlug]` (and the matching `Sidebar formatPath`) are download surfaces, intentionally not moved.
- **Reserved nested slugs** (`@buildinternet/releases-core/reserved-slugs`) gained `product`/`products`/`playbook`/`fetch-log` so no slug can shadow a static second-segment route. Creating a product whose slug shadows a same-org source **warns but allows** (the intended "wrap" mechanism).

**Deferred edges:** `/[org]/[productSlug]/changelog` 404s (products have no changelog view); changelog _chunk_ deep-links for the ~11 shadowed-with-changelog sources stay on the bare `sourcePath` (rerouting them to `/sources/:id/changelog` needs a `sourceId`-on-hit wire change). Both ride with the product-scoped-views follow-up (#1191-adjacent).

**Committed destination:** orgs + products own slugs, sources become ID-only. Gated on the catalog becoming product-centric — bridged non-breakingly by selective orphan→product wrapping (same-slug, so URLs are preserved), owned by **#1194**. The resolver's source-fallback is transitional with a sunset. Full reasoning: `docs/superpowers/specs/2026-05-27-product-first-url-resolution-design.md`; build steps: `docs/superpowers/plans/2026-05-27-product-first-url-resolution.md`.

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

`GET /v1/search` (lexical + hybrid) and the MCP `search` tool include a `lookup` field when the query parses as a `{org}/{repo}` GitHub coordinate **and** the in-DB search returned zero hits (no orgs, no catalog entries, no release/changelog-chunk hits). When either condition fails, the route skips the lookup call and `lookup` is `null`. Shape:

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

### Daily summaries

A brief per-(collection, Eastern-Time day) rollup — a headline `title`, a one-line `summary`, and bullet `takeaways` — generated together in a single cheap text-model pass and rendered as a header above each day's group in the collection timeline. The artifact mirrors release-level title/summary, scoped to a day instead of a single release.

- **Storage:** dedicated `collection_daily_summaries` table (`id`, `collection_id`, `summary_date` `YYYY-MM-DD` ET, `title`, `summary`, `takeaways` JSON, `release_count`, `model_id`, timestamps), `UNIQUE(collection_id, summary_date)` for idempotent upsert. Per-collection `collections.daily_summary_enabled` (default `true`) gates generation. Not `knowledge_pages` — those are one living page per entity; these are many short date-keyed rows.
- **Day boundary:** Eastern Time, via `etDayKey` / `etDayBoundsUtc` / `addDaysToDateKey` from `@buildinternet/releases-core/dates` (DST-aware). The day window's releases are read through the same visible-views the feed uses (`releasesVisible`/`sourcesActive`/…), so a summary covers exactly what the timeline shows (suppressed/coverage rows excluded).
- **Generation:** nightly cron (`workers/api/src/cron/collection-summaries.ts`, tick `15 6 * * *`) over **closed** ET days only, gated by `CRON_ENABLED`, with a bounded catch-up (`COLLECTION_SUMMARY_CATCHUP_DAYS`). Skips a day with 0 releases (no row, no AI call); per-collection try/catch. The model resolves through the **shared summarization lane** (`resolveCollectionSummaryModel` reuses the release summarizer's `SUMMARIZE_MODEL` var + its Anthropic Haiku fallback, governed by the `openrouter-enabled` Flagship switch — only the `generationName` trace tag differs, so the two lanes stay separable in usage/cost without a per-feature model var). The prompt/parser live in `packages/ai/src/collection-summary.ts` (tagged `<title>`/`<summary>`/`<takeaways>` output).
- **API:** `GET /v1/collections/:slug/daily-summaries?from=&to=` returns the rows for an inclusive ET range (defaults applied), newest first; additive to the unchanged releases feed. On-demand/dry-run regeneration via the admin-gated `POST /v1/workflows/collection-summaries { collectionId?, date?, dryRun? }`.
- **Forward-only at launch** — no historical backfill in v1 (a backfill workflow can reuse the same generator later).

## Media handling

At ingest time, `normalizeMediaUrl()` in `packages/rendering/src/media-url.ts` rewrites Next.js/Vercel image-optimizer proxy URLs (`/_next/image?url=...`, including Next `basePath` variants) to the underlying CDN asset — those proxy endpoints 404 for off-origin fetchers, so the raw `url` query param is extracted and stored instead.

**Ingest-time R2 mirroring (#1177)** runs whenever the `MEDIA` bucket binding is bound (always in prod). The two fresh-media ingest paths — the cron `poll-fetch` insert and the `/releases/batch` endpoint — run a media pre-pass:

1. `filterJunkMedia` (`@releases/rendering/media-filter`) drops chrome by URL: favicons, gravatar/`?s=NN` avatar thumbnails, `/avatar/` crops, and `data:` URIs. It's shared with the OG hero-image picker (`web/src/lib/og-helpers.ts` delegates to it) so the two marker lists can't drift.
2. `processMediaForR2` (`workers/api/src/lib/media-ingest.ts`) fetches each survivor, gates on a `Content-Type` of `image/*` and a byte size in `[1 KB, 8 MB]` (the floor catches tracking pixels / spacers the URL heuristic misses), content-hash-keys it (`releases/{sha256}.{ext}`), `put`s it to the `released-media` bucket, registers a `media_assets` row, and stamps `r2Key` on the stored `media[]` item. Read paths resolve `r2Key → r2Url` via `resolveR2Url` (already wired in `parseReleaseMedia`). Content-hash keying gives free dedup against `media_assets`' `UNIQUE(content_hash)`/`UNIQUE(r2_key)`.

The pass is **bounded** (per-release + per-fire caps, a per-image `AbortController` timeout, limited concurrency) and **fail-open**: any fetch error, timeout, non-image response, out-of-range size, or `put`/registry error leaves the original third-party URL in place. The `r2Key` is stamped immediately after a successful `put`, so a registry-write failure can't strip the user-facing same-origin URL. An unbound `MEDIA` bucket stores third-party URLs verbatim; backfill of pre-existing rows is a follow-up.

On the read side, `releaseThumbUrl` (`web/src/lib/media.ts`) only routes **same-origin** (R2-hosted) sources through the Cloudflare width transform — third-party / not-yet-mirrored media passes through untransformed. That keeps Cloudflare Image Transformations "Sources" scoped to "Specified origins" (no open cross-origin resize proxy): un-uploaded media renders jagged-but-never-broken rather than 403ing.

The `released-media` R2 bucket also holds org avatars (`orgs/{slug}.{ext}`, written by `scripts/upload-org-avatars.ts`) and handles ad-hoc uploads via the auth-gated `PUT /v1/media/:key` endpoint in `workers/api/src/routes/media.ts`.

`FallbackImage` / `FallbackPlainImage` in `web/src/components/fallback-image.tsx` show an "Image unavailable" placeholder when a third-party URL fails to load.

### Inline hosted-video cards (#1549)

Release bodies sometimes link out to a hosted video (`[Video](https://fast.wistia.com/embed/iframe/<id>)`) that would otherwise render as an easy-to-miss text link. The cron `poll-fetch` media pre-pass scans each **new** release's body for known video-embed providers (Wistia / Loom / Vimeo / YouTube) via `detectInlineVideos` (`packages/rendering/src/video-embed.ts`), resolves a poster + title + canonical watch URL from the provider's **oEmbed** endpoint, and appends a `{ type: "video", url: <poster>, alt: <title>, linkUrl: <watchUrl> }` entry to `media[]`. From there it rides the existing `processMediaForR2` path — the poster is mirrored to `released-media` like any image, so the card serves same-origin.

This is the first case of promoting an **inline body asset** into mirrored `media[]` (today only the per-release hero lands there). It is deliberately **special-cased to video** rather than generalized to all inline images: a hosted-video embed is a low-cardinality, high-value signal, whereas inline images are numerous and noisy (icons, spacers, decorative crops) and promoting all of them would balloon `media[]` and R2 cost. Generalizing inline-image mirroring is a possible follow-up.

Fail-open and bounded: detection is pure/synchronous, oEmbed resolution has a per-call timeout and is capped at 4 videos/release, and any failure (unrecognised URL, non-ok / garbage oEmbed, missing thumbnail) yields no entry — the bare link stays exactly as today. No feature flag (read-only thumbnail + link is low-risk; mirroring already gates on the `MEDIA` binding).

The web renders these as a **read-only play-thumbnail card** (`InlineVideoCard` in `web/src/app/release/[id]/release-content.tsx`) with a `PlayBadge` overlay — distinct from the click-to-play `VideoEmbed` iframe facade used by `type: "video"` _sources_. An inline iframe embed for these body-promoted videos is a deferred follow-up (CSP / third-party-JS surface). Distinct from the YouTube `type: "video"` source path, which models a whole channel as a source.

**Inline placement (in place of the body link).** The card renders **inline, replacing the original `[Video](<embed-url>)` link** rather than in the trailing `MediaGallery`. `ReleaseContent` builds its markdown components with `buildDetailComponents(media)`, which closes over the release's `media[]` and overrides the `a` renderer: a body anchor whose `href` is a recognised video-embed URL (`canonicalVideoFromUrl`, exported from `@releases/rendering/video-embed`) is matched **by canonical video id** to a `type: "video"` media item, and if one with a poster exists, the card renders there. The card's click target is the **original body href** (known-loadable), and the poster is the matched item's mirrored `r2Url`. Anything that doesn't match (no media item, no poster, a non-video link) falls open to the base `a` renderer (existing YouTube/Vimeo/Loom iframe handling + plain links). `MediaGallery` now **excludes `type: "video"` items** — they always have an inline home, so leaving them in the gallery would both duplicate the card and surface the synthesized (login-redirecting) watch URL.

**Match by id, not watch-URL string.** Matching normalizes both the body href and the media item's `linkUrl`/`url` through `canonicalVideoFromUrl`, so a row whose stored `linkUrl` predates a `watchUrl` change still matches. This matters because the Wistia `watchUrl` was corrected from `fast.wistia.com/medias/<id>` (which 302-redirects anonymous viewers to a login page) to the publicly-loadable `fast.wistia.com/embed/iframe/<id>` form. Already-backfilled rows still carry the old `medias/<id>` `linkUrl`, but they render correctly because (a) the inline card links to the body href, not the stored `linkUrl`, and (b) the poster matches by id — **no re-backfill is needed**. **Trap:** do _not_ blanket re-run `POST /v1/workflows/backfill-video` over already-carded Wistia releases — dedup is keyed on `linkUrl`, and the new embed-form key won't match the stored medias-form key, so it would append a **duplicate** video item. Correcting stored `linkUrl`s is a separate, optional data migration.

## Entity notices

A **notice** is one small curator-set note attached to an org, product, or
source — e.g. "Windsurf is now Cognition's Devin → cognition/devin". It is a
JSON sub-object stored under the `notice` key of the entity's `metadata` column
(`organizations`/`sources`/`releases` already have `metadata`; `products` gained
it for this feature). Shape (`@buildinternet/releases-core/notice` `Notice`,
validated on write by `NoticeSchema` in `@buildinternet/releases-api-types`):
`{ message, linkText?, coordinate?, href? }`, where `coordinate` is an internal
registry path (`org` / `org/slug`) and `href` is an external URL — at most one.

- **Write:** `PATCH /v1/orgs/:slug` · `/v1/products/:id` · `/v1/sources/:slug`
  with `{ notice: {...} }` to set or `{ notice: null }` to clear; the merge
  preserves all other metadata keys.
- **Read:** the org/product/source detail responses return a typed `notice`
  field (raw `metadata` is not surfaced on products).
- **Web:** `EntityNotice` renders a compact banner under the entity header.
  Curators set / edit / clear it from each entity's local-dev admin menu via the
  shared `NoticeForm` (message + an Internal-coordinate vs External-URL toggle),
  which calls the `set{Org,Product,Source}NoticeAction` server actions.
- **MCP:** `get_organization` emits `Notice: <message> → <coordinate>` so an
  agent can follow the pointer.
- **No cascade:** a notice shows only on the entity it is set on. The
  "formerly X" case is two independent notices pointing at each other.

## Fetch Log workflow drawer (dev-only)

On the dev-gated Fetch Log tab, clicking a Fetch Plan row opens a per-source ingestion-pipeline drawer: an adaptive vertical stage list (topology from `describeWorkflowStages` in `@releases/adapters/workflow-stages`) annotated with current state and last-run outcome derived from `fetch_log` + `usage_log` + `sources` via `GET /v1/status/source-workflow`. Phase 1 is derived-data only; per-stage timing instrumentation is a documented Phase 2. Spec: `docs/superpowers/specs/2026-05-31-per-source-workflow-viz-design.md`.

## Follows + personalized feed

Signed-in users can follow orgs and products; an org follow implicitly covers all of that org's products on the feed (org follow = everything under it).

**Follow state** is loaded client-side once per page visit via `FollowsProvider` (`web/src/components/follows-provider.tsx`) — a single `GET /v1/me/follows` call whose result is held in React context and updated optimistically on follow/unfollow. The surface follows the same gate as the rest of the auth UI — simply whether `NEXT_PUBLIC_BETTER_AUTH_URL` is configured (`AUTH_CONFIGURED` in `web/src/lib/auth-ui.ts`; the old `NEXT_PUBLIC_AUTH_UI_ENABLED` master switch has been retired, so the auth UI is no longer behind an explicit opt-in). There is no separate follows feature flag; `FollowButton` still renders nothing for signed-out visitors (the provider is null), and the `/following` page server-gates on the same auth-configured condition.

**`FollowButton`** (`web/src/components/follow-button.tsx`) reads from `FollowsProvider` context, calls `POST /v1/me/follows` or `DELETE /v1/me/follows/:targetType/:targetId` on click, and applies an optimistic local toggle with a rollback on error. It appears on org and product detail pages for signed-in users.

**`/following` page** (`web/src/app/following/page.tsx`) is the personalized feed: a newest-first release list (reusing the `ReleaseLatestItem` component) drawn from `GET /v1/me/feed`, with a same-page sidebar listing all current follows and offering unfollow actions. The feed is cursor-paginated and empty-stated with a prompt to follow orgs or products when the user has no follows yet.
