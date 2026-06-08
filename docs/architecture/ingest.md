# Ingest pipeline

The fetch → parse → insert path: how a source's content becomes `releases` rows. This doc covers per-item processing (adapter routing, dedup, exclusion, and the ingest-time AI passes). The orchestration around it — cron scheduling, the poll-and-fetch / scrape-agent Workflows, smear/jitter, and retier — lives in [remote-mode.md](remote-mode.md).

## Source types and adapter routing

Source `type` selects the fetch adapter: `github`, `scrape`, `feed`, `agent`, `appstore`.

- The `scrape` adapter auto-discovers RSS/Atom/JSON feeds before falling back to Cloudflare browser rendering + AI. Feed metadata (URL, type, ETag) is cached in `source.metadata`.
- `appstore` sources are materialized from an App Store listing via `POST /v1/sources/appstore` (resolves the iTunes listing, mints the first release, backfills the product icon) — see #1160; the CLI surface is `releases admin source create-appstore` (cli#247).

`source.url` is the human-readable URL; machine fetch endpoints live in `source.metadata` (`feedUrl`, `githubUrl`, `crawlEnabled`, `firecrawl`, …) so display and ingest can diverge. See [remote-mode.md → Display URL vs. fetch routing](remote-mode.md).

## Dedup and batched inserts

Dedup via `UNIQUE(source_id, url)` and the shared `RELEASE_URL_UPSERT` config in `@releases/core-internal/release-upsert` — on URL collision, content is backfilled when incoming is non-empty and existing is empty.

**D1's hard limit is 100 bound parameters per prepared statement**, so batch INSERTs chunk at `floor(100 / binds_per_row)` per statement. For `releases` (13 binds/row) that's 7 rows per statement; `inArray(...)` lookups chunk at 90 IDs. Raising a chunk size without re-checking bind count surfaces as a 500 on `/releases/batch`.

## Change detection and backoff

Smart fetch (cron): `consecutiveNoChange` / `consecutiveErrors` counters on the `sources` table drive exponential backoff (no_change: 1h–48h, errors: 1h–72h). The full retier logic is in [remote-mode.md → Feed change detection + retier](remote-mode.md).

Feed 4xx splits two ways (`fetchOne`): **404/410/403…** are treated as a gone/renamed URL and increment `metadata.feed4xxStreak` (no backoff) toward `FEED_4XX_INVALIDATE_THRESHOLD = 5`, after which the stored `feedUrl` is flushed for re-discovery. **429/408** (`isTransientFeedHttpStatus`) are transient rate-limit/timeout signals, NOT a gone URL: they take the `consecutiveErrors` exponential backoff (waiting at least as long as the server's `Retry-After` when present) and never touch `feed4xxStreak`. A 429 is also flagged `rateLimited` on the fetch result so the poll-and-fetch workflow treats it as expected churn — it throws `NonRetryableError` (no retry storm) and skips the `workflow_failures` row, so a rate-limited feed never fires a failure-alert email.

## Exclusion and suppression

- **Ignored URLs** are org-scoped (`ignored_urls`, requires `orgId`); **blocked URLs** are global (`blocked_urls`, spam/bad domains). Both are checked by `isUrlExcluded()` before insert.
- **Release suppression** hides a row from all read paths without deleting it (`suppressed = 1`). The marketing classifier (below) is the main automated writer of this flag; operators set it via `POST /v1/releases/:id/suppress`.

## Ingest-time AI passes

Three Haiku 4.5 passes can run inside `fetchOne` between parse and insert. All are fail-open (any model error logs a warning and falls back to inserting the item as-is) and per-fire capped so a misbehaving source can't run up a bill.

### Content summarization

The `release-content` pass (`@releases/ai-internal/release-content`) generates `title_generated` / `title_short` / `summary`. It is shared by `scripts/generate-release-content.ts` and the ingest-time hook.

### Marketing classifier

Vendor blogs that mix product news with case studies / newsletters / event recaps opt in via `metadata.marketingFilter = true`. `fetchOne` runs each newly-parsed item through `classifyMarketing` (Haiku 4.5, `@releases/ai-internal/marketing-classifier`) before insert; items the model tags as marketing get inserted with `suppressed = true` and `suppressedReason = "marketing_classifier:<slug>"` (slugs: `case_study`, `newsletter`, `event_recap`, `partner_announcement`, `positioning_piece`, `localized_marketing`, `unspecified`). Suppressed-at-insert IDs are excluded from `insertedIds` so the downstream publish / embed / auto-summarize steps skip them. Fail-open on any classifier error — log warn and insert visibly. Cap: 20 items per fire (above that, skip classification and insert visibly; operators backfill via `POST /v1/releases/:id/suppress`). Optional `metadata.marketingFilterHint: string` carries source-specific guidance into the prompt.

### Feed content enrichment

Summary-only feeds (RSS items with a `<description>` but no `content:encoded`; JSON Feed items lacking a full-content field — no `content_html` / `content_text` — and supplying only a `summary`) leave releases one-line even when the linked page is rich. A `content_text` body alone is full content, not a summary-only fallback.

Parsers flag the fallback via `RawRelease.contentFromSummary`; `assessFeedDepth` (`@releases/adapters/feed-depth`) reads a fetch batch and persists `metadata.feedContentDepth = "summary-only"` once. When that flag is set and `FEED_ENRICH_ENABLED = "true"`, `fetchOne` enriches new thin items before insert via `enrichFeedItem` (`workers/api/src/cron/feed-enrich.ts`): cheap `fetch` → `htmlToMarkdown` → `extractArticle` (Haiku 4.5, `@releases/ai-internal/article-extract`), escalating to Cloudflare Browser Rendering only when the cheap result is still under the improvement bar (`max(FEED_THIN_CHARS, summary.length × 1.5)`).

Capped at `FEED_ENRICH_MAX_PER_FIRE` (default 10) per source per fire; fail-open (any error keeps the feed summary). Each touched row carries a `metadata.enrichment` marker (`{ attemptedAt, succeeded, via }`) so it's never re-fetched.

Operator backfill of already-stored thin rows: `POST /v1/workflows/enrich-feed-content { sourceId|sourceSlug, limit?, dryRun? }` (admin-gated, dry-run by default) — nulls `summary` / `titleGenerated` / `titleShort` / `embeddedAt` and re-runs `generateContentForReleases`.

Render escalation needs `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` bound on the API worker (reused from the discovery worker's Secrets Store); absent them, enrichment degrades to the cheap path. Spec: `docs/superpowers/specs/2026-05-21-feed-content-enrichment-design.md`.

## Related

- [remote-mode.md](remote-mode.md) — cron polling, poll-and-fetch / scrape-agent Workflows, retier, smear/jitter.
- [firecrawl-monitoring.md](firecrawl-monitoring.md) — external Firecrawl fetch backend for challenge-blocked `scrape` sources (excluded from the poll-fetch cron).
- [extract.md](extract.md) — the two-tier body-extraction path that turns a fetched page into structured release records.
- [coverage.md](coverage.md) — ingest-time grouping of multiple releases that cover one launch.
