# Ingest pipeline

How a source's published content becomes `releases` rows in the database — the fetch → parse → insert path that everything downstream (search, feeds, webhooks, the web) is built on. This doc covers what happens to each item on the way in: which adapter fetches it, how duplicates are avoided, what gets excluded or suppressed, and the cheap AI passes that run between parse and insert (summaries, marketing filtering, thin-feed enrichment). The orchestration _around_ it — cron scheduling, the poll-and-fetch / scrape-agent Workflows, smear/jitter, and retier — lives in [remote-mode.md](remote-mode.md).

## Source types and adapter routing

Source `type` selects the fetch adapter: `github`, `scrape`, `feed`, `agent`, `appstore`.

- The `scrape` adapter auto-discovers RSS/Atom/JSON feeds before falling back to Cloudflare browser rendering + AI. Feed metadata (URL, type, ETag) is cached in `source.metadata`.
- Onboarding recognizes the hosting **platform** (Mintlify, Ghost, Blume, …) to pick the best route up front — known feed paths, `.md` mirrors, crawl patterns. Supported platforms and how to add a new one: [provider-detection.md](provider-detection.md).
- `appstore` sources are materialized from an App Store listing via `POST /v1/sources/appstore` (resolves the iTunes listing, mints the first release, backfills the product icon) — see #1160; the CLI surface is `releases admin source create-appstore` (cli#247).

`source.url` is the human-readable URL; machine fetch endpoints live in `source.metadata` (`feedUrl`, `githubUrl`, `crawlEnabled`, `firecrawl`, …) so display and ingest can diverge. See [remote-mode.md → Display URL vs. fetch routing](remote-mode.md).

## Dedup and batched inserts

Dedup via `UNIQUE(source_id, url)` and the shared `RELEASE_URL_UPSERT` config in `@releases/core-internal/release-upsert` — on URL collision, content is backfilled when incoming is non-empty and existing is empty (fill-don't-clobber). For a deliberate enrichment pass, `POST /v1/.../releases/batch` accepts a top-level `mode: "upsert-content"` that swaps in the clobbering `RELEASE_CONTENT_UPSERT` (overwrite content/media on same-URL collision, skip the scrape title-dedup pre-filter) — opt-in only, so the default re-fetch path stays fill-only (#1526).

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

The same call also scores `importance` (1–5, `releases.importance`) — no separate model call. The rubric lives in `SYSTEM_PROMPT`'s `<importance_format>` block in `packages/ai/src/release-content.ts`, alongside the `<breaking>` verdict. Fail-open: an absent `<importance>` tag, a non-integer value, or a value outside 1–5 all parse to `null` (`parseImportance`) — never a fabricated score, the same posture as `breaking`'s `"unknown"`. `null` also covers empty-body releases (skipped before any model call) and unscored history predating the feature. Canonical range: `IMPORTANCE_MIN`/`IMPORTANCE_MAX` in `packages/core/src/importance.ts`. Read/filter behavior: [routing.md → Importance filtering](routing.md); web display: [web.md → Importance marker](web.md).

Because `title_generated`, `summary`, `breaking`, and `importance` all come out of that one tuned `SYSTEM_PROMPT`, a change to it can regress any of them independently — run `bun run eval:summary`, `bun run eval:breaking`, and `bun run eval:importance` before merging such a change. `resolveEvalModel` (`tests/evals/judge-model.ts`) takes a `reasoning` option that forwards to the OpenRouter candidate lane; `eval:importance` passes `reasoning: { enabled: false }` to mirror production `resolveSummarizeModel`, without which a DeepSeek-class reasoning model burns tokens the production lane never spends. `eval:breaking` does not pass it yet and is the natural next place to.

A manual `POST /v1/sources/:id/fetch` that inserts releases also triggers the `generate-content` fill pass for that source (up to 100 unfilled rows, via `waitUntil` after the response), so onboarding fetches land display-ready instead of waiting for an operator to run `POST /v1/workflows/generate-content` by hand (#1579). Same gates as the cron path — org `auto_generate_content` opt-in, per-source `metadata.summarize` opt-out — and fail-open: a summarize failure never fails the fetch.

### Marketing classifier

Vendor blogs that mix product news with case studies / newsletters / event recaps opt in via `metadata.marketingFilter = true`. `fetchOne` runs each newly-parsed item through `classifyMarketing` (Haiku 4.5, `@releases/ai-internal/marketing-classifier`) before insert; items the model tags as marketing get inserted with `suppressed = true` and `suppressedReason = "marketing_classifier:<slug>"` (slugs: `case_study`, `newsletter`, `event_recap`, `partner_announcement`, `positioning_piece`, `localized_marketing`, `unspecified`). Suppressed-at-insert IDs are excluded from `insertedIds` so the downstream publish / embed / auto-summarize steps skip them. Fail-open on any classifier error — log warn and insert visibly. Cap: 20 items per fire (above that, skip classification and insert visibly; operators backfill via `POST /v1/releases/:id/suppress`). Optional `metadata.marketingFilterHint: string` carries source-specific guidance into the prompt.

### Feed content enrichment

Summary-only feeds (RSS items with a `<description>` but no `content:encoded`; JSON Feed items lacking a full-content field — no `content_html` / `content_text` — and supplying only a `summary`) leave releases one-line even when the linked page is rich. A `content_text` body alone is full content, not a summary-only fallback.

Parsers flag the fallback via `RawRelease.contentFromSummary`; `assessFeedDepth` (`@releases/adapters/feed-depth`) reads a fetch batch and persists `metadata.feedContentDepth = "summary-only"` once. When that flag is set and `FEED_ENRICH_ENABLED = "true"`, `fetchOne` enriches new thin items before insert via `enrichFeedItem` (`workers/api/src/cron/feed-enrich.ts`): cheap `fetch` → `htmlToMarkdown` → `extractArticle` (`@releases/ai-internal/article-extract`), escalating to Cloudflare Browser Rendering only when the cheap result is still under the improvement bar (`max(FEED_THIN_CHARS, summary.length × 1.5)`). `extractArticle` runs on the shared `TextModel` seam (`resolveArticleExtractModel`, lane `feed-enrich`): with `openrouter-enabled` on and `FEED_ENRICH_MODEL` set it routes to OpenRouter (deepseek-v4-flash — eval-validated at Haiku parity, ~85% cheaper; see `bun run eval:article-extract`), else fails open to Anthropic Haiku. The async Message-Batches enrichment path (`batch-enrich.ts`) stays on Anthropic — no OpenRouter Batches API.

Capped at `FEED_ENRICH_MAX_PER_FIRE` (default 10) per source per fire; fail-open (any error keeps the feed summary). Each touched row carries a `metadata.enrichment` marker (`{ attemptedAt, succeeded, via }`) so it's never re-fetched.

Operator backfill of already-stored thin rows: `POST /v1/workflows/enrich-feed-content { sourceId|sourceSlug, limit?, dryRun? }` (admin-gated, dry-run by default) — nulls `summary` / `titleGenerated` / `titleShort` / `embeddedAt` and re-runs `generateContentForReleases`.

Render escalation needs `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` bound on the API worker (reused from the discovery worker's Secrets Store); absent them, enrichment degrades to the cheap path. Spec: `docs/superpowers/specs/2026-05-21-feed-content-enrichment-design.md`.

## Related

- [remote-mode.md](remote-mode.md) — cron polling, poll-and-fetch / scrape-agent Workflows, retier, smear/jitter.
- [firecrawl-monitoring.md](firecrawl-monitoring.md) — external Firecrawl fetch backend for challenge-blocked `scrape` sources (excluded from the poll-fetch cron).
- [extract.md](extract.md) — the two-tier body-extraction path that turns a fetched page into structured release records.
- [coverage.md](coverage.md) — ingest-time grouping of multiple releases that cover one launch.
