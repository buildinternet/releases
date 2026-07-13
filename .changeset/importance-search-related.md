---
"@buildinternet/releases-api-types": minor
---

Add optional nullable `importance` (AI-scored 1–5) to `SearchReleaseHitSchema`, `RelatedReleaseItemSchema`, and `DigestCoveredReleaseSchema` so search, related rails, and collection digests can surface the same score already on feed/detail release shapes.
