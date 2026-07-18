---
"@buildinternet/releases-api-types": minor
"@buildinternet/releases-core": minor
---

Mobile-app release cards: lean rendering + cross-promo deprioritization.

- **api-types:** add `type` and `appStore` to the related-release source rollup
  (`RelatedReleaseSourceSchema`). Both additive/optional: `type` is the source
  fetch type (`appstore`/`github`/`feed`/…) and `appStore` is the platform + icon
  block already resolved on the org/product/ticker read paths. This lets the "From
  other products" related rail render the lean mobile-app card (app icon + iOS/macOS
  cue) and lets the server deprioritize routine, low-importance app releases out of
  the rail. Older responses that omit both still parse.
- **core:** add `IMPORTANCE_HIGH` (= 4) to `@buildinternet/releases-core/importance` —
  the canonical "notable" floor (the web flame threshold) shared by the related-rail
  and homepage-ticker app-release filters. Additive.
