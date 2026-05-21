# API worker (D1)

The API worker at `workers/api/` is the authoritative data plane — every read and write goes through it. There is no local-SQLite path anymore; the OSS CLI ([`buildinternet/releases-cli`](https://github.com/buildinternet/releases-cli)) is a pure HTTP client that talks to `RELEASED_API_URL` (default `https://api.releases.sh`), and all the internal workers (MCP, discovery, webhooks, cron) bind directly to D1.

## Auth model

GET endpoints are public (no auth required). Write operations (POST/PATCH/DELETE) require a Bearer token. The `publicReadAuthMiddleware` in `workers/api/src/middleware/auth.ts` handles this split. Admin-only routes (sessions, `admin/*`, `workflows/*`) require auth for all methods. The `GET /v1/orgs/:slug/playbook` endpoint is also admin-only (inline `authMiddleware` on the handler) since playbook content is internal.

### Scoped API tokens

Alongside the single static `RELEASED_API_KEY` (now treated as implicit **root** —
all scopes, break-glass), the API worker accepts **DB-backed scoped tokens** in
the `Authorization: Bearer relk_<lookupId>_<secret>` form. Each token (`api_tokens`
table) carries a JSON set of scopes (`read` ⊂ `write` ⊂ `admin`), can be revoked
(`active=0`) or expired (`expires_at`), records `last_used_at`, and is attributed
to a principal (`principal_type`: `internal | agent | user`, plus optional
`principal_id`). Only the `SHA-256` hash of the secret is stored; the public
`lookup_id` is the indexed handle. Validation lives in
`workers/api/src/middleware/token-store.ts` (constant-time, uniform-failure) and
`middleware/auth.ts` (scope enforcement: writes need `write`, admin routes need
`admin`). Manage via admin-gated `/v1/tokens` (mint/list/revoke/patch); mint with
`scripts/mint-token.ts`. Kill switch: `API_TOKENS_DISABLED=true` falls back to the
static key only. See `docs/superpowers/specs/2026-05-20-scoped-api-tokens-design.md`.

## On-demand AI admin endpoints

`POST /v1/workflows/summarize` and `POST /v1/workflows/compare` generate summaries and comparisons via Anthropic on demand. Both are gated by `authMiddleware` and fail with 503 when `ANTHROPIC_API_KEY` is unset. They are distinct from `POST /v1/sources/:slug/summaries`, which upserts a pre-generated row into `release_summaries`. Payload: `summarize` takes exactly one of `source` / `org` (slug or id) plus optional `days` and `instructions`; `compare` takes `sourceA` / `sourceB` plus optional `days`. Each success writes a `usage_log` row tagged with operation `summarize` / `compare`. Prompts live in `workers/api/src/routes/workflows.ts`.

## Cached latest-releases endpoint

`GET /v1/releases/latest` is the unified feed endpoint behind CLI `tail`/`latest`
and (eventually) the public homepage activity feed. Params: `count` (1..100,
default 10), `source` (slug or id), `org` (slug or id, mutually exclusive
with `source`), and `include_coverage` (default false, hides coverage-side
rows).

Only the **default unfiltered shape** (no `source`, no `org`, default `count`,
`include_coverage=false`) is KV-cached — that's the homepage feed and the
`tail -f` hot path, and it collapses to a single key. Filtered variants fall
through to D1 directly (which handles the cardinality comfortably — see
issue #333 comments for the cost model). The handler sets
`X-Cache: HIT|MISS` on cached responses and `X-Cache: BYPASS` on
fall-through. Cache entries live in the `LATEST_CACHE` KV namespace
(`workers/api/src/lib/latest-cache.ts`) for 300 seconds; write-back on miss
is fire-and-forget via `ctx.waitUntil`. The 300s TTL is now a fallback
ceiling rather than the freshness floor: `invalidateLatestCache` purges
the cached key immediately after each publish (see
[events.md](events.md)), so typical staleness drops to seconds once
`INVALIDATION_ENABLED` is flipped to `"true"`.

Cache keys are built from the sorted filter params under prefix `latest:v1:`,
keyed on resolved source/org IDs so two callers for the same entity (slug
vs id) collapse onto the same entry. `ALLOWLISTED_CACHE_KEYS` in the cache
module is the hook for promoting specific filtered shapes (e.g., a hot org
page) into the cached set — empty by default; additions are an explicit
decision backed by analytics.

`tail --follow` polls this same cached endpoint with no extra params so every
follow-poller collapses onto the shared cache entry. Novelty detection lives
client-side via an in-memory seen-id set, not a server-side `since` filter —
a per-client `since` would fork the cache key and defeat the point.

## Rate limiting

`publicRateLimitMiddleware` (`workers/api/src/middleware/rate-limit.ts`) applies two independent Cloudflare Workers Rate Limiting bindings, each behind its own kill switch (both off by default, so initial deploys change nothing). Limit values live on the bindings in `wrangler.jsonc` — keep them out of user-facing docs. State is per-colo (CF constraint), not global. Wired only onto the public-read route group + `/graphql` in `workers/api/src/index.ts`, and only acts on safe (read) methods; admin routes are already key-gated.

- **Anonymous reads → per-IP** (`PUBLIC_RATE_LIMITER`, gated by `RATE_LIMIT_ENABLED`). An invalid/unrecognized Bearer credential falls here too, so a bogus token can't dodge the IP cap.
- **`relk_` tokens → per-token** (`TOKEN_RATE_LIMITER`, keyed by `tokenId`, gated by `TOKEN_RATE_LIMIT_ENABLED`). Closes the old "any valid token = unlimited" gap (#1100). On a 429 the response carries a distinct `"token"` policy in `RateLimit-Policy` and a `rate-limit`/`token-throttled` structured log. A flat quota for now; scope-tiered ceilings are deferred until user-facing tokens exist.
- **Exempt:** the static root key (CLI/MCP/scripts) and the trusted web-frontend proxy (`X-Releases-Proxy-Key`) bypass both limiters, so server-to-server and tooling traffic is never throttled.

Flip either var to `"true"` in `workers/api/wrangler.jsonc` and redeploy to activate.

## Schema + deployment

The API Worker lives at `workers/api/` and shares the Drizzle schema from `@buildinternet/releases-core/schema` (`packages/core/src/schema.ts`). D1 migrations are in `workers/api/migrations/`. Deploy with `cd workers/api && wrangler deploy`.

## Migrations

D1 schema DDL lives exclusively in `workers/api/migrations/`. Prod applies it via `wrangler d1 migrations apply --remote` (automated in the API-worker deploy). Tests apply the same files via `tests/db-helper.ts` → `applyMigrations(sqlite)`, ensuring prod and tests share a single schema history. `schema.ts` is the source of truth for drizzle ORM types and drizzle-kit introspection; `drizzle-kit generate` exists as a scaffold only — its output is gitignored under `.drizzle-out/`.

**`20260429000000_discovery_column.sql`** adds a `discovery TEXT` column (nullable, indexed) to both `organizations` and `sources`. Values: `'curated'` (backfilled on all pre-existing rows), `'agent'` (set by the discovery agent when it creates a row), `'on_demand'` (set by `POST /v1/lookups`). The column is the queryable handle for admin tooling and AI-feature gates (overviews, summarization, playbook regen all skip `discovery = 'on_demand'`). Per-source detail about on-demand materializations lives under `sources.metadata.lookup` (`{ coordinate, fetchedAt, lastRefreshedAt, emptyResult }`).

New migrations use a timestamp prefix (`YYYYMMDDHHMMSS_slug.sql`) to prevent filename collisions when two branches generate migrations concurrently. Existing numeric files (`0000..0011`) stay as-is — renaming them would break `d1_migrations` tracking state on already-migrated DBs. Wrangler sorts D1 files alphabetically and `"0011"` sorts before `"20260413..."`, so mixed ordering works. When two branches still manage to touch the same underlying table, resolve with a trivial merge of the conflicting files.

CI enforces two guardrails on every PR: `scripts/check-migration-filenames.sh` rejects new migration files added with a legacy `NNNN_` prefix, and a drift check runs `bunx drizzle-kit generate` against a clean data dir and fails if any schema change is detected (catches "edited `schema.ts` but forgot to run `bun run db:generate`"). Run the filename check locally with `bun run db:check-filenames`.

## Sessions + cron

Session management: `task list` shows active sessions, `task cancel <id>` requests cancellation. Sessions track active source slugs for duplicate detection — the CLI refuses to start a fetch if overlapping sources are already in-flight.

Cron polling: The API Worker runs an hourly `scheduled` handler that polls feed sources and fetches changed ones directly. Configure `GITHUB_TOKEN` as a Worker secret for GitHub source access. Tier intervals are controlled by `fetchPriority` on each source.

Workflows-based ingest (issue #486, follow-on to #482): the daily scrape-agent sweep at 01:00 UTC runs as a Cloudflare Workflow in prod (`SCRAPE_AGENT_USE_WORKFLOW=true`) — each dispatch phase gets its own `step.do` boundary so a mid-sweep failure doesn't strand the tail. The hourly poll-and-fetch cron has the same treatment behind `POLL_FETCH_USE_WORKFLOW=true`: the cron queries due sources (tier intervals still apply — normal=4h, low=24h — so only a fraction of sources are due on any given hour) and `createBatch`es one `POLL_AND_FETCH_WORKFLOW` instance per source, with step-level retries around `fetch-and-persist`, `embed-releases`, `refresh-changelog-file`, `embed-changelog-chunks`, and `invalidate-latest-cache`. The embed steps get 5 retries × 30s exponential — the whole reason for the migration is ride-out tolerance for Voyage 429s mid-source. `packages/search/src/embed-releases.ts` and `embed-changelog-pipeline.ts` accept an opt-in `throwOnError` so the workflow can actually observe failures; default callers stay fire-and-forget. Inline `pollAndFetch()` remains the rollback path — one-line flag flip.

## Display URL vs. fetch routing

`source.url` is the canonical, human-readable address — what we link people to from the catalog, search results, and rendered release rows. Fetch routing lives in `source.metadata`. The two intentionally diverge: machine-friendly endpoints (RSS, GitHub APIs, raw markdown) feed ingest; the human-friendly page is the only thing users ever see.

Today's example: a `scrape` source's `source.url` points at the docs/changelog page, while `metadata.feedUrl` (auto-discovered on first add) is the actual RSS/Atom/JSON feed the cron polls and parses. The same principle applies to GitHub-backed docs pages via `metadata.githubUrl` (#831): when a docs page is generated from a GitHub-hosted CHANGELOG, set `metadata.githubUrl = "https://github.com/owner/repo"` to make the cron and onboarding paths fetch from the repo's GitHub releases API while keeping `source.url` pointed at the docs page. Each ingested release URL is rewritten through `synthesizeReleaseUrl` (default: `${sourceUrl}#${versionDashed}` — Mintlify anchor convention) so dedup against any pre-existing scrape rows lines up via `UNIQUE(source_id, url)`. Per-product anchor schemes go in `metadata.releaseUrlTemplate` (`${sourceUrl}`, `${version}`, `${versionDashed}` placeholders).

When adding a new fetch backend, the test is: would a human ever want to land on this URL directly? If no, it goes in metadata, not `source.url`.

## Feed change detection + retier

`releases admin source poll` uses HTTP HEAD requests to flag sources with upstream changes (`changeDetectedAt` column). `releases admin source fetch` uses HEAD as a pre-filter to skip unchanged feeds. Both are purely mechanical — no AI or content parsing involved. The API Worker's hourly cron polls feed sources on tier-based intervals (`fetchPriority`: normal=4h, low=24h, paused=never) and directly fetches changed sources that have a usable feed path — `feed`, `github`, and `scrape` sources whose `metadata.feedUrl` was auto-discovered on first add. Agent sources and scrape sources without a feed are flagged (`changeDetectedAt`) for processing by the daily scrape-no-feed sweep at 01:00 UTC (`workers/api/src/cron/scrape-agent-sweep.ts`) which dispatches per-org `POST /update` calls to the discovery worker, or manually via `releases admin source fetch --changed`.

Self-healing: a `feedUrl` that returns 4xx is tracked via `metadata.feed4xxStreak` (incremented on every 4xx, reset on success). After `FEED_4XX_INVALIDATE_THRESHOLD` (5) consecutive 4xx, the cron clears the feed metadata and resets `noFeedFound: false` so the next fetch re-discovers from the source URL. Sub-threshold 4xx deliberately skips the generic `consecutiveErrors` backoff — it would push the next retry out by hours and slow self-healing. 5xx remains a transient error and applies normal backoff.

A second daily cron at 03:00 UTC (`workers/api/src/cron/retier.ts`) recomputes `fetchPriority` from the median `publishedAt` gap in the last 180 days: ≤14d → normal, 14-90d → low, >90d preserves the current tier. Never auto-pauses (manual vs automatic overrides aren't tracked yet), never touches sources that are already `paused`, and skips tier changes for sources with <3 releases of signal. The retier persists its signal on every source it evaluates via `sources.medianGapDays` (REAL; null when <3 releases of signal) and `sources.lastRetieredAt` (ISO timestamp); the API returns both on `GET /v1/sources`, and the dev-gated status dashboard (`web/src/app/status/`) renders them as a Cadence column that flags mismatches between cadence and tier (e.g. a paused source still shipping on a 5-day median). The `lastPolledAt` column tracks when each source was last polled by the cron.

## List endpoints

`GET /v1/sources` supports `?limit=<n>` (default 100, hard cap 500) and either `?offset=<n>` or `?page=<n>` (1-indexed). Returns a bare `SourceWithOrg[]` by default for backward compatibility. Pass `?envelope=true` to get a paginated shape: `{ items, pagination: { page, pageSize, returned, totalItems, totalPages, hasMore } }`. The envelope path runs one extra COUNT query against the same `whereClause`, so it's cheap but not free — callers that only need one page's data can stick with the bare array. The published `@buildinternet/releases-core/cli-contracts` types (`ListResponse<T>`, `Pagination`) match this shape.

CLI-facing list endpoints added before v1 return the envelope by default: `GET /v1/orgs`, `GET /v1/sessions`, `GET /v1/admin/blocklist`, `GET /v1/orgs/:slug/ignored-urls`, `GET /v1/products`, `GET /v1/orgs/:slug/accounts`, and `GET /v1/orgs/:slug/tags`. They all accept `?limit=<n>` and `?page=<n>` with `DEFAULT_PAGE_SIZE` from `@buildinternet/releases-core/cli-contracts` (500) as both the default and hard cap. The shared API helper is `workers/api/src/lib/pagination.ts`; use it for new page/limit list endpoints unless the endpoint has an existing cursor contract. Some routes keep single-row lookup modes (`?single=true`, `?platform=...`) returning their legacy raw row/null shape.

## Discovery guardrails

The discovery worker checks `GET /v1/sessions?type=onboard&recent_minutes=10` before spawning a new session and reads `items` from the paginated response. Returns 409 if the same company (case-insensitive) is already being discovered OR finished within the last 10 minutes (the dedup window — see #656); 429 if 5+ onboard sessions are currently running. Uses a service binding (`API_WORKER`) for Worker-to-Worker communication. `GET /v1/sessions` supports `?status=`, `?type=`, and `?recent_minutes=N` filters; `recent_minutes` keeps any session that's currently `running` OR was last updated within N minutes (running sessions are always included regardless of staleness). The 5-session concurrency cap is computed from running-only sessions on the discovery worker side, so a recently finished session doesn't tie up the budget.

Per-session estimated cost (model id, cache_creation/cache_read/input/output tokens, list-price USD) is captured by the discovery DO via `@releases/lib/anthropic-pricing` on both successful completions AND error terminal events (provider `session.error`, retries-exhausted idle), then stored on `SessionState.usage`. The web `/status` page renders it under each session card with an `≈ $` qualifier so it isn't mistaken for billed cost. See #657.

## Realtime streaming

`GET /v1/releases/stream` is a public WebSocket that emits `release.created`
events as they land in D1. Backed by the global `ReleaseHub` Durable Object
with hibernation. The CLI's `tail -f` uses this stream in remote mode and
falls back to polling `/v1/releases/latest` on transport failure or
`snapshot_gap`. See [events.md](./events.md).
