---
"@buildinternet/releases-core": patch
---

Hoist `D1_MAX_BINDINGS` and `IN_ARRAY_CHUNK_SIZE` into `@buildinternet/releases-core/d1-limits` so `packages/core-internal` and the API worker share one source of truth for single-column `IN` chunking.
