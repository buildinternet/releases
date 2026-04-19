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

- `packages/core/` → imported as **`@releases/core-internal`**. Private superset: DB schema (source of truth), `release-upsert`, `tokens`, `changelog-range`, `hash`, `webhook-sign`, and the monorepo copies of `categories`, `dates`, `changelog-slice`, `overview`, `id`, `slug`. The OSS CLI independently publishes `@buildinternet/releases-core` — a **narrower, curated** subset for thin-client use. The two are intentional forks; **do not import `@buildinternet/releases-core` inside this monorepo**.
- `packages/adapters/` — adapter primitives (`types`, `source-meta`, `content-hash`), the `github`, `cloudflare`, `crawl`, and `feed` adapters. All pure / worker-safe now that the DB-coupled wrappers are gone.
- `packages/ai/` → imported as **`@releases/ai-internal`**. `evaluate` (URL recommendation + `buildMetadataFromEvaluation`), `playbook` (deterministic markdown generation), `providers` (provider-detection table). Worker-safe.
- `packages/lib/` — `@releases/lib/{config,errors}` private. `logger` is published as `@buildinternet/releases-lib/logger`.

Worker tsconfigs map `@releases/lib/*` first to `packages/lib/src/*` (published carve-outs) and fall through to `src/lib/*` for files not yet carved out (formatters, embed helpers, media helpers, vector search).

## Surviving `src/` tree

- `src/api/types.ts` — shared API types, imported by `web/` and all workers (pinned in worker tsconfig `files[]`).
- `src/lib/` — web + worker shared helpers still in flight for carve-out: `formatters`, `atom`, `atom-http`, `embed-*`, `embedding-cache`, `embeddings`, `media`, `media-url`, `source-edit`, `vector-search`.
- `src/db/schema-coverage.ts`, `src/db/migrations/` — release_coverage schema + drizzle-kit migration output.
- `src/agent/` — managed-agents harness (`managed-discovery.ts`, `released.ts`, `run-discovery.ts`, `cli-cmd.ts`, `mcp-cloudflare-browser.ts`). The legacy sandbox-engine `runDiscovery` still lives here but is branch-gated behind `RELEASED_DISCOVERY_ENGINE=sandbox` and not deployable (follow-up tracked in #370/#377).
- `src/shared/` — shared prompts and typed tools used by both agents and the API worker.

## Conventions

- All logging goes to **stderr** via `@buildinternet/releases-lib/logger` (source at `packages/lib/src/logger.ts`).
- Source types: `github`, `scrape`, `feed`, `agent`. The `scrape` adapter auto-discovers RSS/Atom/JSON feeds before falling back to Cloudflare browser rendering + AI. Feed metadata (URL, type, ETag) is cached in `source.metadata`.
- Crawl mode uses Cloudflare's `/crawl` endpoint for multi-page changelogs, stored in `source.metadata.crawlEnabled`. See `packages/adapters/src/crawl.ts`.
- `daysAgoIso()` from `@releases/core-internal/dates` for date cutoffs.
- D1's hard limit is **100 bound parameters per prepared statement**, so batch INSERTs chunk at `floor(100 / binds_per_row)` per statement. For `releases` (13 binds/row) that's 7 rows per statement. `inArray(...)` lookups chunk at 90 IDs. Raising without re-checking bind count surfaces as a 500 on `/releases/batch`.
- Dedup via `UNIQUE(source_id, url)` and the shared `RELEASE_URL_UPSERT` config in `@releases/core-internal/release-upsert` — on URL collision, content is backfilled when incoming is non-empty and existing is empty.
- Smart fetch (cron): `consecutiveNoChange` / `consecutiveErrors` counters on the `sources` table drive exponential backoff (no_change: 1h–48h, errors: 1h–72h).
- Categories validated against `CATEGORIES` in `@releases/core-internal/categories` — adding one requires a code change. Tags are freeform (get-or-create via `tags` table). Join tables are `org_tags` and `product_tags`.
- Domain aliases (`domain_aliases` table) map alternate domains to orgs/products. Globally unique. Matched in `findOrg()`/`findProduct()` fallback and in search LEFT JOINs.
- Products are an **optional** grouping layer between orgs and sources (nullable `productId`). Multi-product orgs (e.g. Vercel → Next.js, Turborepo) use them; simple orgs skip.
- Ignored URLs are **org-scoped** (`ignored_urls`, requires `orgId`); blocked URLs are **global** (`blocked_urls`, spam/bad domains). Both checked by `isUrlExcluded()`.
- Release suppression hides from all read paths without deleting (`suppressed=1`).
- Release coverage: multiple releases can cover one launch (marketing post + changelog + app note). Canonical + coverage items tracked in `release_coverage`; read paths hide coverage-side rows by default. See [coverage.md](docs/architecture/coverage.md).
- Org overviews: AI-generated `knowledge_pages` (scope `org`) summarize recent activity. Staleness threshold `OVERVIEW_STALE_DAYS = 30` from `@releases/core-internal/overview`. See [web.md](docs/architecture/web.md).
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

## Environment

Do not edit `.env` directly. Required vars documented in `.env.example`.
