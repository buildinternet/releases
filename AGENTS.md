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

## Local development

The four `dev:*` scripts (`dev:web`, `dev:api`, `dev:mcp`, `dev:discovery`) run each service through [portless](https://github.com/vercel-labs/portless) so they're reachable on stable HTTPS subdomains instead of port numbers — `https://releases.localhost` for the web frontend, `https://{api,mcp,discovery}.releases.localhost` for the workers. First run trusts a local CA and starts a daemon on port 443; subsequent runs reuse it. Apps mapping lives in `portless.json` for direct `portless` invocations from a workspace dir; the actual dev scripts pass `--name` explicitly so `portless run` picks up the override even outside a workspace.

- **Worktrees:** linked git worktrees are detected automatically and the branch name is prepended (`feat-x.releases.localhost`, `feat-x.api.releases.localhost`, …) so multiple checkouts coexist without collision. No config needed — this is built into `portless run`.
- **Override:** set `PORTLESS_NAME=foo` to swap the base name across all four services in one go (`foo.localhost`, `api.foo.localhost`, …). Useful when sharing a machine, demoing on a custom domain, or sidestepping a stuck route. Worktree prefixing still applies on top.
- **Ports:** wrangler is invoked with `--port $PORT --ip 127.0.0.1` so it binds to the ephemeral port portless assigns; Next.js gets `--port $PORT` via `bun run dev`. Don't hard-code dev ports in wrangler.jsonc — portless's auto-assignment is what avoids conflicts when multiple services run simultaneously.

## Workspaces and carved-out packages

Root `package.json` declares `workers/api`, `web`, and `packages/*` as workspaces. `workers/discovery/`, `workers/mcp/`, and `workers/webhooks/` are intentionally excluded — wrangler manages their dependencies independently.

Shared code is split between published npm packages (`@buildinternet/releases-*`) and private in-tree packages (`packages/`):

- `packages/core/` → published as **`@buildinternet/releases-core`** from this monorepo. Pure, runtime-neutral helpers shared with the OSS CLI: DB schema (source of truth), `categories`, `dates`, `changelog-range`, `changelog-slice`, `overview`, `id`, `slug`, `tokens`, `cli-contracts`, `lookup-coordinate`, `fts` (FTS5 query sanitizer — wraps tokens in phrase quotes so `org/repo` and similar punctuation don't error). Consumed here via `workspace:*`; the OSS CLI pulls the published npm version. Schema changes land here first, then get picked up by the CLI on the next version bump.
- `packages/core-internal/` → imported as **`@releases/core-internal`**. Private, workspace-only. DB-coupled / worker-only helpers the thin client doesn't need: `release-upsert` (drizzle upsert config), `hash` (node crypto), `webhook-sign` (HMAC for the webhook subsystem).
- `packages/api-types/` → published as **`@buildinternet/releases-api-types`** from this monorepo. Wire protocol — request/response shapes served by the API worker, consumed by the MCP worker, web frontend, and the OSS CLI. Consumed here via `workspace:*`; the OSS CLI pulls the published npm version. Wire changes land here first; the CLI bumps its pin when adopting new shapes. Additive by default — renames/removals go through a one-minor-version deprecation alias before removal.
- `packages/adapters/` — adapter primitives (`types`, `source-meta`, `content-hash`), the `github`, `cloudflare`, `crawl`, and `feed` adapters. All pure / worker-safe now that the DB-coupled wrappers are gone.
- `packages/ai/` → imported as **`@releases/ai-internal`**. `evaluate` (URL recommendation + `buildMetadataFromEvaluation`), `playbook` (deterministic markdown generation), `providers` (provider-detection table), `release-content` (Haiku 4.5 summarization for `title_generated` / `title_short` / `summary` — shared by `scripts/generate-release-content.ts` and the ingest-time hook), `marketing-classifier` (Haiku 4.5 binary verdict on whether a feed item is real product news vs. marketing — used by `fetchOne` when `metadata.marketingFilter` is set). Worker-safe; caller passes the Anthropic client.
- `packages/rendering/` → imported as **`@releases/rendering/*`**. Atom feed helpers, markdown/JSON formatters, and media URL helpers.
- `packages/search/` → imported as **`@releases/search/*`**. Embedding providers/cache, Vectorize hybrid search, and release/entity/changelog embedding pipelines.
- `packages/lib/` — slim private utilities (`config`, `errors`, `source-edit`, Anthropic client/error helpers, managed-agent rate limits, `anthropic-pricing` for list-price cost estimates on managed-agent sessions). `logger` is published as `@buildinternet/releases-lib/logger`.

## Surviving `src/` tree

- `src/db/schema-coverage.ts` — release_coverage schema (part of the drizzle composite schema).
- `src/agent/` — managed-agents harness (`managed-discovery.ts`) plus shared discovery types and the prompt builder in `discovery.ts`. The legacy sandbox-engine `runDiscovery` has been removed; the discovery worker (`workers/discovery/`) is the only production entrypoint.
- `src/shared/` — shared prompts and typed tools used by both agents and the API worker.

## Conventions

> Keep entries to **one line: the rule + a pointer to the doc that owns the detail.** When a feature needs a paragraph, that paragraph belongs in `docs/architecture/`, not here. This section has bloated twice from append-on-ship; resist it.

- Logging splits by runtime: **worker code** (`workers/*`) MUST log via `logEvent()` from `@releases/lib/log-event` (worker-safe structured JSON); **CLI + runtime-neutral packages** use `@buildinternet/releases-lib/logger` (stderr + `~/.releases/logs/`). Never import the `fs`-backed `@buildinternet/releases-lib/logger` into a worker. Payload conventions, severity, and `Error` unwrapping: [logging.md](docs/architecture/logging.md).
- Source types (fetch adapters): `github`, `scrape`, `feed`, `agent`, `appstore`. Adapter behavior + `appstore` materialization: [ingest.md](docs/architecture/ingest.md).
- **Ingest pipeline** (fetch → parse → insert) — dedup (`UNIQUE(source_id,url)` + `RELEASE_URL_UPSERT`), smart-fetch backoff, URL exclusion (`ignored_urls` org-scoped / `blocked_urls` global, via `isUrlExcluded()`), release suppression (`suppressed=1`), and the ingest-time Haiku 4.5 passes (content summarization, the per-source marketing classifier via `metadata.marketingFilter`, feed-content enrichment via `FEED_ENRICH_ENABLED`): [ingest.md](docs/architecture/ingest.md). Cron/Workflow orchestration: [remote-mode.md](docs/architecture/remote-mode.md).
- **`source.url` is for humans; fetch routing lives in metadata.** `source.url` is the canonical human-readable URL; machine fetch endpoints (RSS via `metadata.feedUrl`, GitHub-CHANGELOG override via `metadata.githubUrl`, …) live in metadata. Test: would a human ever want to land on this URL? If no, it's metadata. See [remote-mode.md → Display URL vs. fetch routing](docs/architecture/remote-mode.md#display-url-vs-fetch-routing).
- Crawl mode uses Cloudflare's `/crawl` endpoint for multi-page changelogs, stored in `source.metadata.crawlEnabled`. See `packages/adapters/src/crawl.ts`.
- Firecrawl monitoring: external fetch backend for `scrape` sources behind an anti-bot challenge our Browser Rendering can't clear; toggled per source via `source.metadata.firecrawl` (not a new `type`), excluded from the poll-fetch cron, prod-only secrets. **Gotcha: the webhook carries a hunkless whole-document diff (no `@@` headers) — parse only via `addedContentFromDiff`.** See [firecrawl-monitoring.md](docs/architecture/firecrawl-monitoring.md).
- **Full-history backfill** for windowed scrape sources: `POST /v1/workflows/backfill-source { sourceId, markdown?, maxWindows?, dryRun? }` loops extraction over every window and upserts idempotently; deep Firecrawl path routes to durable `BackfillSourceWorkflow` (R2 snapshot + per-window steps, resumable) behind `BACKFILL_WORKFLOW_ENABLED` (default off); returns `202 { instanceId, statusUrl }` async. See [firecrawl-monitoring.md](docs/architecture/firecrawl-monitoring.md).
- **Raw capture + re-extract:** the steady-state scrape path captures the scraped markdown to `released-raw` behind `raw-snapshot-capture-enabled` (default off; discovery worker POSTs to `POST /v1/orgs/:org/sources/:id/raw-snapshot`, #1283); `POST /v1/workflows/reextract-source { sourceId, snapshotId?, dryRun? }` re-runs extraction from a stored snapshot with no live scrape, reusing the backfill machinery (#1284). See [firecrawl-monitoring.md](docs/architecture/firecrawl-monitoring.md).
- `daysAgoIso()` from `@buildinternet/releases-core/dates` for date cutoffs.
- **D1's hard limit is 100 bound parameters per prepared statement.** Batch INSERTs chunk at `floor(100 / binds_per_row)` (for `releases`, 13 binds/row → 7 rows/statement); `inArray(...)` lookups chunk at 90 IDs. Raising without re-checking bind count surfaces as a 500 on `/releases/batch`.
- Workflows-based ingest: the daily scrape-agent sweep (#482) and hourly poll-and-fetch (#486) run as Cloudflare Workflows, gated by `SCRAPE_AGENT_USE_WORKFLOW` / `POLL_FETCH_USE_WORKFLOW`; per-source tier intervals (normal=4h, low=24h) gate what's due; start is smeared across `FANOUT_JITTER_WINDOW_MS`. Inline crons are the rollback. See [remote-mode.md](docs/architecture/remote-mode.md).
- **Feature flags via Cloudflare Flagship (Tier 1).** Boolean kill switches / rollout gates evaluate at runtime through the `FLAGS` binding; registry is `@releases/lib/flags` (`flag(binding, varValue, def)`); order is Flagship → wrangler var → default, failing open to the var. Adding a flag: add a `FLAGS` entry, convert the read to `await flag(...)`, and create the same kebab-case key in BOTH Flagship apps (`releases-platform{,-staging}`). Numeric tunables and secrets are intentionally NOT in Flagship. See [feature-flags.md](docs/architecture/feature-flags.md).
- Extract tier: `extractFromBody()` branches on body token count — ≤50K one-shot `/v1/messages`, >50K a multi-round tool-use loop (`extract-with-tools.ts`), gated behind `EXTRACT_TOOLLOOP_ENABLED` (per-source `metadata.extractStrategy = "toolloop"`); falls back to one-shot on any error. See [extract.md](docs/architecture/extract.md).
- **Classification taxonomy** — source `kind` enum, products, release type (`feature`/`rollup`), tags, categories, collections, and how these axes differ (`kind` vs `type` vs `category`): [taxonomy.md](docs/architecture/taxonomy.md).
- **REST route surface** — route-naming buckets (#494), org-scoped routes + dual-registration + `bare_slug_rejected` (#690/#698), the `/v1/lookups` family (coordinate POST + on-demand materialization, by-domain, slug resolvers), org catalog, entity resolution (IDs over slugs), pagination shape, and the OpenAPI coverage gate (#894): [routing.md](docs/architecture/routing.md).
- Search-query log: `/v1/search` and the MCP `search` / `search_releases` / `search_registry` tools write each query (≤200 chars) + mode/counts/duration to `search_queries` (web carries `X-Releases-Surface: web`). Read via `GET /v1/admin/search-queries{,/top}`. Kill switch `SEARCH_QUERY_LOG_DISABLED`. Distinct from `telemetry_events`, which carries only command names and stays PII-clean for the OSS CLI contract.
- Release coverage: multiple releases can cover one launch (marketing post + changelog + app note); canonical + coverage items tracked in `release_coverage`, read paths hide coverage-side rows by default. See [coverage.md](docs/architecture/coverage.md).
- Org overviews: AI-generated `knowledge_pages` (scope `org`) summarize recent activity; staleness threshold `OVERVIEW_STALE_DAYS = 30` from `@buildinternet/releases-core/overview`. See [web.md](docs/architecture/web.md).
- GitHub CHANGELOG files are fetched alongside tagged releases, stored in `source_changelog_files` (refresh piggybacks on every GitHub fetch); web surfaces them via `GET /v1/sources/:slug/changelog`. See [web.md](docs/architecture/web.md).
- Media handling: at ingest, `normalizeMediaUrl()` (`packages/rendering/src/media-url.ts`) strips Next.js/Vercel image-optimizer wrappers so the underlying CDN URL is stored. Ingest-time R2 mirroring is implemented but **gated behind `MEDIA_R2_UPLOAD_ENABLED` (default off)**; flag-off stores third-party URLs verbatim. See [web.md → Media handling](docs/architecture/web.md).
- Org avatars: stored at `orgs/{slug}.{ext}` in `released-media`, served from `https://media.releases.sh/orgs/{slug}.{ext}`; pointer on `organizations.avatar_url`, writable via `PATCH /v1/orgs/:slug { avatarUrl }`. New orgs land `null` with the OG/web fallback to `github.com/{handle}.png` (#982 open). Reuse the `orgs/{slug}.{ext}` key for any new avatar-write path. See [web.md](docs/architecture/web.md).
- Scoped API tokens: opaque `relk_<lookupId>_<secret>` Bearer tokens (`api_tokens` table), scope ladder `read ⊂ write ⊂ admin`; static `RELEASES_API_KEY` is implicit root; kill switch `API_TOKENS_DISABLED`. MCP gates the AI tools + the on-demand `/v1/lookups` fallback on `write` and forwards the caller's own token. See [remote-mode.md → Auth model](docs/architecture/remote-mode.md) and [mcp.md → scope enforcement](docs/architecture/mcp.md).

## Further reading

Deep dives live in `docs/architecture/`:

- [remote-mode.md](docs/architecture/remote-mode.md) — D1, auth model (scoped API tokens), rate limiting, migrations, sessions, cron polling + retier, workflows-based ingest, discovery guardrails.
- [ingest.md](docs/architecture/ingest.md) — ingest pipeline: source-type adapters, dedup + D1 batching, smart-fetch backoff, URL exclusion / suppression, and the ingest-time AI passes (summarization, marketing classifier, feed enrichment).
- [logging.md](docs/architecture/logging.md) — per-runtime logging: `logEvent()` for workers vs. the `fs`-backed logger for CLI/neutral packages, payload conventions, severity, `Error` unwrapping.
- [routing.md](docs/architecture/routing.md) — REST route surface: naming buckets, org-scoped routes + dual-registration, the `/v1/lookups` resolver family + on-demand GitHub materialization, org catalog, entity resolution, pagination shape, OpenAPI coverage gate.
- [taxonomy.md](docs/architecture/taxonomy.md) — classification axes: source `kind`, products, release type, tags, categories, collections, and how they differ.
- [semantic-search.md](docs/architecture/semantic-search.md) — Vectorize indexes, hybrid RRF, query cache, related-entity rails.
- [mcp.md](docs/architecture/mcp.md) — remote MCP server, scope enforcement, WebMCP parity, MCP Registry listing.
- [agents.md](docs/architecture/agents.md) — managed agents (discovery + worker), skills, Claude Code plugin.
- [coverage.md](docs/architecture/coverage.md) — release coverage + ingest-time grouping, cron observability.
- [web.md](docs/architecture/web.md) — changelog range/slicing API, GitHub CHANGELOG ingestion, Open Graph images, org overviews, category overlay, collections, media pipeline, org avatars.
- [events.md](docs/architecture/events.md) — release event bus: `ReleaseHub` Durable Object, `GET /v1/releases/stream` WebSocket, fire-and-forget publish from batch + cron ingest.
- [cli-distribution.md](docs/architecture/cli-distribution.md) — OSS repo, npm, Homebrew tap.
- [ai-gateway.md](docs/architecture/ai-gateway.md) — optional Cloudflare AI Gateway passthrough for Anthropic SDK calls; covers direct worker calls, leaves Voyage embeddings + managed-agent internal loops on the direct path.
- [extract.md](docs/architecture/extract.md) — two-tier extraction path: one-shot inline for small bodies, multi-round tool-use loop for large ones, hard fallback to one-shot on any failure. Feature-gated behind `EXTRACT_TOOLLOOP_ENABLED`.
- [feature-flags.md](docs/architecture/feature-flags.md) — Cloudflare Flagship Tier-1 boolean flags: registry, evaluation order, per-flag reference, dashboard setup.
- [firecrawl-monitoring.md](docs/architecture/firecrawl-monitoring.md) — external Firecrawl fetch backend for challenge-blocked `scrape` sources: monitor lifecycle, the hunkless `monitor.page` diff wire format, the diff-delta vs. full re-scrape ingest paths, cost gate, poll-fetch exclusion, and staleness resilience.
- [maintenance-workspace.md](docs/architecture/maintenance-workspace.md) — per-user `~/.releases/work/` (tasks / runs / reports) convention for agent-driven admin maintenance; durable, cost-aware trail for the seeding/maintaining/managing/overview skills, reachable across the monorepo and CLI checkouts.

## Environment

Do not edit `.env` directly. Required vars are documented in `.env.example`. App env vars use the `RELEASES_` prefix (`RELEASES_API_URL`, `RELEASES_API_KEY`, `RELEASES_DATA_DIR`, …).

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

The sync script copies a content subset — orgs, products, sources, releases, tags, media, knowledge pages, source changelog files, coverage — and skips observability/webhook/vectorize tables (see the TABLES list at the top of `scripts/sync-staging-db.sh`). It also copies `d1_migrations` so staging's wrangler log mirrors prod's; this self-heals the "schema is ahead of the migration log" drift that happens when DDL gets applied to staging out-of-band.

When iterating on a new migration against staging, use `bunx wrangler d1 migrations apply DB --env staging --remote --config workers/api/wrangler.jsonc` — this applies the SQL and records the row in `d1_migrations`. Don't `wrangler d1 execute --env staging --file workers/api/migrations/...` to test a migration; that lands the schema but not the log row, and the next CI deploy fails with `duplicate column`/`already exists`.

## Legacy naming

The project was originally called "Released"; the rename to "Releases" leaves the Cloudflare resource names deliberately unchanged:

- **Cloudflare resources** keep the `released-` prefix: D1 database `released-db`, and R2 buckets `released-media` (permanent, public media) and `released-raw` (ephemeral raw-page snapshots for backfill — content-hash keyed, 90-day lifecycle, public domain `raw.releases.sh`; see [firecrawl-monitoring.md](docs/architecture/firecrawl-monitoring.md)). The first two predate the rename, so renaming them is a live migration, not a text change; new resources (`released-raw`) keep the prefix for consistency.

Everything else — env vars (`RELEASES_*`), copy, prompts, display names, webhook headers (`X-Releases-*`), package/workspace names, the `~/.releases` data dir, localStorage keys — uses the new name.
