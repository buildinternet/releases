# @buildinternet/releases-core

## 0.26.0

### Minor Changes

- 4b8f335: Add nullable `importance` (1–5) column to releases + parser support in release content generation.

## 0.25.1

### Patch Changes

- 07fd618: Hoist `D1_MAX_BINDINGS` and `IN_ARRAY_CHUNK_SIZE` into `@buildinternet/releases-core/d1-limits` so `packages/core-internal` and the API worker share one source of truth for single-column `IN` chunking.
