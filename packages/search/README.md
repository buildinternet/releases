# @releases/search

Embedding providers/cache, Vectorize hybrid search, and release/entity/changelog embedding pipelines.

## Exports

- `@releases/search/embed-changelog-pipeline` — chunk + embed + upsert pipeline for CHANGELOG files, ordered D1-first then Vectorize to avoid orphaned vectors.
- `@releases/search/embed-changelogs` — pure chunking + diffing of CHANGELOG files ahead of embedding, using heading-aware slicing and tiktoken counts.
- `@releases/search/embed-entities` — embed + upsert helper for entity rows (orgs, products, sources, collections) sharing one Vectorize index, keyed by natural ID for idempotent re-embedding.
- `@releases/search/embed-releases` — embed + upsert helper for release rows; embedding failures never fail the write (rows stay `embedded_at = NULL` for later backfill unless `throwOnError` is set).
- `@releases/search/embedding-cache` — KV-backed cache for single-query embeddings, keyed by provider/model/dimensionality; search-query path only.
- `@releases/search/embeddings` — embedding provider abstraction (voyage, openai, workers-ai) behind a single `embedBatch` function, with internal batch-size splitting.
- `@releases/search/hybrid-search-worker` — worker-side hybrid search helper wrapping `vector-search` with D1/Vectorize bindings and embedding config; single source of truth for the API and MCP workers.
- `@releases/search/vector-search` — hybrid search orchestration: runs FTS5 and Vectorize indexes in parallel and merges results with Reciprocal Rank Fusion.

**Private, workspace-only — imported via `@releases/search`, not published to npm.**
