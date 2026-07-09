# @buildinternet/releases-api-types

## 0.42.0

### Minor Changes

- 5920595: Add `aliasDomains` to `OrgListItemSchema` — an org's alternate domains (org-level `domain_aliases`, product-scoped excluded), sorted. Surfaced next to the primary `domain` in catalog rows so a self-declared listing name reads against every domain the org actually controls.
- 7ca4f09: Add `status` and `aliasDomains` to the search org-hit shape (`SearchOrgHitSchema`) so search results can render the same provenance treatment as the catalog row (#2031): the icon-only stub marker and the origin domain with a `+N` hover listing alternate org-level domains. Both fields are additive and optional.

## 0.41.0

### Minor Changes

- 3a7015f: Allow `tags` on `products[]` entries in the `releases.json` v2 manifest. Product tags mirror the existing org-level `tags` (array of 1–60 char strings, max 50) and are reconciled additively into the existing `product_tags` association — never subject to the no-clobber precedence rule, so a manifest can only add product tags, never remove a curator's. The generated JSON Schema (`https://releases.sh/schemas/releases.json`) is regenerated to match.
