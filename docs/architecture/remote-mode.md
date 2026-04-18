# Remote Mode (D1)

When `RELEASED_API_URL` is set, the CLI routes data operations through the API Worker instead of local SQLite. The switch point is `src/lib/mode.ts` — `isRemoteMode()` checks the env var once and caches the result. Compiled binaries auto-detect remote mode and default to `https://api.releases.sh` when `RELEASED_API_URL` is unset. Query functions in `src/db/queries.ts` delegate to `src/api/client.ts` in remote mode. All CLI commands support both modes — no command calls `getDb()` directly (except `search` for local FTS).

**Local mode** (default for `bun src/index.ts`): No config needed. Uses `bun:sqlite` at `~/.releases/releases.db`.

**Remote mode** (default for compiled binary): Set `RELEASED_API_URL` and `RELEASED_API_KEY` for admin access. Public read-only access works without any env vars — the compiled binary defaults to `https://api.releases.sh`.

## Auth model

GET endpoints are public (no auth required). Write operations (POST/PATCH/DELETE) require a Bearer token. The `publicReadAuthMiddleware` in `workers/api/src/middleware/auth.ts` handles this split. Admin-only routes (sessions, fetch-log, usage-log, discover, blocked-urls, aliases) require auth for all methods.

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
is fire-and-forget via `ctx.waitUntil`. Stale-up-to-5-minutes is acceptable
for a feed whose upstream publishers push a few times per day at most.

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

Unauthenticated public reads can be throttled per-IP via `publicRateLimitMiddleware` (`workers/api/src/middleware/rate-limit.ts`). It's a Cloudflare Workers Rate Limiting binding (`PUBLIC_RATE_LIMITER`) gated by the `RATE_LIMIT_ENABLED` var — off by default so initial deploys change nothing. Flip the var to `"true"` in `workers/api/wrangler.jsonc` and redeploy to activate. Authenticated callers (valid Bearer token) bypass entirely, so the CLI and MCP server in remote mode are never throttled. Limit values live on the binding in `wrangler.jsonc` — keep them out of user-facing docs. State is per-colo (CF constraint), not global. Wired only onto the public-read route group in `workers/api/src/index.ts`; admin routes are already key-gated.

## Schema + deployment

The API Worker lives at `workers/api/` and shares the Drizzle schema from `@buildinternet/releases-core/schema` (`packages/core/src/schema.ts`). D1 migrations are in `workers/api/migrations/`. Deploy with `cd workers/api && wrangler deploy`.

## Migrations

New migrations use a timestamp prefix (`YYYYMMDDHHMMSS_slug.sql`) to prevent filename collisions when two branches generate migrations concurrently. This applies to both Drizzle migrations under `src/db/migrations/` (driven by `migrations.prefix: "timestamp"` in `drizzle.config.ts`) and hand-written D1 migrations under `workers/api/migrations/`. Existing numeric files (`0000..0008` Drizzle, `0000..0011` D1) stay as-is — renaming them would break `__drizzle_migrations` / `d1_migrations` tracking state on already-migrated DBs. Drizzle tracks applied migrations by `folderMillis` (the journal's `when` field), not by filename, so the prefix is purely cosmetic; wrangler sorts D1 files alphabetically and `"0011"` sorts before `"20260413..."`, so mixed ordering works. When two branches still manage to touch the same underlying table, `meta/_journal.json` will conflict on append — resolve with a trivial merge.

CI enforces two guardrails on every PR: `scripts/check-migration-filenames.sh` rejects new migration files added with a legacy `NNNN_` prefix, and a drift check runs `bunx drizzle-kit generate` against a clean data dir and fails if any schema change is detected (catches "edited `schema.ts` but forgot to run `bun run db:generate`"). Run the filename check locally with `bun run db:check-filenames`.

## Sessions + cron

Session management: `task list` shows active sessions, `task cancel <id>` requests cancellation. Sessions track active source slugs for duplicate detection — the CLI refuses to start a fetch if overlapping sources are already in-flight.

Cron polling: The API Worker runs an hourly `scheduled` handler that polls feed sources and fetches changed ones directly. Configure `GITHUB_TOKEN` as a Worker secret for GitHub source access. Tier intervals are controlled by `fetchPriority` on each source.

## Feed change detection + retier

`releases admin source poll` uses HTTP HEAD requests to flag sources with upstream changes (`changeDetectedAt` column). `releases admin source fetch` uses HEAD as a pre-filter to skip unchanged feeds. Both are purely mechanical — no AI or content parsing involved. The API Worker's hourly cron polls feed sources on tier-based intervals (`fetchPriority`: normal=4h, low=24h, paused=never) and directly fetches changed sources that have a usable feed path — `feed`, `github`, and `scrape` sources whose `metadata.feedUrl` was auto-discovered on first add. Agent sources and scrape sources without a feed are flagged (`changeDetectedAt`) for processing by the daily scrape-no-feed sweep at 01:00 UTC (`workers/api/src/cron/scrape-agent-sweep.ts`) which dispatches per-org `POST /update` calls to the discovery worker, or manually via `releases admin source fetch --changed`.

Self-healing: a `feedUrl` that returns 4xx is tracked via `metadata.feed4xxStreak` (incremented on every 4xx, reset on success). After `FEED_4XX_INVALIDATE_THRESHOLD` (5) consecutive 4xx, the cron clears the feed metadata and resets `noFeedFound: false` so the next fetch re-discovers from the source URL. Sub-threshold 4xx deliberately skips the generic `consecutiveErrors` backoff — it would push the next retry out by hours and slow self-healing. 5xx remains a transient error and applies normal backoff.

A second daily cron at 03:00 UTC (`workers/api/src/cron/retier.ts`) recomputes `fetchPriority` from the median `publishedAt` gap in the last 180 days: ≤14d → normal, 14-90d → low, >90d preserves the current tier. Never auto-pauses (manual vs automatic overrides aren't tracked yet), never touches sources that are already `paused`, and skips tier changes for sources with <3 releases of signal. The retier persists its signal on every source it evaluates via `sources.medianGapDays` (REAL; null when <3 releases of signal) and `sources.lastRetieredAt` (ISO timestamp); the API returns both on `GET /v1/sources`, and the dev-gated status dashboard (`web/src/app/status/`) renders them as a Cadence column that flags mismatches between cadence and tier (e.g. a paused source still shipping on a 5-day median). The `lastPolledAt` column tracks when each source was last polled by the cron.

## List endpoints

`GET /v1/sources` supports `?limit=<n>` (default 100, hard cap 500) and either `?offset=<n>` or `?page=<n>` (1-indexed). Returns a bare `SourceWithOrg[]` by default for backward compatibility. Pass `?envelope=true` to get a paginated shape: `{ items, pagination: { page, pageSize, returned, totalItems, totalPages, hasMore } }`. The envelope path runs one extra COUNT query against the same `whereClause`, so it's cheap but not free — callers that only need one page's data can stick with the bare array. The CLI's shared `@buildinternet/releases-core/cli-contracts` types (`ListResponse<T>`, `Pagination`) match this shape.

## Discovery guardrails

The discovery worker checks `GET /api/sessions?status=running&type=onboard` before spawning a new session. Returns 409 if the same company (case-insensitive) is already being discovered, 429 if 5+ onboard sessions are running. Uses a service binding (`API_WORKER`) for Worker-to-Worker communication. The `GET /sessions` endpoint supports `?status=` and `?type=` query param filtering.

## Realtime streaming

`GET /v1/releases/stream` is a public WebSocket that emits `release.created`
events as they land in D1. Backed by the global `ReleaseHub` Durable Object
with hibernation. The CLI's `tail -f` uses this stream in remote mode and
falls back to polling `/v1/releases/latest` on transport failure or
`snapshot_gap`. See [events.md](./events.md).
