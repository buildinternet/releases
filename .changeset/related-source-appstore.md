---
"@buildinternet/releases-api-types": minor
"@buildinternet/releases-core": minor
---

Mobile-app release cards: lean rendering + cross-promo deprioritization.

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
