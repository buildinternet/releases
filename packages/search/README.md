# @releases/search

Embedding providers/cache, Vectorize hybrid search, and release/entity/changelog embedding pipelines.

## Exports

Imported as `@releases/search/<subpath>`.

| Subpath                    | Purpose                                                                                    |
| -------------------------- | ------------------------------------------------------------------------------------------ |
| `content-quality`          | Empty/thin/full classification for release bodies (search + related-rails ranking).        |
| `embeddings`               | Embedding provider abstraction (voyage, openai, workers-ai) behind one `embedBatch`.       |
| `embedding-cache`          | KV-backed cache for single-query embeddings, keyed by provider/model/dims.                 |
| `embed-releases`           | Embed + upsert helper for release rows; embedding failures never fail the write.           |
| `embed-entities`           | Embed + upsert helper for entity rows (orgs, products, sources, collections).              |
| `embed-changelogs`         | Pure heading-aware chunking + diffing of CHANGELOG files ahead of embedding.               |
| `embed-changelog-pipeline` | Chunk + embed + upsert pipeline for CHANGELOG files (D1-first to avoid orphaned vectors).  |
| `vector-search`            | Hybrid orchestration — FTS5 + Vectorize in parallel, merged with Reciprocal Rank Fusion.   |
| `hybrid-search-worker`     | Worker-side wrapper over `vector-search` with bindings/config (API + MCP source of truth). |

**Private, workspace-only — not published to npm.**
