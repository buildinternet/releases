# Collection daily summaries — design

**Date:** 2026-06-14
**Status:** Approved design, pre-implementation
**Surface:** `https://releases.sh/collections/<slug>`

## Problem

Collection pages (e.g. `/collections/coding-agents`) show an interleaved, cursor-paginated
feed of every release across the collection's member orgs/products. There is no day-level
synthesis: a reader scrolling the feed can't quickly see "what happened in this space today"
without reading each release. We want a brief, daily, bullet-style rollup of everything that
happened within a collection — and a short title + one-line description for each day, so a
date can be presented with a punchy headline alongside it.

This mirrors two patterns that already exist:

- **Release-level title/summary** (`packages/ai/src/release-content.ts`) — Haiku/OpenRouter
  generates `title_generated` / `title_short` / `summary` per release. The day **title +
  one-liner** is the same idea, scoped to a day instead of a single release.
- **Org overviews** (`knowledge_pages`, scope `org`) — Haiku-generated markdown summarizing
  ~90 days of org activity, surfaced above the timeline. The day **bullet takeaways** are the
  same idea, scoped to one day instead of a rolling window.

The daily summary is **not** necessarily release-by-release. It can be thematic — e.g.
"multiple labs shipped agent updates today, including X and Y" — and may highlight specific
releases when warranted.

## Goals

- One brief daily artifact per collection: a **title**, a **one-line summary**, and **bullet
  takeaways**, generated together in a single model pass.
- Generated **daily for all collections by default**, **individually configurable** (per
  collection on/off).
- Run on the **cheap OpenRouter lane**, not Haiku, to minimize cost (Haiku is the fail-open
  fallback only).
- Surface as **date headers inline in the collection timeline** — the summary lives with the
  releases it describes.
- Grouping/day boundary is **Eastern Time**.
- **Forward-only** generation at launch (no historical backfill in v1).

## Non-goals (v1)

- No historical backfill (a backfill workflow can be added later if the archive feels bare).
- No live "today, in-progress" refresh — we summarize **closed** ET days only.
- No per-release linkification inside bullets — bullets are plain text in v1.
- No dedicated archive route or pinned "latest day" card — date headers in the timeline only.
- No client-side per-viewer timezone grouping (summaries are pre-generated against one fixed
  ET boundary; per-viewer grouping would desync the prose from the buckets).

## Decisions (locked during brainstorming)

| Question          | Decision                                                                  |
| ----------------- | ------------------------------------------------------------------------- |
| Artifact shape    | One combined record (title + one-line summary + bullets), single pass     |
| Trigger & scope   | Daily cron, **all** collections by default, **individually configurable** |
| Model             | Cheap **OpenRouter** lane; Anthropic Haiku as fail-open fallback          |
| Display surface   | **Date headers in the timeline**                                          |
| Day boundary      | **Eastern Time** (`America/New_York`)                                     |
| Backfill          | **Forward-only** first                                                    |
| Storage           | **Dedicated table**, not `knowledge_pages`                                |
| Generation timing | **Closed ET days only** (today's header appears next morning)             |
| Bullets           | **Plain text** (no per-release links) in v1                               |

## Architecture

### 1. Data model

New table `collection_daily_summaries` (schema in `packages/core/src/schema.ts`, paired
migration in `workers/api/migrations/`):

| column          | type                         | purpose                                            |
| --------------- | ---------------------------- | -------------------------------------------------- |
| `id`            | text PK                      | typed id                                           |
| `collection_id` | text FK → `collections.id`   | owning collection                                  |
| `summary_date`  | text (`YYYY-MM-DD`, ET)      | the day being summarized; grouping key             |
| `title`         | text                         | headline (~`title_generated` length, ~60–90 chars) |
| `summary`       | text                         | one-line description                               |
| `takeaways`     | text (JSON array of strings) | bullet takeaways                                   |
| `release_count` | integer                      | # releases that day (display + provenance)         |
| `model_id`      | text                         | `<provider>:<model>` that generated it             |
| `generated_at`  | integer (epoch)              | first generation                                   |
| `updated_at`    | integer (epoch)              | last regeneration                                  |

- `UNIQUE(collection_id, summary_date)` → idempotent upsert; re-running the cron for a day
  replaces in place.
- Index on `(collection_id, summary_date DESC)` for the date-range read.

**Rationale for a dedicated table over reusing `knowledge_pages`:** org overviews are a single
_living_ markdown page per entity over a rolling 90-day window (one row per org, mutated in
place, with a citations side-table). Daily summaries are _many_ short, date-keyed records per
collection with discrete `title` / `summary` / `takeaways` fields. Overloading the
`knowledge_pages` scope enum would force date semantics and multi-row-per-entity cardinality
onto a table designed for one-page-per-entity, and would tangle the citation machinery. A
purpose-built table is simpler to query (date-range scan), cheaper to reason about, and keeps
both features independently evolvable.

**Per-collection config:** add `daily_summary_enabled` boolean to the `collections` table,
**default `true`**. Toggled via the existing collection update path (admin/PATCH route) and
exposed through the CLI's `admin` command surface. The nightly cron only considers collections
where this is true.

### 2. Generation lane (OpenRouter cost path)

Reuse the consolidated text-model seam (`packages/ai/src/text-model.ts` +
`workers/api/src/lib/text-model.ts`). Add a new lane resolver:

```
resolveCollectionSummaryModel(env): Promise<TextModel | null>
  → resolveTextModel(env, {
      orModel: env.COLLECTION_SUMMARY_MODEL,   // cheap OpenRouter model id
      anthropicModel: <Haiku fallback>,        // fail-open only
      generationName: "collection-daily-summary",
    })
```

- Governed by the existing single `openrouter-enabled` Flagship switch.
- `COLLECTION_SUMMARY_MODEL` (wrangler var) points at a cheap OpenRouter model; empty string is
  the per-lane off switch (keeps the lane on Anthropic). Fail-open is layered exactly like the
  marketing/summarize lanes: missing OpenRouter key/model quietly falls through to Anthropic;
  a runtime OpenRouter throw is caught by the cron's per-collection try/catch.
- Per-call `ai_usage` events are emitted automatically via `withLaneUsageLogging`.

New prompt module `packages/ai/src/collection-summary.ts`:

- **Input:** collection name/description + that ET day's releases, each reduced to
  `{ org, product?, title (prefer title_generated/title_short), summary }`. Cap the release
  list and per-release content to bound tokens — reuse the overview cap philosophy
  (`packages/core/src/overview.ts`): a hard release ceiling and per-org/per-kind family caps so
  one noisy source can't dominate.
- **Output:** a compact JSON object `{ title, summary, takeaways: string[] }`, parsed
  server-side with a tolerant parser (mirrors how `release-content.ts` extracts structured
  fields from a plain text-model response). The seam is text-in/text-out — no tool use.
- **Guidance:** thematic over enumerative; lead with the most significant ship of the day;
  takeaways are concise key points (target ~3–5), may name orgs/products. Skip-on-empty is
  handled by the cron (no AI call for a 0-release day).

### 3. Trigger

New cron `workers/api/src/cron/collection-summaries.ts` on an early-ET daily tick (after the ET
day closes):

1. List collections where `daily_summary_enabled = true`.
2. For each, determine the **just-closed ET day** (and any recent prior day with releases but no
   summary row — bounded catch-up, e.g. last N days).
3. Fetch that day's releases across the collection's members using the existing
   collection-releases query with `publishedAfter`/`publishedBefore` set to the ET day window.
4. **Skip if 0 releases** (no row written, no AI call).
5. Generate via `resolveCollectionSummaryModel`, parse, upsert into
   `collection_daily_summaries` (idempotent on `(collection_id, summary_date)`).
6. Per-collection try/catch so one failure doesn't abort the sweep; failures logged via
   `logEvent`.

On-demand / dry-run path: `POST /v1/workflows/collection-summaries { collectionId?, date?,
dryRun? }` (admin-gated) to generate or preview a single collection/day without waiting for the
cron — used for testing and manual regeneration. Follows the `/v1/workflows/*` job convention.

**Why closed days only:** today's releases are still arriving, so a same-day summary would be
incomplete and would churn. Summarizing the closed prior day (same model as digest emails) gives
a stable, complete artifact. The current day's timeline group simply has no header until the next
morning's run. A live "today" refresh is a documented later enhancement.

### 4. API & web

**API** — `GET /v1/collections/:slug/daily-summaries?from=<date>&to=<date>`:

- Returns the summary rows for the collection within the inclusive ET date range, newest first.
- Additive — the existing cursor-paginated `/v1/collections/:slug/releases` feed is unchanged.
- Shape: `{ summaries: [{ date, title, summary, takeaways, releaseCount }] }` (typed in
  `packages/api-types/`).

**Web** — collection detail page (`web/src/app/collections/[slug]/page.tsx` →
`<CollectionTimeline>`):

- Group the release feed by ET calendar day.
- Fetch daily summaries for the visible date range alongside `collectionReleases` (React
  `cache()`), key them by date.
- Render a new `DailySummaryHeader` above each day's release cards when a summary exists for
  that date: **title + one-line summary always shown; takeaways rendered as bullets** (cap ~5
  with collapse if longer). No emojis (per project UI convention); use the existing AI-summary
  disclaimer treatment consistent with overviews.
- Days with no summary (empty day, or pre-launch day) render their cards with no header — no
  empty-state placeholder.

### 5. Testing

- **Unit (`bun test`):** ET day-bucketing (DST boundaries, late-evening releases), tolerant
  JSON parse (well-formed, fenced, trailing-prose, malformed → safe skip), eligibility
  (0-release day → no row/no AI call), idempotent upsert (re-run replaces, doesn't duplicate).
- **Worker route smoke:** in-process `routes.request()` for `GET
/v1/collections/:slug/daily-summaries` (range filter, empty range) against a `createTestDb()`
  env, per the existing worker smoke pattern.
- **Eval (on-demand, not CI-gated):** a `tests/evals/collection-summary.eval.ts` mirroring
  `release-summary.eval.ts` to sanity-check prompt output quality on real day-windows.
- **Type-check:** root `npx tsc --noEmit` + `workers/api` tsc; `bun run lint`.

## Open questions / future enhancements (out of v1 scope)

- Live "today" refresh (regenerate the in-progress day on a shorter cadence).
- Historical backfill workflow (recent-N-days or full history).
- Linkify takeaways to specific releases/orgs.
- Pinned "latest day" rollup card and/or a dedicated `/collections/:slug/digest` archive route.
- Feeding daily summaries into digest emails / external syndication.

## Affected files (anticipated)

- `packages/core/src/schema.ts` — new `collection_daily_summaries` table + `daily_summary_enabled` on `collections`.
- `workers/api/migrations/` — paired migration.
- `packages/ai/src/collection-summary.ts` — prompt + parse.
- `workers/api/src/lib/text-model.ts` — `resolveCollectionSummaryModel` lane + env var.
- `workers/api/src/cron/collection-summaries.ts` — nightly sweep.
- `workers/api/src/routes/collections.ts` — `GET .../daily-summaries`; `POST /v1/workflows/collection-summaries`.
- `packages/api-types/` — response shape.
- `web/src/app/collections/[slug]/page.tsx` + `<CollectionTimeline>` + new `DailySummaryHeader`.
- `workers/api/wrangler.jsonc` — `COLLECTION_SUMMARY_MODEL` var.
- Tests + eval as above.
