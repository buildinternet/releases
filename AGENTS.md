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

- `packages/core/` → published as **`@buildinternet/releases-core`** from this monorepo. Pure, runtime-neutral helpers shared with the OSS CLI: DB schema (source of truth), `categories`, `dates`, `changelog-range`, `changelog-slice`, `overview`, `id`, `slug`, `tokens`, `cli-contracts`. Consumed here via `workspace:*`; the OSS CLI pulls the published npm version. Schema changes land here first, then get picked up by the CLI on the next version bump.
- `packages/core-internal/` → imported as **`@releases/core-internal`**. Private, workspace-only. DB-coupled / worker-only helpers the thin client doesn't need: `release-upsert` (drizzle upsert config), `hash` (node crypto), `webhook-sign` (HMAC for the webhook subsystem).
- `packages/adapters/` — adapter primitives (`types`, `source-meta`, `content-hash`), the `github`, `cloudflare`, `crawl`, and `feed` adapters. All pure / worker-safe now that the DB-coupled wrappers are gone.
- `packages/ai/` → imported as **`@releases/ai-internal`**. `evaluate` (URL recommendation + `buildMetadataFromEvaluation`), `playbook` (deterministic markdown generation), `providers` (provider-detection table). Worker-safe.
- `packages/lib/` — `@releases/lib/*` private (api-types, config, errors, atom, atom-http, formatters, media, media-url, source-edit, embeddings, embedding-cache, vector-search, embed-changelogs, embed-changelog-pipeline, embed-entities, embed-releases). `logger` is published as `@buildinternet/releases-lib/logger`. `api-types` is the shared API response contract — imported by `web/` and all workers.

## Surviving `src/` tree

- `src/db/schema-coverage.ts` — release_coverage schema (part of the drizzle composite schema).
- `src/agent/` — managed-agents harness (`managed-discovery.ts`) plus shared discovery types and the prompt builder in `discovery.ts`. The legacy sandbox-engine `runDiscovery` has been removed; the discovery worker (`workers/discovery/`) is the only production entrypoint.
- `src/shared/` — shared prompts and typed tools used by both agents and the API worker.

## Conventions

- All logging goes to **stderr** via `@buildinternet/releases-lib/logger` (source at `packages/lib/src/logger.ts`).
- Source types: `github`, `scrape`, `feed`, `agent`. The `scrape` adapter auto-discovers RSS/Atom/JSON feeds before falling back to Cloudflare browser rendering + AI. Feed metadata (URL, type, ETag) is cached in `source.metadata`.
- Crawl mode uses Cloudflare's `/crawl` endpoint for multi-page changelogs, stored in `source.metadata.crawlEnabled`. See `packages/adapters/src/crawl.ts`.
- `daysAgoIso()` from `@buildinternet/releases-core/dates` for date cutoffs.
- D1's hard limit is **100 bound parameters per prepared statement**, so batch INSERTs chunk at `floor(100 / binds_per_row)` per statement. For `releases` (13 binds/row) that's 7 rows per statement. `inArray(...)` lookups chunk at 90 IDs. Raising without re-checking bind count surfaces as a 500 on `/releases/batch`.
- Dedup via `UNIQUE(source_id, url)` and the shared `RELEASE_URL_UPSERT` config in `@releases/core-internal/release-upsert` — on URL collision, content is backfilled when incoming is non-empty and existing is empty.
- Smart fetch (cron): `consecutiveNoChange` / `consecutiveErrors` counters on the `sources` table drive exponential backoff (no_change: 1h–48h, errors: 1h–72h).
- Workflows-based ingest: the daily scrape-agent sweep (live, issue #482) and the hourly poll-and-fetch (live, issue #486) both run as Cloudflare Workflows, gated by `SCRAPE_AGENT_USE_WORKFLOW` / `POLL_FETCH_USE_WORKFLOW`. Each cron phase becomes a `step.do` boundary so embed retries are independent of fetch retries. Per-source tier intervals (normal=4h, low=24h) still gate what's due on a given hourly fire. Inline crons are the rollback.
- Route naming (issue #494): resource CRUD lives on the canonical path (`/v1/<resource>/...`) with auth gated by the `adminRoutes` allowlist in `workers/api/src/index.ts`. Job / side-effect triggers (summarize, compare, embed backfills, notifications-test) live under `/v1/workflows/<job-name>` in `workers/api/src/routes/workflows.ts`. Legitimate admin-only telemetry that doesn't fit either bucket (cron-runs list/detail, embed/status, log collections under `admin/logs/*`) stays under `/v1/admin/...`. Do not add new `/v1/admin/*` endpoints for CRUD or for async triggers.
- Categories validated against `CATEGORIES` in `@buildinternet/releases-core/categories` — adding one requires a code change. Tags are freeform (get-or-create via `tags` table). Join tables are `org_tags` and `product_tags`.
- Domain aliases (`domain_aliases` table) map alternate domains to orgs/products. Globally unique. Matched in `findOrg()`/`findProduct()` fallback and in search LEFT JOINs.
- Products are an **optional** grouping layer between orgs and sources (nullable `productId`). Multi-product orgs (e.g. Vercel → Next.js, Turborepo) use them; simple orgs skip.
- Ignored URLs are **org-scoped** (`ignored_urls`, requires `orgId`); blocked URLs are **global** (`blocked_urls`, spam/bad domains). Both checked by `isUrlExcluded()`.
- Release suppression hides from all read paths without deleting (`suppressed=1`).
- Release coverage: multiple releases can cover one launch (marketing post + changelog + app note). Canonical + coverage items tracked in `release_coverage`; read paths hide coverage-side rows by default. See [coverage.md](docs/architecture/coverage.md).
- Org overviews: AI-generated `knowledge_pages` (scope `org`) summarize recent activity. Staleness threshold `OVERVIEW_STALE_DAYS = 30` from `@buildinternet/releases-core/overview`. See [web.md](docs/architecture/web.md).
- Release type: `feature` (default) or `rollup` (seasonal/quarterly catch-all). Classified by the parse agent via the `parsing-changelogs` skill. `search_releases` and `get_latest_releases` accept a `type` filter. `search_releases` also takes `mode: "lexical"|"semantic"|"hybrid"` and returns a `kind: "release"|"changelog_chunk"` discriminator — see [semantic-search.md](docs/architecture/semantic-search.md).
- GitHub CHANGELOG files are fetched alongside tagged releases and stored in `source_changelog_files`; refresh piggybacks on every GitHub fetch. Web surfaces the file via `GET /v1/sources/:slug/changelog`. See [web.md](docs/architecture/web.md).
- Entity resolution prefers IDs over slugs. All lookups accept either `{org_|src_|prod_|rel_}...` or a slug. IDs are immutable; prefer them.
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
