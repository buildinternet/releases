# Releases

Changelog indexer and registry for AI agents and developers. The user-facing CLI lives out-of-tree at [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli); this monorepo is the backend (API worker + D1), the remote MCP server, the web frontend, and the managed-agents harness.

## Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict mode)
- **Database:** Cloudflare D1 + Drizzle ORM. No local SQLite path in this repo — `bun:sqlite` is only used for test fixtures (`tests/db-helper.ts`).
- **API:** Cloudflare Worker with Hono (`workers/api/`)
- **MCP:** Remote MCP server (`workers/mcp/`)
- **AI:** Anthropic SDK (`@anthropic-ai/sdk`); managed agents via `@anthropic-ai/claude-agent-sdk`

## Commands

- Type-check: `npx tsc --noEmit` (root + each worker)
- Tests: `bun test`
- Lint: `bun run lint` (oxlint)
- Format: `bun run format:check`
- **Evals (`tests/evals/`) are manual and on-demand only.** They call AI APIs, cost money, and take minutes. `bun run eval:evaluation` is the only in-repo suite (URL evaluation, ~30s). Parsing + discovery evals live in the OSS CLI repo.

## Workspaces and carved-out packages

Root `package.json` declares `workers/api`, `web`, and `packages/*` as workspaces. `workers/discovery/`, `workers/mcp/`, and `workers/webhooks/` are intentionally excluded — wrangler manages their dependencies independently.

Shared code is split between published npm packages (`@buildinternet/releases-*`) and private in-tree packages (`packages/`):

- `packages/core/` → published as **`@buildinternet/releases-core`** from this monorepo. Pure, runtime-neutral helpers shared with the OSS CLI: DB schema (source of truth), `categories`, `dates`, `changelog-range`, `changelog-slice`, `overview`, `id`, `slug`, `tokens`, `cli-contracts`, `lookup-coordinate`, `fts` (FTS5 query sanitizer — wraps tokens in phrase quotes so `org/repo` and similar punctuation don't error). Consumed here via `workspace:*`; the OSS CLI pulls the published npm version. Schema changes land here first, then get picked up by the CLI on the next version bump.
- `packages/core-internal/` → imported as **`@releases/core-internal`**. Private, workspace-only. DB-coupled / worker-only helpers the thin client doesn't need: `release-upsert` (drizzle upsert config), `hash` (node crypto), `webhook-sign` (HMAC for the webhook subsystem).
- `packages/api-types/` → published as **`@buildinternet/releases-api-types`** from this monorepo. Wire protocol — request/response shapes served by the API worker, consumed by the MCP worker, web frontend, and the OSS CLI. Consumed here via `workspace:*`; the OSS CLI pulls the published npm version. Wire changes land here first; the CLI bumps its pin when adopting new shapes. Additive by default — renames/removals go through a one-minor-version deprecation alias before removal.
- `packages/adapters/` — adapter primitives (`types`, `source-meta`, `content-hash`), the `github`, `cloudflare`, `crawl`, and `feed` adapters. All pure / worker-safe now that the DB-coupled wrappers are gone.
- `packages/ai/` → imported as **`@releases/ai-internal`**. `evaluate` (URL recommendation + `buildMetadataFromEvaluation`), `playbook` (deterministic markdown generation), `providers` (provider-detection table). Worker-safe.
- `packages/rendering/` → imported as **`@releases/rendering/*`**. Atom feed helpers, markdown/JSON formatters, and media URL helpers.
- `packages/search/` → imported as **`@releases/search/*`**. Embedding providers/cache, Vectorize hybrid search, and release/entity/changelog embedding pipelines.
- `packages/lib/` — slim private utilities (`config`, `errors`, `source-edit`, Anthropic client/error helpers, managed-agent rate limits, `anthropic-pricing` for list-price cost estimates on managed-agent sessions). `logger` is published as `@buildinternet/releases-lib/logger`.

## Surviving `src/` tree

- `src/db/schema-coverage.ts` — release_coverage schema (part of the drizzle composite schema).
- `src/agent/` — managed-agents harness (`managed-discovery.ts`) plus shared discovery types and the prompt builder in `discovery.ts`. The legacy sandbox-engine `runDiscovery` has been removed; the discovery worker (`workers/discovery/`) is the only production entrypoint.
- `src/shared/` — shared prompts and typed tools used by both agents and the API worker.

## Conventions

- Logging splits by runtime:
  - **CLI + runtime-neutral packages** (`packages/adapters/`, `packages/ai/`, `packages/lib/`, `scripts/`, `tests/evals/`, `src/agent/`) log via `@buildinternet/releases-lib/logger` (source at `packages/lib/src/logger.ts`). The logger writes to stderr **and** persists per-day files under `~/.releases/logs/` — that's the whole point of using it, and it only makes sense in a Node/Bun runtime.
  - **Worker code** (`workers/api/`, `workers/mcp/`, `workers/discovery/`, `workers/webhooks/`) emits structured JSON via `logEvent()` from `@releases/lib/log-event` (worker-safe; no `fs` imports). Workers Logs indexes top-level keys of JSON-stringified `console.*` lines as filterable fields, so payloads carry `component` (e.g. `"poll-fetch-workflow"`, `"search-log"`) and `event` (kebab-case, e.g. `"no-change-detected"`, `"insert-failed"`) as top-level keys, plus arbitrary context (`sourceSlug`, `err`, request id, workflow instance id, …). Severity is set by which `console.*` function the helper invokes — `logEvent("info"|"warn"|"error", {...})` dispatches to `console.log` / `console.warn` / `console.error`, which is what Workers Logs reads for the level field — so don't put `level` in the payload. The helper unwraps `Error` instances to `{name, message, stack, cause?}` (default `JSON.stringify(err)` produces `{}`). New worker code MUST use `logEvent`; existing plain-string `console.*` call sites migrate per-touch (no one-shot codemod, no lint rule — oxlint doesn't support custom rules and adding ESLint just for this isn't worth it). Do not introduce `@buildinternet/releases-lib/logger` into a worker — it writes to a virtual `fs` discarded per-request and double-tags components with its hard-coded `[releases]` prefix.
- Source types: `github`, `scrape`, `feed`, `agent`. The `scrape` adapter auto-discovers RSS/Atom/JSON feeds before falling back to Cloudflare browser rendering + AI. Feed metadata (URL, type, ETag) is cached in `source.metadata`.
- Crawl mode uses Cloudflare's `/crawl` endpoint for multi-page changelogs, stored in `source.metadata.crawlEnabled`. See `packages/adapters/src/crawl.ts`.
- `daysAgoIso()` from `@buildinternet/releases-core/dates` for date cutoffs.
- D1's hard limit is **100 bound parameters per prepared statement**, so batch INSERTs chunk at `floor(100 / binds_per_row)` per statement. For `releases` (13 binds/row) that's 7 rows per statement. `inArray(...)` lookups chunk at 90 IDs. Raising without re-checking bind count surfaces as a 500 on `/releases/batch`.
- Dedup via `UNIQUE(source_id, url)` and the shared `RELEASE_URL_UPSERT` config in `@releases/core-internal/release-upsert` — on URL collision, content is backfilled when incoming is non-empty and existing is empty.
- Smart fetch (cron): `consecutiveNoChange` / `consecutiveErrors` counters on the `sources` table drive exponential backoff (no_change: 1h–48h, errors: 1h–72h).
- Workflows-based ingest: the daily scrape-agent sweep (live, issue #482) and the hourly poll-and-fetch (live, issue #486) both run as Cloudflare Workflows, gated by `SCRAPE_AGENT_USE_WORKFLOW` / `POLL_FETCH_USE_WORKFLOW`. Each cron phase becomes a `step.do` boundary so embed retries are independent of fetch retries. Per-source tier intervals (normal=4h, low=24h) still gate what's due on a given hourly fire. Inline crons are the rollback.
- Extract tier: `extractFromBody()` branches on body token count — small bodies (≤50K tokens) keep inlining into a one-shot `/v1/messages` call; large bodies (>50K) escalate to a multi-round tool-use loop (`extract-with-tools.ts`) that lets the model pull slices via `get_slice` / `query_json`. Gated off by default behind `EXTRACT_TOOLLOOP_ENABLED`; per-source override via `source.metadata.extractStrategy = "toolloop"`. Any error in the loop falls back to the legacy one-shot path, so enabling it is strictly a cost optimization. See [extract.md](docs/architecture/extract.md).
- Route naming (issue #494): resource CRUD lives on the canonical path (`/v1/<resource>/...`) with auth gated by the `adminRoutes` allowlist in `workers/api/src/index.ts` — this includes `/v1/lookups`. Job / side-effect triggers (summarize, compare, embed backfills, notifications-test) live under `/v1/workflows/<job-name>` in `workers/api/src/routes/workflows.ts`. Legitimate admin-only telemetry that doesn't fit either bucket (cron-runs list/detail, embed/status, log collections under `admin/logs/*`, search-queries, the cross-org overview manifest under `admin/overviews`) stays under `/v1/admin/...`. Do not add new `/v1/admin/*` endpoints for CRUD or for async triggers.
- Org-scoped routes (issue #690 + #698): per-org slug uniqueness for sources and products is enforced by `idx_sources_org_slug` / `idx_products_org_slug`; the global `UNIQUE(slug)` index has been dropped. Source and product detail endpoints are dual-registered — the legacy bare form (`/v1/sources/:slug`, `/v1/products/:slug`) and the canonical org-scoped form (`/v1/orgs/:orgSlug/sources/:sourceSlug`, `/v1/orgs/:orgSlug/products/:productSlug`) share a single handler. Post-#698 the bare form rejects bare slugs with `400 bare_slug_rejected` via `BareSlugRejected` thrown from `resolveSourceFromContext` / `resolveProductFromContext`; only typed IDs (`src_…` / `prod_…`) work on the bare path because IDs stay globally unique. Two GET resolvers — `/v1/lookups/source-by-slug?slug=…` and `/v1/lookups/product-by-slug?slug=…` — return the canonical home (`{sourceId|productId, sourceSlug|productSlug, orgSlug}`) for old bookmarks and slug-only callers; they pick the oldest match by `(createdAt, id)` and carry `Sunset: Sun, 01 Nov 2026 00:00:00 GMT` (auth-gated under `adminRoutes`). Prefer the org-scoped path in new clients; the OSS CLI's `findSource`/`findProduct` already branch on identifier shape (typed-ID → bare path, `org/slug` → split locally, bare slug → resolver round-trip). `POST /v1/sources` and `POST /v1/products` both require `orgId` or `orgSlug` — silent orphan creation is gone. Resolution failures differ: `POST /v1/sources` collapses missing-and-unresolvable into one `400 bad_request` (the org guard checks resolution before validating shape); `POST /v1/products` returns `400 bad_request` only when both fields are omitted, and `404 not_found` when one is supplied but doesn't resolve.
- Org catalog (issue #690): `GET /v1/orgs/:slug/catalog` returns a single payload mixing the org's products and direct sources, ordered for UI consumption. Use it instead of round-tripping `/v1/products?orgSlug=…` + `/v1/sources?orgSlug=…&productId=NULL` from the web frontend. Wire shape lives in `@buildinternet/releases-api-types` and will grow a `kind` discriminator when #693 Phase 3 adds rollups — that's the right time to export the union type.
- On-demand source creation: `POST /v1/lookups { provider: "github", coordinate: "org/repo" }` materializes a hidden source row from a coordinate. Sources and orgs created this way carry `discovery = 'on_demand'` and `isHidden = true`. AI features (overviews, summarization, playbook regen) skip them; embeddings still run via `waitUntil` so semantic search works on the second hit. Negative results are cached in KV (`lookup:github:{org}/{repo}` in `LATEST_CACHE`, 24h for `not_found`, 6h for empty). The existing-source check inside `runLookup` is case-insensitive against `sources.url`. MCP `search` and `/v1/search` (lexical + hybrid) fire the lookup whenever a coordinate-shaped query produces no entity match — release / chunk hits don't suppress it (a coordinate is a precise question about one repo, see #662). MCP `search_releases` always attempts the lookup on coordinate-shaped input. See `docs/superpowers/specs/2026-04-29-on-demand-github-lookup-design.md`.
- `discovery` column (text, NOT NULL DEFAULT `'curated'`, indexed) on `organizations` and `sources` records how the row was created: `'curated'` (default; backfilled for everything pre-existing), `'agent'` (created by the discovery agent), `'on_demand'` (materialized by `/v1/lookups`). The column is the queryable handle for admin tooling and AI-feature gates; per-source detail lives under `metadata.lookup`.
- `parseCoordinate()` from `@buildinternet/releases-core/lookup-coordinate` parses `"org/repo"` (with optional `github:` prefix — `github:org/repo` or `GitHub:org/repo`) into `{ provider: "github", org, repo }`, returning `null` on miss. Other provider prefixes (`npm:`, `gitlab:`, …) are explicitly rejected so we don't pretend to support them. The `GITHUB_SEGMENT` regex (`/^[A-Za-z0-9._-]+$/`) constrains each segment. Org/repo case is preserved on the parsed object — `runLookup` does the case-folding (`LOWER(sources.url) = LOWER(?)`) so `shopify/toxiproxy` and `Shopify/Toxiproxy` resolve to the same row.
- Search-query log: `/v1/search` and the MCP `search` / `search_releases` / `search_registry` tools write each query (truncated to 200 chars) plus mode/result-counts/duration to the `search_queries` table. Web traffic carries `X-Releases-Surface: web` (set by `web/src/lib/api.ts`). Read via `GET /v1/admin/search-queries` (raw rows) and `/v1/admin/search-queries/top` (grouped by query). Kill switch: `SEARCH_QUERY_LOG_DISABLED=true` on the API and MCP workers. Distinct from `telemetry_events`, which only carries command names and stays PII-clean for the OSS CLI contract.
- Categories validated against `CATEGORIES` in `@buildinternet/releases-core/categories` — adding one requires a code change. Tags are freeform (get-or-create via `tags` table). Join tables are `org_tags` and `product_tags`.
- Domain aliases (`domain_aliases` table) map alternate domains to orgs/products. Globally unique. Matched in `findOrg()`/`findProduct()` fallback and in search LEFT JOINs.
- Products are an **optional** grouping layer between orgs and sources (nullable `productId`). Multi-product orgs (e.g. Vercel → Next.js, Turborepo) use them; simple orgs skip.
- Ignored URLs are **org-scoped** (`ignored_urls`, requires `orgId`); blocked URLs are **global** (`blocked_urls`, spam/bad domains). Both checked by `isUrlExcluded()`.
- Release suppression hides from all read paths without deleting (`suppressed=1`).
- Release coverage: multiple releases can cover one launch (marketing post + changelog + app note). Canonical + coverage items tracked in `release_coverage`; read paths hide coverage-side rows by default. See [coverage.md](docs/architecture/coverage.md).
- Org overviews: AI-generated `knowledge_pages` (scope `org`) summarize recent activity. Staleness threshold `OVERVIEW_STALE_DAYS = 30` from `@buildinternet/releases-core/overview`. See [web.md](docs/architecture/web.md).
- Release type: `feature` (default) or `rollup` (seasonal/quarterly catch-all). Classified by the parse agent via the `parsing-changelogs` skill. `get_latest_releases` accepts a `type` filter. The unified `search` tool (issue #539) takes `type: ("orgs"|"catalog"|"releases")[]` to narrow which sections it returns, plus `mode: "lexical"|"semantic"|"hybrid"` for release-retrieval strategy; release hits carry a `kind: "release"|"changelog_chunk"` discriminator on the wire. See [semantic-search.md](docs/architecture/semantic-search.md) and [mcp.md](docs/architecture/mcp.md).
- GitHub CHANGELOG files are fetched alongside tagged releases and stored in `source_changelog_files`; refresh piggybacks on every GitHub fetch. Web surfaces the file via `GET /v1/sources/:slug/changelog`. See [web.md](docs/architecture/web.md).
- Entity resolution prefers IDs over slugs. Org and release lookups accept `org_…` / `rel_…` IDs or slugs interchangeably; source and product lookups accept the typed ID on the bare path (`/v1/sources/:slug`, `/v1/products/:slug`) but require the org-scoped path or `/v1/lookups/{source,product}-by-slug` for slug-only callers (#698). IDs are immutable; prefer them.
- Media pipeline: `filterJunkMedia()` (tracking pixels, favicons, AI-classified chrome) then `processMediaForR2()` uploads survivors to R2. `normalizeMediaUrl()` unwraps Next.js/Vercel image-optimizer URLs before upload. See [web.md](docs/architecture/web.md).

## Further reading

Deep dives live in `docs/architecture/`:

- [remote-mode.md](docs/architecture/remote-mode.md) — D1, auth model, rate limiting, migrations, sessions, cron polling + retier, discovery guardrails.
- [semantic-search.md](docs/architecture/semantic-search.md) — Vectorize indexes, hybrid RRF, query cache, related-entity rails.
- [mcp.md](docs/architecture/mcp.md) — remote MCP server, WebMCP parity, MCP Registry listing.
- [agents.md](docs/architecture/agents.md) — managed agents (discovery + worker), skills, Claude Code plugin.
- [coverage.md](docs/architecture/coverage.md) — release coverage + ingest-time grouping, cron observability.
- [web.md](docs/architecture/web.md) — changelog range/slicing API, GitHub CHANGELOG ingestion, Open Graph images, org overviews, media pipeline.
- [events.md](docs/architecture/events.md) — release event bus: `ReleaseHub` Durable Object, `GET /v1/releases/stream` WebSocket, fire-and-forget publish from batch + cron ingest.
- [cli-distribution.md](docs/architecture/cli-distribution.md) — OSS repo, npm, Homebrew tap.
- [ai-gateway.md](docs/architecture/ai-gateway.md) — optional Cloudflare AI Gateway passthrough for Anthropic SDK calls; covers direct worker calls, leaves Voyage embeddings + managed-agent internal loops on the direct path.
- [extract.md](docs/architecture/extract.md) — two-tier extraction path: one-shot inline for small bodies, multi-round tool-use loop for large ones, hard fallback to one-shot on any failure. Feature-gated behind `EXTRACT_TOOLLOOP_ENABLED`.

## Environment

Do not edit `.env` directly. Required vars documented in `.env.example`.

## Staging

The `api`, `mcp`, and `discovery` workers have a `[env.staging]` block in their `wrangler.jsonc`. Webhooks, crons, and Vectorize are intentionally absent — staging is a read-surface for UI/API iteration plus an agent-iteration sandbox, not a full replica.

- **Hosts:** `api-staging.releases.sh`, `mcp-staging.releases.sh`
- **Deployed as:** `releases-api-staging`, `releases-mcp-staging`, `releases-discovery-staging`
- **Managed agents:** separate Anthropic discovery + worker agents, environment, and vault. Skills are deployed as distinct staging resources (display title suffix `(staging)`) so iteration does not affect prod. See [docs/architecture/agents.md](docs/architecture/agents.md#per-environment-agents). There is no CLI trigger for staging discovery sessions yet — the worker is reachable only via direct POST to `releases-discovery-staging` or scrape-agent cron sweeps (and those are disabled in staging).
- **DB:** `released-db-staging` (separate D1), refreshed on demand from prod
- **Crons:** disabled (`CRON_ENABLED=false`, no cron triggers)
- **Vectorize:** no bindings — search degrades to FTS; `/v1/related/*` returns `degraded: true`
- **R2:** reuses `released-media` (read-only in practice; no cron writes)
- **KV:** reuses the existing preview namespaces, so `wrangler dev` and staging share cache
- **Indexing:** `INDEXING_DISABLED=true` — every response carries `X-Robots-Tag: noindex, nofollow` and `/robots.txt` returns `Disallow: /`
- **Access gate:** both hosts require the staging access key on every request. Missing/invalid → 401. The gate runs before routing, so public-read and admin endpoints are equally protected; CORS preflight (OPTIONS) passes through. The secret is bound via Secrets Store (`STAGING_ACCESS_KEY`) in `workers/api/wrangler.jsonc`, `workers/mcp/wrangler.jsonc`, and `workers/discovery/wrangler.jsonc` staging blocks — `workers/discovery` attaches it to outbound calls to `api-staging` so service-bound requests clear the gate. `api-staging` accepts the key via `X-Releases-Staging-Key` only. `mcp-staging` accepts it via `X-Releases-Staging-Key` or `Authorization: Bearer <key>` — the Bearer form lets Anthropic managed-agent vault credentials (OAuth or Bearer only; no custom-header support) reach the server. Cloudflare Access (SSO) is still the long-term target — see issue #444.

Deploy:

```bash
# From workflow_dispatch on deploy-workers.yml with environment=staging, or:
bunx wrangler deploy --env staging --config workers/api/wrangler.jsonc
bunx wrangler deploy --env staging --config workers/mcp/wrangler.jsonc
bunx wrangler deploy --env staging --config workers/discovery/wrangler.jsonc
```

Refresh staging data from prod:

```bash
# Locally (requires `wrangler whoami` in the Build Internet account):
./scripts/sync-staging-db.sh

# Or via GH Actions: run the "Sync staging DB" workflow with confirm="yes".
```

The sync script copies a content subset — orgs, products, sources, releases, tags, media, knowledge pages, source changelog files, coverage — and skips observability/webhook/vectorize tables (see the TABLES list at the top of `scripts/sync-staging-db.sh`).

## Legacy naming

The project was originally called "Released"; the rename to "Releases" leaves a few deliberately-unchanged identifiers:

- **Env vars** keep the `RELEASED_` prefix (`RELEASED_API_URL`, `RELEASED_API_KEY`, `RELEASED_DATA_DIR`, etc.) — they're wired into Cloudflare Secrets Store, GitHub Actions secrets, and local `.env` files. Renaming requires coordinated rotation across all three.
- **Cloudflare resources** keep their old names: D1 database `released-db` and R2 bucket `released-media`. Renaming these is a live migration, not a text change.

Everything else — copy, prompts, display names, webhook headers (`X-Releases-*`), package/workspace names, the `~/.releases` data dir, localStorage keys — uses the new name.
