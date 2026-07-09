---
"@buildinternet/releases-api-types": minor
---

Add `status` and `aliasDomains` to the search org-hit shape (`SearchOrgHitSchema`) so search results can render the same provenance treatment as the catalog row (#2031): the icon-only stub marker and the origin domain with a `+N` hover listing alternate org-level domains. Both fields are additive and optional.
