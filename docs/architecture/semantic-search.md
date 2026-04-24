# Semantic search

Hybrid FTS5 + Cloudflare Vectorize search across three indexes, fused with Reciprocal Rank Fusion.

## Indexes

All 512-dim cosine, bound on both the API and MCP workers:

- `releases-v1` — one vector per release (title + content), used by the `search` tool's release path
- `entities-v1` — one vector per org/product/source (name + description + category + domain), used by the `search` tool's catalog path
- `changelog-chunks-v1` — heading-aware ~500-token chunks of stored CHANGELOG.md files, interleaved with release hits in `search` results

## Provisioning

Run `./scripts/create-vectorize-indexes.sh` once per account (idempotent). The default provider is Voyage `voyage-4-lite`, which defaults to 1024-dim vectors but supports Matryoshka-style `output_dimension` — `packages/lib/src/embeddings.ts` requests 512 explicitly so the vectors match the Vectorize indexes. `VOYAGE_API_KEY` lives in Cloudflare's Secrets Store and is bound to both workers under `secrets_store_secrets` in `workers/{api,mcp}/wrangler.jsonc`; to rotate, update the value in the dashboard and redeploy. To switch providers, change `EMBEDDING_PROVIDER` in both `wrangler.jsonc` files (`voyage` | `openai` | `workers-ai`) and recreate the indexes if vector dimensionality differs.

## Ingest

Ingest is automatic on writes and never blocks them. The release batch insert, org/product/source POST/PATCH paths, and `refreshChangelogFile` all wrap embedding generation in `waitUntil` + try/catch — missing bindings, missing API key, or a provider error fall through silently and the row stays with `embedded_at = NULL` for backfill to pick up later. Entity PATCH is gated on the embed-relevant fields actually changing so poll-driven metadata bumps don't re-embed.

## Backfill + debugging

`releases admin embed status` is the first stop — it reports per-table embedded vs unembedded counts via `GET /v1/admin/embed/status`. Run `releases admin embed releases|entities|changelogs` to backfill in 50-row batches against the matching `POST /v1/workflows/embed-{releases,entities,changelogs}` route. The status GET stays under `/admin/embed/status`; the three backfill POSTs live under `/workflows/` and are gated by `authMiddleware` via the `"workflows"` allowlist entry.

## Search modes

The unified MCP `search` tool (and `GET /v1/search`) accepts `mode: "lexical"|"semantic"|"hybrid"` for release retrieval and defaults to `hybrid`. Release hits carry a `kind: "release"|"changelog_chunk"` discriminator — chunk hits include `sourceSlug`, `chunkOffset`, and `chunkLength` so agents can chain into `get_catalog_entry({ identifier: sourceSlug, changelog_offset: chunkOffset, changelog_limit: chunkLength * 3 })` to read surrounding context. The hybrid path degrades to lexical with `degraded: true` + `degradedReason` set if Vectorize bindings or the embedding API are unavailable. Pass `type: ["orgs", "catalog"]` to skip the release-vector path when you only need registry lookups; pass `type: ["releases"]` to skip the entity-vector path. Deprecated shims `search_releases` and `search_registry` still exist for one release cycle.

## Query embedding cache

Optional KV binding `EMBED_CACHE` (both workers) caches single-query embeddings for the hybrid/semantic search path so repeat queries skip the embedding provider. Keyed by `embed:v1:{provider}:{model}:{dim}:sha256(trim+lower(query))` with a 7-day TTL; skipped for empty queries and inputs over 512 chars. Writes use `ctx.waitUntil` so cache misses don't block the response. The helper is in `packages/lib/src/embedding-cache.ts` and wraps the `buildEmbedder` closure in both workers' `search-hybrid.ts`. Binding is optional — without it the helper is a pass-through and behavior matches pre-cache. Ingest paths (`packages/lib/src/embed-releases.ts`, `packages/lib/src/embed-entities.ts`, `packages/lib/src/embed-changelog-pipeline.ts`) deliberately do **not** use the cache: release/entity content rarely repeats, so caching would just bloat KV. The cache key auto-invalidates on any provider, model, or dim switch — there is no manual purge. The API and MCP workers share a single account-scoped KV namespace (keys are identical across workers, so a hit from either warms the other); provision once with `wrangler kv namespace create EMBED_CACHE` (+ `--preview`) and add the same `kv_namespaces` binding block to both `workers/api/wrangler.jsonc` and `workers/mcp/wrangler.jsonc`.

## Related entities

`GET /v1/related/releases?release=<id>&scope=org|global` and `GET /v1/related/sources?source=<slug|id>&scope=org|global` return semantically similar items for an anchor. Both routes pull the anchor's existing Vectorize vector via `getByIds` (no re-embedding), filter by `org_id` metadata when `scope=org`, exclude the anchor, and degrade to an empty list with `degraded: true` when bindings are missing. `org_id` is written into Vectorize metadata by `packages/lib/src/embed-releases.ts` and `packages/lib/src/embed-entities.ts` on every upsert, so a `releases admin embed releases/entities` backfill is required after deploying the first time (vectors predating the metadata addition silently drop out of `scope=org` results until re-embedded). The web source detail page renders four stacked rails backed by these routes (org releases, global releases, org sources, global sources) via `web/src/components/related-{releases,sources}.tsx`. Each rail is wrapped in Suspense with `fallback={null}` and hides itself on empty/degraded responses. Route file: `workers/api/src/routes/related.ts`. The `scope=org` metadata indexes are provisioned by `scripts/create-vectorize-indexes.sh` (idempotent) — run it before deploying the API worker.

## File map

- Shared RRF + provider abstraction: `packages/lib/src/vector-search.ts`, `packages/lib/src/embeddings.ts`
- Worker hybrid orchestrators: `workers/api/src/lib/search-hybrid.ts`, `workers/mcp/src/lib/search-hybrid.ts`
- Ingest helpers: `packages/lib/src/embed-releases.ts`, `packages/lib/src/embed-entities.ts`, `packages/lib/src/embed-changelog-pipeline.ts`
- Backfill CLI: `releases admin embed status|releases|entities|changelogs` — lives in the OSS CLI ([`buildinternet/releases-cli`](https://github.com/buildinternet/releases-cli), `src/cli/commands/admin/embed.ts`)
- Status route: `workers/api/src/routes/admin-embed-status.ts` (`GET /v1/admin/embed/status`)
- Backfill routes: `workers/api/src/routes/workflows.ts` (`POST /v1/workflows/embed-{releases,entities,changelogs}`)
