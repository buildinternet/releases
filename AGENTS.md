# Releases

Changelog indexer and registry for AI agents and developers.

## Stack

- **Runtime:** Bun
- **Language:** TypeScript (strict mode)
- **Database:** SQLite via Bun's built-in `bun:sqlite` + Drizzle ORM (local), Cloudflare D1 + Drizzle (remote)
- **API:** Cloudflare Worker with Hono (`workers/api/`)
- **CLI:** Commander
- **MCP:** `@modelcontextprotocol/sdk` on stdio
- **AI:** Anthropic SDK (`@anthropic-ai/sdk`)

## Commands

```bash
releases <command>            # after `bun link` (see Development Setup in README.md)
bun src/index.ts <command>    # equivalent, works without linking
```

The project `.env` is auto-loaded by Bun, so `RELEASED_API_URL` and `RELEASED_API_KEY` are already set — no need to prefix commands with them. Remote mode is the default for day-to-day development.

Type-check: `npx tsc --noEmit`

Tests: `bun test`

**Evals (`tests/evals/`) are manual and on-demand only.** Do not run evals as part of normal development, CI, or test verification. They call AI APIs, cost money, and take minutes to complete. Only run evals when explicitly asked by the user via `bun run eval:parsing`, `bun run eval:evaluation`, or `bun run eval:discovery`.

## Building

The CLI compiles to a self-contained binary via `bun build --compile`:

```bash
bun run build                 # compile for current platform (macOS)
bun run build:linux           # cross-compile for Linux (sandbox container)
bun run build:all             # compile CLI + MCP browser server
bun run build:all:linux       # cross-compile both for Linux
```

Output goes to `dist/`. The compiled binary requires remote mode (`RELEASED_API_URL`) — local SQLite mode is only supported via `bun src/index.ts`.

**Workspaces:** Root `package.json` declares `workers/api`, `web`, `npm/*`, and `packages/*` as workspaces. The discovery worker (`workers/discovery/`) and MCP worker (`workers/mcp/`) are intentionally excluded because Bun eagerly resolves imports across all workspace members at startup — the `cloudflare:workers` imports in those workers' files cause `bun src/index.ts` to fail even though the CLI never imports from them. Wrangler manages those workers' dependencies independently.

**Carved-out packages:** Shared code is split between published npm packages (`@buildinternet/releases-*`) and private in-tree packages (`packages/`):
- `packages/core/` (`@releases/core/*`) — private helpers only used in this monorepo: `release-upsert`, `tokens`, `changelog-range`, `hash`. The public subset (`schema`, `categories`, `dates`, `changelog-slice`, `id`, `slug`) is now published as `@buildinternet/releases-core` and imported under that name.
- `packages/adapters/` (`@releases/adapters/*`) — adapter primitives (`types`, `source-meta`, `content-hash`), the `github`, `cloudflare`, and `crawl` adapters, and the pure subset of `feed` (discovery, parsing, HEAD checks). `src/adapters/feed.ts` is a thin wrapper that keeps the db-coupled pieces (`fetchViaFeed`, `updateSourceMeta`, the `feed` Adapter object) alongside a re-export of the pure surface. `src/adapters/{agent,scrape,resolve}.ts` still live in `src/` because they reach into `src/db/queries` and `src/ai/*`.
- `packages/lib/` (`@releases/lib/{config,errors}`) — private CLI/runtime helpers. `@releases/lib/logger` is published as `@buildinternet/releases-lib/logger` and imported under that name. `@releases/lib/config` and `@releases/lib/errors` remain private — the published lib only exposes `getDataDir`/`getLogsDir` (a reduced subset).

Many files still live in `src/lib/` (media, media-url, formatters, embed-*, vector-search, search-hybrid, embeddings, mode, discover, telemetry, providers, etc.) and have not moved yet. Workers (`workers/{api,mcp,discovery}`) use tsconfig path mappings where `@releases/lib/*` falls back to `../../src/lib/*` for files that haven't been carved out. Published subpaths (`@buildinternet/releases-core/*`, `@buildinternet/releases-lib/*`) are also mapped in worker tsconfigs to the workspace packages for consistency.

## Conventions

- All logging goes to **stderr** (`@buildinternet/releases-lib/logger`, source at `packages/lib/src/logger.ts`). stdout is reserved for MCP JSON-RPC in serve mode.
- Source types: `github`, `scrape`, `feed`, and `agent`. The `scrape` adapter auto-discovers RSS/Atom/JSON feeds before falling back to Cloudflare + AI. The `feed` type is for sources where the feed URL is known or discoverable. Feed metadata (URL, type, ETag) is cached in `source.metadata`.
- Crawl mode (`--crawl`) uses Cloudflare's `/crawl` endpoint for multi-page changelogs. Persists in `source.metadata` as `crawlEnabled`. The crawl flow is synchronous (poll until done) — background mode is deferred. See `packages/adapters/src/crawl.ts`.
- Shared DB query helpers live in `src/db/queries.ts` — use them instead of inlining drizzle queries.
- `toReleaseInput()` from `src/ai/query.ts` converts DB rows (nullable fields) to AI input shape — don't hand-roll this mapping.
- `daysAgoIso()` from `@buildinternet/releases-core/dates` (source at `packages/core/src/dates.ts`) for date cutoff calculations.
- CLI commands that return data support `--json` for machine-readable output.
- Batch DB inserts in chunks of 500 (SQLite variable limit). In remote mode, `insertReleasesBatch` in `src/api/client.ts` posts 100 releases per HTTP request to `POST /v1/sources/:slug/releases/batch` — that's an HTTP-level round-trip optimization, not a D1 row cap. **D1's hard limit is 100 bound parameters per prepared statement**, so the worker (`workers/api/src/routes/sources.ts`) chunks at `floor(100 / binds_per_row)` for each INSERT. For the `releases` table Drizzle binds 13 placeholders per row → 7 rows per statement. `inArray(...)` lookups in the same route chunk at 90 IDs for the same reason. Raising these limits without re-checking the per-row bind count surfaces as a 500 on `/releases/batch` with a `Failed query: insert into "releases"` message.
- Dedup via `UNIQUE(source_id, url)` and the shared `RELEASE_URL_UPSERT` config in `@releases/core/release-upsert` (source at `packages/core/src/release-upsert.ts`, private to this monorepo) — on URL collision, content is backfilled when the incoming row is non-empty and the existing row is empty. Both the local (`src/db/queries.ts`) and worker (`workers/api/src/routes/sources.ts`) batch-insert paths import that helper so they can't drift.
- `releases admin source import <file>` bulk-imports orgs and sources from a JSON manifest. Used as the discovery agent handoff point. Supports `--dry-run`, `--json`, `--skip-existing`.
- Smart fetch: `releases admin source fetch --stale <hours>` respects backoff (`nextFetchAfter`) and `fetchPriority`. `releases admin source fetch --changed` targets sources where `releases admin source poll` detected upstream changes (`changeDetectedAt IS NOT NULL`). `releases admin source fetch --retry-errors` retries sources whose last fetch failed. Backoff counters (`consecutiveNoChange`, `consecutiveErrors`) on the `sources` table drive exponential backoff (no_change: 1h–48h, errors: 1h–72h). Default max of 200 releases per source prevents API pagination limits (e.g., GitHub's 10K cap). Use `--max <n>` to adjust or `--all` to remove the cap.
- Categories are validated against `CATEGORIES` in `@buildinternet/releases-core/categories` (source at `packages/core/src/categories.ts`). Adding a new category requires a code change. Tags are freeform — get-or-create semantics via `tags` table. Tag join tables use separate `org_tags` and `product_tags` with proper FK cascades (not polymorphic).
- Domain aliases (`domain_aliases` table) map alternate domains to orgs or products for searchability and dedup. An alias domain is globally unique — only one org or product can claim it. CLI: `releases admin org alias add/remove/list`, `releases admin product alias add/remove/list`. Aliases are checked by `findOrg()` and `findProduct()` as a final fallback step, and matched in search queries via LEFT JOIN.
- Products are an **optional** grouping layer between organizations and sources. Multi-product orgs (e.g., Vercel → Next.js, Turborepo) use products to group their sources. Sources have a nullable `productId` — simple orgs skip this layer. CLI: `releases admin product list/add/edit/remove/adopt`. The `product adopt` command converts an org that should be a product into a product under another org, moving sources and accounts. Products have an optional canonical `url` field.
- Ignored URLs are **org-scoped** — a URL ignored for one org can still be valid for another. The `ignored_urls` table requires `orgId`. CLI: `releases admin policy ignore list/add/remove --org <org>`. Blocked URLs (`blocked_urls` table) are **global** — for spam domains and known-bad URLs. CLI: `releases admin policy block list/add/remove`. Both lists are checked by `isUrlExcluded()` before adding sources.
- Release suppression: individual releases can be suppressed (`releases admin release suppress <id> --reason "..."`) to hide them from queries and search without deleting. Suppressed releases are filtered out of all read paths (search, latest, stats, API). Use `releases admin release unsuppress <id>` to restore.
- Release coverage: multiple releases can cover the same underlying launch (marketing post + platform changelog + app version note). The `release_coverage` table (source in `src/db/schema-coverage.ts`) records the canonical release and its coverage items with an audit trail (`decided_by = human:cli | agent:<model>`, `decided_at`). Both modes support `releases admin release link <canonical> <coverage...>`, `release unlink <id>`, and `release cluster <org> [--window 30] [--model <model>] [--dry-run]` — the cluster verb invokes the `grouping-releases` skill via Haiku by default (override with `RELEASED_GROUPING_MODEL` or `--model claude-sonnet-4-6`). The agent's output is validated against the candidate set — hallucinated IDs and missing-from-output cases are rejected before any write. Read paths (`latest`, `list`, search, MCP) hide coverage-side rows by default; pass `--include-coverage` (CLI) or `includeCoverage: true` (MCP) to surface them. Ingest-time grouping: after a fetch wave completes, each org whose sources inserted new rows gets a single pass through `src/lib/ingest-grouping.ts` → `runIngestTimeGrouping` — drained from an `orgsNeedingGrouping` set in `src/cli/commands/fetch.ts`, alongside the existing `orgsNeedingKnowledgeUpdate` drain. Candidate set is the org's prior 7 days. Running once per org (rather than once per source) collapses what would otherwise be N overlapping agent calls for multi-source orgs. The drain wraps each call in `try { … } catch (err) { logger.warn(…) }` so a flaky agent can never block ingest. Pass `--no-grouping` to skip. Per-request agent output budget is `GROUPING_MAX_TOKENS = 8192` (Haiku 4.5 ceiling); requests that exceed it surface a `response truncated` error rather than a misleading JSON parse failure. Operators who want to re-cluster historical data should use the explicit `cluster` verb with a wider `--window`. Shared helpers `rowsToCandidates` + `writeCoverageClusters` in `src/ai/grouping.ts` back both ingest-time and `release cluster` paths so they can't drift.
- Org overviews: AI-generated knowledge pages (`knowledge_pages` table, scope `org`) summarize recent changelog activity into themed sections. Generation prompt + word target (~120-250, hard ceiling 300) lives in `src/ai/knowledge.ts`. Surfaces: `releases admin org show` prints a preview + generated-at, `releases org overview <slug>` (public, no auth) prints the full body, MCP exposes `get_organization` (preview inline) + `get_organization_overview` (full). Staleness threshold is `OVERVIEW_STALE_DAYS = 30` from `@releases/core/overview` (also published as `@buildinternet/releases-core/overview`); past the threshold every surface still shows the overview but adds a `⚠ older than 30 days` warning. The web's `OverviewView` strips a leading `# Heading` defensively in case the model violates the no-headings rule.
- Release type: each release carries a `type` column — `feature` (default, incremental change or single version) or `rollup` (seasonal/quarterly catch-all page that spans many features, e.g. Brex Fall Release, Ramp quarterly blog). Classification is skill-driven by the parse agent via the `parsing-changelogs` skill; source-level cadence signals live in the playbook notes, not in source metadata. `RELEASE_TYPES` / `ReleaseType` are exported from `@buildinternet/releases-core/schema` (source at `packages/core/src/schema.ts`) — import from there rather than inlining the string union. The `search_releases` and `get_latest_releases` MCP tools accept an optional `type` filter. `search_releases` also accepts `mode: "lexical"|"semantic"|"hybrid"` (default `hybrid`) and returns a `kind: "release"|"changelog_chunk"` discriminator on every hit so chunk matches interleave with release matches in one ranked list — see "Semantic search" below.
- GitHub CHANGELOG files: for `github` sources, the canonical `CHANGELOG.md` (or `CHANGES.md` / `HISTORY.md` / `RELEASES.md` / `NEWS.md`) is fetched alongside tagged releases and stored in the `source_changelog_files` table (single row per source in v1 — monorepo package CHANGELOGs are deferred to v2). The fetch uses one `GET /repos/{owner}/{repo}/contents/` root listing followed by one `raw.githubusercontent.com` request, caps content at 1MB, and refresh piggybacks on every GitHub fetch — the upsert short-circuits on `contentHash` so unchanged files only touch `fetchedAt`. Refresh runs in `src/cli/commands/fetch.ts` (local mode) and `workers/api/src/cron/poll-fetch.ts#refreshChangelogFile` (remote mode). Shared filename list + source of truth: `packages/adapters/src/github.ts#fetchChangelogFile`. The web surfaces the file in a "Changelog" tab on the source detail page via `GET /v1/sources/:slug/changelog`. Manual refresh: `releases admin source refresh-changelog <slug>` (local mode only). Refresh also runs the chunk embedding pipeline (`src/lib/embed-changelog-pipeline.ts` → `chunkChangelog` → diff → embed only changed chunks → upsert to `CHANGELOG_CHUNKS_INDEX`) and reconciles the `source_changelog_chunks` table in the same pass so semantic search stays in sync with the file content.
- Changelog range API (Context7-style slicing): `GET /v1/sources/:slug/changelog` accepts `?offset=<chars>` plus one of `?limit=<chars>` (char mode) or `?tokens=<n>` (token mode, cl100k_base via `js-tiktoken/lite`). Slicing is heading-aware — start snaps forward to the next `##` heading (offset=0 preserved so preamble is kept). In char mode, end snaps to the *last* heading inside `(start, start+limit]`, overshooting to the next heading when a single section is bigger than `limit`. In token mode, we walk forward section-by-section and stop at the last heading that keeps the slice ≤ `tokens`, with the same overshoot rule. `tokens` takes precedence over `limit` when both are passed. Recommended brackets: 2000/5000/10000/20000 tokens. The response always includes `offset`, `limit`, `nextOffset`, `totalChars`, `totalTokens`; token-mode responses also include `tokens` (requested budget) and `sliceTokens` (actual encoded count). `totalTokens` is cached in the `source_changelog_files.tokens` column on upsert — the route falls back to a size-capped live encode for rows that predate the column (the cap lives in `@releases/core/tokens#countTokensSafe` (source at `packages/core/src/tokens.ts`, private to this monorepo), currently 256KB → chars/4 fallback above that to bound request latency). **Consequence:** files over 256KB carry an approximated `totalTokens` (not an exact cl100k_base count); `sliceTokens` stays exact because slicer chunks always fit under the cap. Chain successive calls via `nextOffset` to reconstruct the file exactly. With no range params the full file is returned (back-compat). Shared slicer + response builder: `@buildinternet/releases-core/changelog-slice#sliceChangelog`/`#buildChangelogResponse` (source at `packages/core/src/changelog-slice.ts`) — used by both `workers/api/src/routes/sources.ts` and `src/api/routes/sources.ts`. Exposed over MCP as the `get_source_changelog` tool (both `workers/mcp/src/tools.ts` and `src/mcp/server.ts`) and over the CLI as `releases admin source changelog <slug> [--offset N] [--limit N | --tokens N] [--json]`. The web changelog tab fetches only the first 40k chars on tab nav and lazy-loads subsequent chunks via `web/src/components/changelog-stream.tsx`.
- Feed change detection: `releases admin source poll` uses HTTP HEAD requests to flag sources with upstream changes (`changeDetectedAt` column). `releases admin source fetch` uses HEAD as a pre-filter to skip unchanged feeds. Both are purely mechanical — no AI or content parsing involved. The API Worker runs an hourly cron that polls feed sources on tier-based intervals (`fetchPriority`: normal=4h, low=24h, paused=never) and directly fetches changed sources that have a usable feed path — `feed`, `github`, and `scrape` sources whose `metadata.feedUrl` was auto-discovered on first add. Agent sources and scrape sources without a feed are flagged (`changeDetectedAt`) for processing by managed agent sessions or CLI `releases admin source fetch --changed`. A second daily cron at 03:00 UTC (`workers/api/src/cron/retier.ts`) recomputes `fetchPriority` from the median `publishedAt` gap in the last 180 days: ≤14d → normal, 14-90d → low, >90d preserves the current tier. Never auto-pauses (manual vs automatic overrides aren't tracked yet), never touches sources that are already `paused`, and skips tier changes for sources with <3 releases of signal. The retier persists its signal on every source it evaluates via `sources.medianGapDays` (REAL; null when <3 releases of signal) and `sources.lastRetieredAt` (ISO timestamp); the API returns both on `GET /v1/sources`, and the dev-gated status dashboard (`web/src/app/status/`) renders them as a Cadence column that flags mismatches between cadence and tier (e.g. a paused source still shipping on a 5-day median). The `lastPolledAt` column tracks when each source was last polled by the cron.
- Entity resolution prefers IDs over slugs. All lookups (CLI args, API paths, agent tools) accept either an ID (`org_...`, `src_...`, `prod_...`) or a slug. IDs are immutable and globally unique; prefer them when available.
- Media pipeline: extracted media URLs go through `filterJunkMedia()` in `src/lib/media.ts` (drops tracking pixels, favicons, and AI-classified chrome), then `processMediaForR2()` downloads and uploads survivors to R2. `normalizeMediaUrl()` unwraps Next.js/Vercel image optimizer URLs (`/_next/image?url=...`, including Next `basePath` variants) to the underlying CDN asset before upload — those proxy endpoints 404 for off-origin fetchers. The web renders `r2Url ?? url`, and `FallbackImage` / `FallbackPlainImage` in `web/src/components/fallback-image.tsx` show an "Image unavailable" placeholder on load error.
- Remote mode fetch requires a filter (`--stale`, `--unfetched`, `--changed`, `--retry-errors`, or a source slug). Bare `releases admin source fetch` is blocked in remote mode to prevent expensive bulk operations. Remote concurrency defaults to 3, capped at 5.
- Open Graph images use Next.js's `opengraph-image.tsx` file convention (one per route segment, cascading). Shared template + helpers live in `web/src/lib/og.tsx` (renders via `next/og`'s `ImageResponse`) with pure helpers carved into `web/src/lib/og-helpers.ts` so they're unit-testable without the Next runtime. `renderOgImage` picks the bleed variant (blurred hero + dark overlay) when `heroImage` is a non-null data URI, else the text-only card; `renderOgImageSplit` is exported but currently unused (kept as a ready template for future variants). `resolveHeroImage` fetches candidate media, rejects tiny thumbnails via URL markers + content-type/size bounds (`isJunkMediaUrl` + `isHeroImageResponse`), and returns a base64 data URI. `resolveAvatarUrl` prefers `org.avatarUrl` and falls back to `github.com/{handle}.png` (redirect resolved server-side for Satori). Dynamic routes carry `revalidate = 86400` so first-render cost amortizes across 24h of CDN hits; static routes (`/`, `/docs/*`) render at build. Tests in `tests/unit/og-helpers.test.ts`.

## Common CLI Patterns

```bash
releases show <id|slug>         # Inspect any entity by ID (rel_/src_/org_/prod_) or slug
releases list <slug> --json     # Inspect a single source
releases list --json --compact  # Lightweight JSON (id, slug, name, type, org, date)
releases list --json --limit 20 --page 2  # Paginated JSON output
releases list --query <text>    # Filter sources by name, slug, or URL
releases list --has-feed        # Sources with a discovered feed URL
releases list --product nextjs  # Filter sources by product
releases admin source list      # Alias for "releases list" (within admin source)
releases admin source edit <identifier> --name "New Name"  # Edit by ID (src_...) or slug
releases admin source edit <slug> --slug new-slug --confirm-slug-change  # Rename slug (breaks web links)
releases admin source fetch <slug> --max 5   # Fetch limited releases for one source
releases admin source fetch --changed        # Fetch only sources where poll detected changes
releases admin source fetch-log <slug>       # Check recent fetch history for a source
releases admin discovery task list           # List active/recent remote sessions
releases admin discovery task cancel <id>    # Cancel a running remote session
releases admin product list vercel           # List products for an org
releases admin product adopt nextjs --into vercel  # Convert org to product
releases categories             # List valid categories
releases admin org add "Acme" --category cloud --tags typescript,edge
releases admin org edit acme --category developer-tools
releases admin org show acme              # Full details: accounts, tags, sources, products
releases admin org tag add acme react serverless
releases admin org tag list acme
releases admin product add "CLI" --org acme --category developer-tools --tags golang
releases admin product tag add acme-cli testing
releases list --category ai     # Filter sources by category
releases admin source poll                   # Check all feed sources for upstream changes
releases admin source poll --changed         # Show only sources with detected changes
releases admin source poll --json            # Machine-readable output
```

- Commands accept entity IDs (`org_...`, `src_...`, `prod_...`, `rel_...`) or slugs. IDs are preferred for durability — slugs can change, IDs cannot. The top-level `show <id|slug>` command dispatches to the right entity based on the ID prefix, and falls back to a slug lookup (org → product → source) for bare strings.
- The `edit` command accepts IDs or slugs as the first argument. Slug renames (`--slug`) require `--confirm-slug-change` because they break web links.
- `releases list` is aliased as `releases admin source list` for discoverability within the admin source workflow.
- Source slug is always a **positional argument** (e.g., `admin source fetch claude-code`), not a flag. The fetch command also accepts `--source <slug>` as an alias for convenience.
- `releases admin org list` returns a summary view (counts, last activity) without accounts or tags. Use `releases admin org show <slug>` to see full details including linked platform accounts, tags, sources, and products.

## CLI Distribution

The CLI is published from the public OSS repo at [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli) — not from this monorepo. That repo owns `@buildinternet/releases{,-darwin-*,-linux-*}` on npm, the GitHub Release binaries, and the Homebrew tap (`buildinternet/homebrew-tap`).

This monorepo consumes the published packages (`@buildinternet/releases-core`, `-lib`, `-skills`) like any other npm dependency. It does not carry `npm/*` scaffolds, Changesets config, or a `Release CLI` workflow anymore — if you see those in an old PR, don't restore them.

**If a CLI change needs to ship:** land it in `buildinternet/releases-cli`, run `bun run changeset` there, and merge. The OSS repo's own workflow handles the version PR + publish. Shared code used by workers (e.g. `packages/core`, `packages/lib`) can still be edited here, but the published copies live in the OSS repo — monorepo edits to those packages are dev-only until mirrored.

## Remote Mode (D1)

When `RELEASED_API_URL` is set, the CLI routes data operations through the API Worker instead of local SQLite. The switch point is `src/lib/mode.ts` — `isRemoteMode()` checks the env var once and caches the result. Compiled binaries auto-detect remote mode and default to `https://api.releases.sh` when `RELEASED_API_URL` is unset. Query functions in `src/db/queries.ts` delegate to `src/api/client.ts` in remote mode. All CLI commands support both modes — no command calls `getDb()` directly (except `search` for local FTS).

**Local mode** (default for `bun src/index.ts`): No config needed. Uses `bun:sqlite` at `~/.releases/releases.db`.

**Remote mode** (default for compiled binary): Set `RELEASED_API_URL` and `RELEASED_API_KEY` for admin access. Public read-only access works without any env vars — the compiled binary defaults to `https://api.releases.sh`.

**API auth model**: GET endpoints are public (no auth required). Write operations (POST/PATCH/DELETE) require a Bearer token. The `publicReadAuthMiddleware` in `workers/api/src/middleware/auth.ts` handles this split. Admin-only routes (sessions, fetch-log, usage-log, discover, blocked-urls, aliases) require auth for all methods.

**Rate limiting**: Unauthenticated public reads can be throttled per-IP via `publicRateLimitMiddleware` (`workers/api/src/middleware/rate-limit.ts`). It's a Cloudflare Workers Rate Limiting binding (`PUBLIC_RATE_LIMITER`) gated by the `RATE_LIMIT_ENABLED` var — off by default so initial deploys change nothing. Flip the var to `"true"` in `workers/api/wrangler.jsonc` and redeploy to activate. Authenticated callers (valid Bearer token) bypass entirely, so the CLI and MCP server in remote mode are never throttled. Limit values live on the binding in `wrangler.jsonc` — keep them out of user-facing docs. State is per-colo (CF constraint), not global. Wired only onto the public-read route group in `workers/api/src/index.ts`; admin routes are already key-gated.

The API Worker lives at `workers/api/` and shares the Drizzle schema from `@buildinternet/releases-core/schema` (`packages/core/src/schema.ts`). D1 migrations are in `workers/api/migrations/`. Deploy with `cd workers/api && wrangler deploy`.

**Migration filename convention:** New migrations use a timestamp prefix (`YYYYMMDDHHMMSS_slug.sql`) to prevent filename collisions when two branches generate migrations concurrently. This applies to both Drizzle migrations under `src/db/migrations/` (driven by `migrations.prefix: "timestamp"` in `drizzle.config.ts`) and hand-written D1 migrations under `workers/api/migrations/`. Existing numeric files (`0000..0008` Drizzle, `0000..0011` D1) stay as-is — renaming them would break `__drizzle_migrations` / `d1_migrations` tracking state on already-migrated DBs. Drizzle tracks applied migrations by `folderMillis` (the journal's `when` field), not by filename, so the prefix is purely cosmetic; wrangler sorts D1 files alphabetically and `"0011"` sorts before `"20260413..."`, so mixed ordering works. When two branches still manage to touch the same underlying table, `meta/_journal.json` will conflict on append — resolve with a trivial merge.

CI enforces two guardrails on every PR: `scripts/check-migration-filenames.sh` rejects new migration files added with a legacy `NNNN_` prefix, and a drift check runs `bunx drizzle-kit generate` against a clean data dir and fails if any schema change is detected (catches "edited `schema.ts` but forgot to run `bun run db:generate`"). Run the filename check locally with `bun run db:check-filenames`.

Session management: `task list` shows active sessions, `task cancel <id>` requests cancellation. Sessions track active source slugs for duplicate detection — the CLI refuses to start a fetch if overlapping sources are already in-flight.

Cron polling: The API Worker runs an hourly `scheduled` handler that polls feed sources and fetches changed ones directly. Configure `GITHUB_TOKEN` as a Worker secret for GitHub source access. Tier intervals are controlled by `fetchPriority` on each source.

## Semantic search

Hybrid FTS5 + Cloudflare Vectorize search across three indexes, fused with Reciprocal Rank Fusion.

**Indexes** (all 512-dim cosine, bound on both the API and MCP workers):
- `releases-v1` — one vector per release (title + content), used by `search_releases`
- `entities-v1` — one vector per org/product/source (name + description + category + domain), used by `search_registry`
- `changelog-chunks-v1` — heading-aware ~500-token chunks of stored CHANGELOG.md files, interleaved with release hits in `search_releases` results

**Provisioning:** run `./scripts/create-vectorize-indexes.sh` once per account (idempotent). The default provider is Voyage `voyage-4-lite`, which defaults to 1024-dim vectors but supports Matryoshka-style `output_dimension` — `src/lib/embeddings.ts` requests 512 explicitly so the vectors match the Vectorize indexes. `VOYAGE_API_KEY` lives in Cloudflare's Secrets Store and is bound to both workers under `secrets_store_secrets` in `workers/{api,mcp}/wrangler.jsonc`; to rotate, update the value in the dashboard and redeploy. To switch providers, change `EMBEDDING_PROVIDER` in both `wrangler.jsonc` files (`voyage` | `openai` | `workers-ai`) and recreate the indexes if vector dimensionality differs.

**Ingest is automatic on writes** and never blocks them. The release batch insert, org/product/source POST/PATCH paths, and `refreshChangelogFile` all wrap embedding generation in `waitUntil` + try/catch — missing bindings, missing API key, or a provider error fall through silently and the row stays with `embedded_at = NULL` for backfill to pick up later. Entity PATCH is gated on the embed-relevant fields actually changing so poll-driven metadata bumps don't re-embed.

**Backfill + debugging:** `releases admin embed status` is the first stop — it reports per-table embedded vs unembedded counts via `GET /v1/admin/embed/status`. Run `releases admin embed releases|entities|changelogs` to backfill in 50-row batches against the matching `POST /v1/admin/embed/*` admin route. All embed routes are gated by `authMiddleware`.

**Search modes:** `search_releases` (MCP + `GET /v1/search`) accepts `mode: "lexical"|"semantic"|"hybrid"` and defaults to `hybrid`. Every hit carries a `kind: "release"|"changelog_chunk"` discriminator — chunk hits include `sourceSlug`, `chunkOffset`, and `chunkLength` so agents can chain into `get_source_changelog({ slug, offset, limit })` to read surrounding context. Pass `mode: "lexical"` for back-compat with the old shape. The hybrid path degrades to lexical with `degraded: true` + `degradedReason` set if Vectorize bindings or the embedding API are unavailable. New tool: `search_registry` for vector-backed org/product/source lookup.

**Related entities:** `GET /v1/related/releases?release=<id>&scope=org|global` and `GET /v1/related/sources?source=<slug|id>&scope=org|global` return semantically similar items for an anchor. Both routes pull the anchor's existing Vectorize vector via `getByIds` (no re-embedding), filter by `org_id` metadata when `scope=org`, exclude the anchor, and degrade to an empty list with `degraded: true` when bindings are missing. `org_id` is written into Vectorize metadata by `src/lib/embed-releases.ts` and `src/lib/embed-entities.ts` on every upsert, so a `releases admin embed releases/entities` backfill is required after deploying the first time (vectors predating the metadata addition silently drop out of `scope=org` results until re-embedded). The web source detail page renders four stacked rails backed by these routes (org releases, global releases, org sources, global sources) via `web/src/components/related-{releases,sources}.tsx`. Each rail is wrapped in Suspense with `fallback={null}` and hides itself on empty/degraded responses. Route file: `workers/api/src/routes/related.ts`. The `scope=org` metadata indexes are provisioned by `scripts/create-vectorize-indexes.sh` (idempotent) — run it before deploying the API worker.

Shared RRF + provider abstraction: `src/lib/vector-search.ts`, `src/lib/embeddings.ts`. Worker hybrid orchestrators: `workers/api/src/lib/search-hybrid.ts`, `workers/mcp/src/lib/search-hybrid.ts`. Ingest helpers: `src/lib/embed-releases.ts`, `src/lib/embed-entities.ts`, `src/lib/embed-changelog-pipeline.ts`. Backfill CLI: `src/cli/commands/admin/embed.ts`. Admin routes: `workers/api/src/routes/admin-embed.ts`.

Discovery guardrails: The discovery worker checks `GET /api/sessions?status=running&type=onboard` before spawning a new session. Returns 409 if the same company (case-insensitive) is already being discovered, 429 if 5+ onboard sessions are running. Uses a service binding (`API_WORKER`) for Worker-to-Worker communication. The `GET /sessions` endpoint supports `?status=` and `?type=` query param filtering.

## Remote MCP Server

The MCP Worker (`workers/mcp/`) exposes a remote MCP server at `mcp.releases.sh` using Cloudflare's `createMcpHandler` with Streamable HTTP transport. It provides read-only tools across three surfaces — search (`search_releases`, `get_latest_releases`, `get_release`), registry detail (`list_sources`, `get_source`, `get_source_changelog`, `list_organizations`, `get_organization`, `list_products`, `get_product`), and AI analysis (`summarize_changes`, `compare_products`, gated behind `ENABLE_AI_TOOLS=true`). No authentication required — all read tools are public.

The worker binds to the same D1 database as the API and discovery workers. AI tools (`summarize_changes`, `compare_products`) use an `ANTHROPIC_API_KEY` from the secrets store. Like the discovery worker, `workers/mcp/` is excluded from root `workspaces` to avoid import conflicts.

Deploy: `bun run deploy:mcp`. Dev: `bun run dev:mcp`. Connect from Claude Desktop: `npx mcp-remote https://mcp.releases.sh/mcp`.

**MCP Registry listing:** The server is registered as `sh.releases/mcp` in the official MCP Registry via HTTP-domain auth against `releases.sh` (proof file lives at `web/public/.well-known/mcp-registry-auth`). Metadata is in `workers/mcp/server.json` — bump `version` when you want to publish an update. The `Deploy Workers` GitHub Action runs `mcp-publisher publish` automatically on merges that touch `server.json` (gated on the `MCP_REGISTRY_PRIVATE_KEY_PEM` repo secret). Manual publish: `bun run publish:mcp-registry` after `mcp-publisher login http --domain releases.sh --private-key <hex>`.

## Agent Architecture

Two Anthropic managed agents handle changelog work, sharing the same tools (`AGENT_TOOLS`) and skills:

- **Discovery agent** (`claude-sonnet-4-6`) — Onboarding, evaluation, and judgment-heavy tasks. System prompt: `src/shared/discovery-prompt.ts`.
- **Worker agent** (`claude-haiku-4-5`) — Fetches, updates, and mechanical operations at ~3x lower cost. System prompt: `src/shared/worker-prompt.ts`. The discovery worker DO routes `mode: "update"` sessions to this agent via `ANTHROPIC_WORKER_AGENT_ID`.

Both agents are deployed via `bun run deploy:agents`. Use `deploy:agents:discovery` or `deploy:agents:worker` to target one. Agent IDs and config state live in `scripts/agent-skills.json`.

The local-only unified agent (`src/agent/releases.ts`) handles all judgment-based changelog work when not using managed agents.

- **Agent skills** are sourced from `@buildinternet/releases-skills` (published OSS). At runtime, `resolveSkillsDir()` finds skills via: `RELEASED_SKILLS_DIR` env var (highest priority) → `skillsDir()` from the npm package (bundled `skills/` directory) → `src/agent/skills/` source tree fallback (for `bun src/index.ts` in the monorepo when the package isn't installed). The agent symlinks the resolved directory to `.claude/skills/` for SDK discovery. Each skill is a `SKILL.md` with YAML frontmatter. To add or edit skills, update the OSS repo and publish a new `@buildinternet/releases-skills` version.
- **Deterministic pipeline** (ingest, incremental, summarize) stays as direct Messages API calls — not routed through the agent.
- **`evaluate` CLI command** runs pre-checks only (provider detection, feed discovery). The agent handles deeper evaluation when needed.

## Claude Code Plugin

A Claude Code plugin at `plugins/claude/releases/` exposes the registry for use in Claude Code sessions. It connects to the remote MCP server at `mcp.releases.sh` and adapts the managed agent prompts for CLI-based operation.

**Components:** `.mcp.json` (MCP connection), 2 agents (discovery/worker), 1 command (`/releases`), 6 skills (1 consumer + 5 synced from `src/agent/skills/`).

**Test locally:** `claude --plugin-dir plugins/claude/releases`

**Validate:** `claude plugin validate plugins/claude/releases`

**Skill sync:** Skills are published to npm as `@buildinternet/releases-skills` via the OSS repo. The plugin directory carries committed copies of the skills — update them by editing `src/agent/skills/` in the OSS repo and bumping the package version. `bun run deploy:skills` pushes skill updates to the Anthropic managed-agents API; `scripts/sync-plugin-skills.ts` has been removed — the plugin copies must now be updated manually when OSS skill content changes.

## Environment

Do not edit `.env` directly. Required vars documented in `.env.example`.
