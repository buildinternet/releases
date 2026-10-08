---
"@buildinternet/releases-api-types": patch
---

Accept `weeklyDigestEnabled` in the `PATCH /v1/collections/:slug` request body so a collection's weekly digest generation can be turned off (it is on by default for new collections).
