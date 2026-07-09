---
"@buildinternet/releases-api-types": minor
---

Add `aliasDomains` to `OrgListItemSchema` — an org's alternate domains (org-level `domain_aliases`, product-scoped excluded), sorted. Surfaced next to the primary `domain` in catalog rows so a self-declared listing name reads against every domain the org actually controls.
