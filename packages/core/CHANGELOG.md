# @buildinternet/releases-core

## 0.29.0

### Minor Changes

- 18bc9c2: Bias org overview release selection toward high-signal releases. Every
  truncation stage in `selectReleasesForOverview` (per-source cap, per-kind family
  cap, per-product budget, and the global limit) now leads with releases scored
  `importance >= 4` (the web flame threshold) before falling back to recency, so a
  breaking change or major launch published earlier in the window survives the
  caps instead of being crowded out by later churn. A binary high/normal lead with
  recency as the spine within each tier; NULL importance is treated as unknown
  (folded into the normal bucket), never dropped for being unscored.
- c2455d1: Mobile-app release cards: lean rendering + cross-promo deprioritization.

  - **api-types:** add `appStore` (platform + icon block, additive/optional) to the
    related-release source rollup (`RelatedReleaseSourceSchema`) — the same block the
    org/product/ticker read paths already resolve. Its presence lets the "From other
    products" related rail render the lean mobile-app card (app icon + iOS/macOS cue)
    instead of the standard headline/thumbnail. Older responses that omit it still parse.
  - **core:** add `IMPORTANCE_HIGH` (= 4) to `@buildinternet/releases-core/importance` —
    the canonical "notable" floor (the web flame threshold), now also aliased by
    `OVERVIEW_HIGH_IMPORTANCE` so the threshold has one value. Also adds the shared
    `isRoutineAppRelease(isAppStore, importance)` predicate used by both the server
    related-rail filter and the client homepage-ticker filter. Additive.

## 0.28.0

### Minor Changes

- 4900f5c: Add `collection_weekly_digests` schema (weekly AI-written collection digest content) and the `weekly_digest_enabled` column on `collections`.

## 0.27.0

### Minor Changes

- b94d5c0: Export a shared `chunkArray` helper from `@buildinternet/releases-core/d1-limits` for splitting an array into fixed-size chunks (used to stay under D1's bound-parameter cap).

## 0.26.0

### Minor Changes

- 4b8f335: Add nullable `importance` (1–5) column to releases + parser support in release content generation.

## 0.25.1

### Patch Changes

- 07fd618: Hoist `D1_MAX_BINDINGS` and `IN_ARRAY_CHUNK_SIZE` into `@buildinternet/releases-core/d1-limits` so `packages/core-internal` and the API worker share one source of truth for single-column `IN` chunking.
