# Semantic search

Search on releases.sh is **hybrid**: every query runs both a lexical pass (SQLite FTS5) and a vector pass (Cloudflare Vectorize), and the two result lists are fused with Reciprocal Rank Fusion so exact-term matches and "means the same thing" matches both surface. Embeddings are generated automatically at ingest and never block writes; when Vectorize or the embedding provider is unavailable, search degrades to lexical rather than failing. This doc covers the three indexes, the ingest and backfill paths, ranking (including the recency boost and its tuning knobs), and the debugging entry points — start with `releases admin embed status` when results look wrong.

## Indexes

All 512-dim cosine, bound on both the API and MCP workers:

- `releases-v1` — one vector per release (title + content), used by the `search` tool's release path
- `entities-v1` — one vector per org/product/source (name + description + category + domain), used by the `search` tool's catalog path
- `changelog-chunks-v1` — heading-aware ~500-token chunks of stored CHANGELOG.md files, interleaved with release hits in `search` results

## Empty-body filter (search + related)

Hybrid hydration drops releases whose display body is **empty-tier**
(`@releases/search/content-quality` — same classifier as related rails):
placeholder titles/summaries (`test`), short "no user-facing changes" notes,
URL-only "Full Changelog" stubs. Empty vectors otherwise cluster together and
pollute RRF for unrelated entity queries (observed: `langfuse:test` as hybrid
#1 for `vercel` / `ollama` / `stripe`). Thin (short-but-real) bodies stay
eligible; only empty is hard-excluded from search hits.

## Provisioning

Run `./scripts/create-vectorize-indexes.sh` once per account (idempotent). The default provider is Voyage `voyage-4-lite`, which defaults to 1024-dim vectors but supports Matryoshka-style `output_dimension` — `packages/search/src/embeddings.ts` requests 512 explicitly so the vectors match the Vectorize indexes. `VOYAGE_API_KEY` lives in Cloudflare's Secrets Store and is bound to both workers under `secrets_store_secrets` in `workers/{api,mcp}/wrangler.jsonc`; to rotate, update the value in the dashboard and redeploy. To switch providers, change `EMBEDDING_PROVIDER` in both `wrangler.jsonc` files (`voyage` | `openai` | `workers-ai`) and recreate the indexes if vector dimensionality differs.

## Ingest

Ingest is automatic on writes and never blocks them. The release batch insert, org/product/source POST/PATCH paths, and `refreshChangelogFile` all wrap embedding generation in `waitUntil` + try/catch — missing bindings, missing API key, or a provider error fall through silently and the row stays with `embedded_at = NULL` for backfill to pick up later. Entity PATCH is gated on the embed-relevant fields actually changing so poll-driven metadata bumps don't re-embed.

**On-demand sources** (created by `POST /v1/lookups`, `discovery = 'on_demand'`) get embeddings too: the lookup handler wraps release embedding in `waitUntil` just like the cron path. This ensures that a second search for the same coordinate resolves through normal semantic search rather than triggering another lookup. Org overview and summarization workflows skip on-demand orgs (same `discovery` column gate); only embeddings run.

## Backfill + debugging

`releases admin embed status` is the first stop — it reports per-table embedded vs unembedded counts via `GET /v1/admin/embed/status`. Run `releases admin embed releases|entities|changelogs` to backfill in 50-row batches against the matching `POST /v1/workflows/embed-{releases,entities,changelogs}` route. The status GET stays under `/admin/embed/status`; the three backfill POSTs live under `/workflows/` and are gated by `authMiddleware` via the `"workflows"` allowlist entry.

## Changelog-chunk write ordering (#620)

`embedAndUpsertChangelogFile` (`packages/search/src/embed-changelog-pipeline.ts`) writes D1 first with `vectorId = null`, then upserts to Vectorize, then runs a second D1 batch (`setChunkVectorIds` in `workers/api/src/cron/poll-fetch.ts`) to set `vectorId` once Vectorize confirms. The two D1 phases are exposed as separate caller callbacks (`onDiff` and `onVectorsCommitted`) so the pipeline stays driver-agnostic.

Why D1-first: writing Vectorize first leaves a window where vectors are live in Vectorize with no `source_changelog_chunks` row pointing at them. Search hydration joins on `scc.vector_id` (`workers/api/src/lib/search-hybrid.ts`), so those vectors silently drop out of results. D1-first means any failure between INSERT and Vectorize upsert leaves chunks with `vectorId = null` — which is exactly what the embed-changelogs backfill route already detects (`SUM(CASE WHEN vector_id IS NULL THEN 1 ELSE 0 END)`). Recovery is automatic on the next backfill run, and idempotent because `buildVectorId` is content-addressed.

Vectorize-side orphans (vectors with no D1 row) can still happen in two narrow cases — Vectorize upsert succeeded then the worker died before `onVectorsCommitted`, or the file changed before backfill ran — but they cannot manifest as phantom hits because hydration filters them out at the join. They cost storage only.

## Search modes

All FTS5 input flows through `toFtsMatchQuery` (in `@buildinternet/releases-core/fts`), which wraps each whitespace-separated token in a phrase quote. Without it, real-world queries like `org/repo`, `@scope/pkg`, or `foo:bar` raised `fts5: syntax error near "/"` (and similar) — silently swallowed in the API worker via `.catch(() => [])`, but thrown in the MCP tools.ts paths. Every raw `releases_fts MATCH` site (api/queries/search.ts, mcp/lib/search-hybrid.ts, mcp/tools.ts ×2) routes through the helper.

The unified MCP `search` tool (and `GET /v1/search`) accepts `mode: "lexical"|"semantic"|"hybrid"` for release retrieval and defaults to `hybrid`. Release hits carry a `kind: "release"|"changelog_chunk"` discriminator — chunk hits expose a nested `chunk` with `source.slug`, `file_path`, `offset`, and `length` so agents can chain into `get_catalog_entry({ identifier: chunk.source.slug, changelog_path: chunk.file_path, changelog_offset: chunk.offset, changelog_limit: chunk.length * 3 })` to read the surrounding section (the `changelog_path` routing is what makes monorepos with multiple CHANGELOG files hit the right one). The hybrid path degrades to lexical with `degraded: true` + `degradedReason` set if Vectorize bindings or the embedding API are unavailable. Pass `type: ["orgs", "catalog"]` to skip the release-vector path when you only need registry lookups; pass `type: ["releases"]` to skip the entity-vector path.

## Recency multipliers

Hybrid release ranking multiplies the fused RRF score by `decay × boost`, both functions of `now − COALESCE(published_at, created_at)`. The decay is exponential (0.5× at the half-life, 0.25× at 2× half-life, …); the boost is a piecewise taper that lifts the freshest content without ever demoting it. Lives in `packages/search/src/hybrid-search-worker.ts`.

Boost curve (Option B from #1045):

```text
boost(age) = boost30d                                              if age ≤ 30d
           = boost30d − (boost30d − boost90d) · (age − 30d) / 60d  if 30d < age < 90d
           = 1.0                                                    otherwise
```

Net multiplier with defaults (`halfLife=120`, `boost30d=1.5`, `boost90d=1.2`):

| Age  | Decay | Boost      | Net                     |
| ---- | ----- | ---------- | ----------------------- |
| 14d  | 0.92  | 1.50       | **1.38**                |
| 30d  | 0.84  | 1.50       | **1.26**                |
| 60d  | 0.71  | 1.35       | **0.96**                |
| 90d  | 0.59  | 1.20 → 1.0 | **0.71 → 0.59** (cliff) |
| 180d | 0.35  | 1.00       | 0.35                    |
| 365d | 0.12  | 1.00       | 0.12                    |
| 2yr  | 0.02  | 1.00       | 0.02                    |

The 0.2 cliff at 90d is the default trade-off — set `SEARCH_RECENCY_BOOST_90D=1.0` to land smoothly and eliminate the discontinuity entirely. The first 30 days are flat at `boost30d` by design: the operator concern in #1045 was that a 2-week-old release should dominate everything except a dramatically better older match.

Tuning knobs (bound to both `api` and `mcp` workers via the `HybridSearchEnv` env type — set on each `wrangler.jsonc` to override):

| Env var                        | Default | Range        | Effect                                                       |
| ------------------------------ | ------- | ------------ | ------------------------------------------------------------ |
| `SEARCH_RECENCY_HALFLIFE_DAYS` | `120`   | `[1, 3650]`  | Decay half-life. Lower → older content drops out faster.     |
| `SEARCH_RECENCY_BOOST_30D`     | `1.5`   | `[1.0, 5.0]` | Peak boost applied to releases ≤ 30 days old.                |
| `SEARCH_RECENCY_BOOST_90D`     | `1.2`   | `[1.0, 5.0]` | Boost at the 90-day knee. Set to `1.0` for a smooth landing. |

The `[1.0, 5.0]` floor on both boost knobs is enforced at parse time so operators can never accidentally demote recent content with this lever — only lift it. The runtime additionally clamps `boost90d` to `min(boost90d, boost30d)` so the taper can't invert (an operator setting `boost90d > boost30d` would otherwise lift 60-day-old content above 30-day-old content within the boost layer). Setting both boosts to `1.0` disables tiered behavior cleanly: the multiplier collapses to pure decay.

## Query embedding cache

Optional KV binding `EMBED_CACHE` (both workers) caches single-query embeddings for the hybrid/semantic search path so repeat queries skip the embedding provider. Keyed by `embed:v1:{provider}:{model}:{dim}:sha256(trim+lower(query))` with a 7-day TTL; skipped for empty queries and inputs over 512 chars. Writes use `ctx.waitUntil` so cache misses don't block the response. The helper is in `packages/search/src/embedding-cache.ts` and wraps the `buildEmbedder` closure in both workers' `search-hybrid.ts`. Binding is optional — without it the helper is a pass-through and behavior matches pre-cache. Ingest paths (`packages/search/src/embed-releases.ts`, `packages/search/src/embed-entities.ts`, `packages/search/src/embed-changelog-pipeline.ts`) deliberately do **not** use the cache: release/entity content rarely repeats, so caching would just bloat KV. The cache key auto-invalidates on any provider, model, or dim switch — there is no manual purge. The API and MCP workers share a single account-scoped KV namespace (keys are identical across workers, so a hit from either warms the other); provision once with `wrangler kv namespace create EMBED_CACHE` (+ `--preview`) and add the same `kv_namespaces` binding block to both `workers/api/wrangler.jsonc` and `workers/mcp/wrangler.jsonc`.

## Related entities

`GET /v1/related/releases?release=<id>&scope=org|global` and `GET /v1/related/sources?source=<slug|id>&scope=org|global` return semantically similar items for an anchor. Both routes pull the anchor's existing Vectorize vector via `getByIds` (no re-embedding), filter by `org_id` metadata when `scope=org`, exclude the anchor, and degrade to an empty list with `degraded: true` when bindings are missing. `org_id` is written into Vectorize metadata by `packages/search/src/embed-releases.ts` and `packages/search/src/embed-entities.ts` on every upsert, so a `releases admin embed releases/entities` backfill is required after deploying the first time (vectors predating the metadata addition silently drop out of `scope=org` results until re-embedded). The web source detail page renders four stacked rails backed by these routes (org releases, global releases, org sources, global sources) via `web/src/components/related-{releases,sources}.tsx`. Each rail is wrapped in Suspense with `fallback={null}` and hides itself on empty/degraded responses. Route file: `workers/api/src/routes/related.ts`. The `scope=org` metadata indexes are provisioned by `scripts/create-vectorize-indexes.sh` (idempotent) — run it before deploying the API worker.

## File map

- Shared RRF + provider abstraction: `packages/search/src/vector-search.ts`, `packages/search/src/embeddings.ts`
- Worker hybrid orchestrators: `workers/api/src/lib/search-hybrid.ts`, `workers/mcp/src/lib/search-hybrid.ts`
- Ingest helpers: `packages/search/src/embed-releases.ts`, `packages/search/src/embed-entities.ts`, `packages/search/src/embed-changelog-pipeline.ts`
- Backfill CLI: `releases admin embed status|releases|entities|changelogs` — lives in the OSS CLI ([`buildinternet/releases-cli`](https://github.com/buildinternet/releases-cli), `src/cli/commands/admin/embed.ts`)
- Status route: `workers/api/src/routes/admin-embed-status.ts` (`GET /v1/admin/embed/status`)
- Backfill routes: `workers/api/src/routes/workflows.ts` (`POST /v1/workflows/embed-{releases,entities,changelogs}`)
