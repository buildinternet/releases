# @buildinternet/releases-api-types

## 0.45.0

### Minor Changes

- 4b8f335: Add optional `importance` (1–5 AI score) to release shapes and `minImportance` filter on the latest feed.

### Patch Changes

- Updated dependencies [4b8f335]
  - @buildinternet/releases-core@0.26.0

## 0.44.0

### Minor Changes

- 71f132a: Add optional `ogImageUrl` to `ReleaseDetailResponseSchema` / `ReleaseDetail` (#2066): the absolute `media.releases.sh` URL for a release's mirrored OpenGraph image, when one has been generated at ingest time. `null`/absent means no mirrored image exists yet — callers fall back to the on-demand `opengraph-image` route. Additive and optional; older servers omit it.

## 0.43.0

### Minor Changes

- ca892cc: Add `kind` (source + product) and server-resolved `groupSlug`/`groupName` to the `/v1/releases/latest` item shape (`ReleaseLatestItemSchema`). `kind` surfaces the `sources.kind`/`products.kind` classification so read surfaces can detect and deprioritize SDK releases via `resolveSourceKind`; `groupSlug`/`groupName` mirror the web feed's `product ?? source` rollup identity (#1234). All fields are additive and optional — older responses omit them.

  Also add an optional server-derived `thumbnail` (`{ url, alt? } | null`) to the coverage sibling shape (`ReleaseCoverageSiblingSchema`) and to each release item in the lookup payload (`LookupResultPayloadSchema.releases`), so compact release rails can render a visual aid. Additive and optional — older responses omit it.

## 0.42.0

### Minor Changes

- 5920595: Add `aliasDomains` to `OrgListItemSchema` — an org's alternate domains (org-level `domain_aliases`, product-scoped excluded), sorted. Surfaced next to the primary `domain` in catalog rows so a self-declared listing name reads against every domain the org actually controls.
- 7ca4f09: Add `status` and `aliasDomains` to the search org-hit shape (`SearchOrgHitSchema`) so search results can render the same provenance treatment as the catalog row (#2031): the icon-only stub marker and the origin domain with a `+N` hover listing alternate org-level domains. Both fields are additive and optional.

## 0.41.0

### Minor Changes

- 3a7015f: Allow `tags` on `products[]` entries in the `releases.json` v2 manifest. Product tags mirror the existing org-level `tags` (array of 1–60 char strings, max 50) and are reconciled additively into the existing `product_tags` association — never subject to the no-clobber precedence rule, so a manifest can only add product tags, never remove a curator's. The generated JSON Schema (`https://releases.sh/schemas/releases.json`) is regenerated to match.
