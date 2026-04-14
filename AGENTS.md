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

**Workspaces:** Only `workers/api` is declared as a workspace in root `package.json`. The discovery worker (`workers/discovery/`) is intentionally excluded because Bun eagerly resolves imports across all workspace members at startup — the `cloudflare:workers` imports in the discovery worker's Durable Object files cause `bun src/index.ts` to fail even though the CLI never imports from that workspace. Wrangler manages the discovery worker's dependencies independently.

## Conventions

- All logging goes to **stderr** (`src/lib/logger.ts`). stdout is reserved for MCP JSON-RPC in serve mode.
- Source types: `github`, `scrape`, `feed`, and `agent`. The `scrape` adapter auto-discovers RSS/Atom/JSON feeds before falling back to Cloudflare + AI. The `feed` type is for sources where the feed URL is known or discoverable. Feed metadata (URL, type, ETag) is cached in `source.metadata`.
- Crawl mode (`--crawl`) uses Cloudflare's `/crawl` endpoint for multi-page changelogs. Persists in `source.metadata` as `crawlEnabled`. The crawl flow is synchronous (poll until done) — background mode is deferred. See `src/adapters/crawl.ts`.
- Shared DB query helpers live in `src/db/queries.ts` — use them instead of inlining drizzle queries.
- `toReleaseInput()` from `src/ai/query.ts` converts DB rows (nullable fields) to AI input shape — don't hand-roll this mapping.
- `daysAgoIso()` from `src/lib/dates.ts` for date cutoff calculations.
- CLI commands that return data support `--json` for machine-readable output.
- Batch DB inserts in chunks of 500 (SQLite variable limit).
- Dedup via `UNIQUE(source_id, url)` and the shared `RELEASE_URL_UPSERT` config in `src/db/release-upsert.ts` — on URL collision, content is backfilled when the incoming row is non-empty and the existing row is empty. Both the local (`src/db/queries.ts`) and worker (`workers/api/src/routes/sources.ts`) batch-insert paths import that helper so they can't drift.
- `releases admin source import <file>` bulk-imports orgs and sources from a JSON manifest. Used as the discovery agent handoff point. Supports `--dry-run`, `--json`, `--skip-existing`.
- Smart fetch: `releases admin source fetch --stale <hours>` respects backoff (`nextFetchAfter`) and `fetchPriority`. `releases admin source fetch --changed` targets sources where `releases admin source poll` detected upstream changes (`changeDetectedAt IS NOT NULL`). `releases admin source fetch --retry-errors` retries sources whose last fetch failed. Backoff counters (`consecutiveNoChange`, `consecutiveErrors`) on the `sources` table drive exponential backoff (no_change: 1h–48h, errors: 1h–72h). Default max of 200 releases per source prevents API pagination limits (e.g., GitHub's 10K cap). Use `--max <n>` to adjust or `--all` to remove the cap.
- Categories are validated against `CATEGORIES` in `src/lib/categories.ts`. Adding a new category requires a code change. Tags are freeform — get-or-create semantics via `tags` table. Tag join tables use separate `org_tags` and `product_tags` with proper FK cascades (not polymorphic).
- Domain aliases (`domain_aliases` table) map alternate domains to orgs or products for searchability and dedup. An alias domain is globally unique — only one org or product can claim it. CLI: `releases admin org alias add/remove/list`, `releases admin product alias add/remove/list`. Aliases are checked by `findOrg()` and `findProduct()` as a final fallback step, and matched in search queries via LEFT JOIN.
- Products are an **optional** grouping layer between organizations and sources. Multi-product orgs (e.g., Vercel → Next.js, Turborepo) use products to group their sources. Sources have a nullable `productId` — simple orgs skip this layer. CLI: `releases admin product list/add/edit/remove/adopt`. The `product adopt` command converts an org that should be a product into a product under another org, moving sources and accounts. Products have an optional canonical `url` field.
- Ignored URLs are **org-scoped** — a URL ignored for one org can still be valid for another. The `ignored_urls` table requires `orgId`. CLI: `releases admin policy ignore list/add/remove --org <org>`. Blocked URLs (`blocked_urls` table) are **global** — for spam domains and known-bad URLs. CLI: `releases admin policy block list/add/remove`. Both lists are checked by `isUrlExcluded()` before adding sources.
- Release suppression: individual releases can be suppressed (`releases admin release suppress <id> --reason "..."`) to hide them from queries and search without deleting. Suppressed releases are filtered out of all read paths (search, latest, stats, API). Use `releases admin release unsuppress <id>` to restore.
- Release type: each release carries a `type` column — `feature` (default, incremental change or single version) or `rollup` (seasonal/quarterly catch-all page that spans many features, e.g. Brex Fall Release, Ramp quarterly blog). Classification is skill-driven by the parse agent via the `parsing-changelogs` skill; source-level cadence signals live in the playbook notes, not in source metadata. `RELEASE_TYPES` / `ReleaseType` are exported from `src/db/schema.ts` — import from there rather than inlining the string union. The `search_releases` and `get_latest_releases` MCP tools accept an optional `type` filter.
- GitHub CHANGELOG files: for `github` sources, the canonical `CHANGELOG.md` (or `CHANGES.md` / `HISTORY.md` / `RELEASES.md` / `NEWS.md`) is fetched alongside tagged releases and stored in the `source_changelog_files` table (single row per source in v1 — monorepo package CHANGELOGs are deferred to v2). The fetch uses one `GET /repos/{owner}/{repo}/contents/` root listing followed by one `raw.githubusercontent.com` request, caps content at 1MB, and refresh piggybacks on every GitHub fetch — the upsert short-circuits on `contentHash` so unchanged files only touch `fetchedAt`. Refresh runs in `src/cli/commands/fetch.ts` (local mode) and `workers/api/src/cron/poll-fetch.ts#refreshChangelogFile` (remote mode). Shared filename list + source of truth: `src/adapters/github.ts#fetchChangelogFile`. The web surfaces the file in a "Changelog" tab on the source detail page via `GET /v1/sources/:slug/changelog`. Manual refresh: `releases admin source refresh-changelog <slug>` (local mode only).
- Changelog range API (Context7-style slicing): `GET /v1/sources/:slug/changelog` accepts `?offset=<chars>&limit=<chars>`. Slicing is heading-aware — start snaps forward to the next `##` heading (offset=0 preserved so preamble is kept), end snaps to the *last* heading inside `(start, start+limit]`, overshooting to the next heading when a single section is bigger than `limit`. The response includes `offset`, `limit`, `nextOffset`, and `totalChars`; chain successive calls via `nextOffset` to reconstruct the file exactly. With no range params the full file is returned (back-compat). Shared slicer + response builder: `src/lib/changelog-slice.ts#sliceChangelog`/`#buildChangelogResponse` — used by both `workers/api/src/routes/sources.ts` and `src/api/routes/sources.ts`. Exposed over MCP as the `get_source_changelog` tool (both `workers/mcp/src/tools.ts` and `src/mcp/server.ts`) and over the CLI as `releases admin source changelog <slug> [--offset N] [--limit N] [--json]`. The web changelog tab fetches only the first 40k chars on tab nav and lazy-loads subsequent chunks via `web/src/components/changelog-stream.tsx`.
- Feed change detection: `releases admin source poll` uses HTTP HEAD requests to flag sources with upstream changes (`changeDetectedAt` column). `releases admin source fetch` uses HEAD as a pre-filter to skip unchanged feeds. Both are purely mechanical — no AI or content parsing involved. The API Worker runs an hourly cron that polls feed sources on tier-based intervals (`fetchPriority`: normal=4h, low=24h, paused=never) and fetches changed feed/GitHub sources directly via D1. Scrape/agent sources are flagged (`changeDetectedAt`) for processing by managed agent sessions or CLI `releases admin source fetch --changed`. The `lastPolledAt` column tracks when each source was last polled by the cron.
- Entity resolution prefers IDs over slugs. All lookups (CLI args, API paths, agent tools) accept either an ID (`org_...`, `src_...`, `prod_...`) or a slug. IDs are immutable and globally unique; prefer them when available.
- Media pipeline: extracted media URLs go through `filterJunkMedia()` in `src/lib/media.ts` (drops tracking pixels, favicons, and AI-classified chrome), then `processMediaForR2()` downloads and uploads survivors to R2. `normalizeMediaUrl()` unwraps Next.js/Vercel image optimizer URLs (`/_next/image?url=...`, including Next `basePath` variants) to the underlying CDN asset before upload — those proxy endpoints 404 for off-origin fetchers. The web renders `r2Url ?? url`, and `FallbackImage` / `FallbackPlainImage` in `web/src/components/fallback-image.tsx` show an "Image unavailable" placeholder on load error.
- Remote mode fetch requires a filter (`--stale`, `--unfetched`, `--changed`, `--retry-errors`, or a source slug). Bare `releases admin source fetch` is blocked in remote mode to prevent expensive bulk operations. Remote concurrency defaults to 3, capped at 5.

## Common CLI Patterns

```bash
releases show <id|slug>         # Inspect any entity by ID (rel_/src_/org_/prod_) or slug
releases list <slug> --json     # Inspect a single source
releases list --query <text>    # Filter sources by name, slug, or URL
releases list --has-feed        # Sources with a discovered feed URL
releases list --product nextjs  # Filter sources by product
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
- Source slug is always a **positional argument** (e.g., `admin source fetch claude-code`), not a flag. The fetch command also accepts `--source <slug>` as an alias for convenience.
- `releases admin org list` returns a summary view (counts, last activity) without accounts or tags. Use `releases admin org show <slug>` to see full details including linked platform accounts, tags, sources, and products.

## npm Distribution

The CLI is published as `@buildinternet/releases` on npm with platform-specific binary packages (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`). Package scaffolding is in `npm/`, and all five packages are bun workspaces so Changesets can see them.

**Release flow (Changesets):**

1. **In your PR**: run `bun run changeset` and pick a bump (`patch`/`minor`/`major`) + short summary. This writes a `.changeset/*.md` file that you commit with the PR. The five `@buildinternet/releases*` packages are in a `fixed` group so they always bump together (`.changeset/config.json`).
2. **On merge to main**: the `Release CLI` workflow (`.github/workflows/release.yml`) runs `changesets/action@v1`. If there are pending changesets, it opens (or updates) a `chore: version packages` PR that runs `bun run changeset:version` — that calls `changeset version` to bump `npm/*/package.json` + write `CHANGELOG.md`, then `scripts/sync-version.ts` mirrors the new version back to root `package.json`, `src/cli/program.ts`, `src/mcp/server.ts`, and `homebrew/releases.rb`, then `bun install` refreshes the lockfile.
3. **Merging the version PR** triggers the workflow again, changesets/action detects there are no pending changesets and runs `bun run changeset:publish` to publish all five packages to npm. Subsequent steps gzip the binaries, update the Homebrew formula with new SHAs, and cut a GitHub release tagged `cli@x.y.z`.

Root `package.json` is `private: true` so it's excluded from changesets — the source of truth for version is `npm/releases/package.json`, and `sync-version.ts` keeps everything else in step. Never hand-edit versions in `src/cli/program.ts`, `src/mcp/server.ts`, or root `package.json` — run `bun run changeset` instead. `NPM_PUBLISHING_TOKEN` is a repo secret used by the workflow (granular token with "Bypass 2FA" — npm still demands OTP for passkey accounts otherwise).

## Remote Mode (D1)

When `RELEASED_API_URL` is set, the CLI routes data operations through the API Worker instead of local SQLite. The switch point is `src/lib/mode.ts` — `isRemoteMode()` checks the env var once and caches the result. Compiled binaries auto-detect remote mode and default to `https://api.releases.sh` when `RELEASED_API_URL` is unset. Query functions in `src/db/queries.ts` delegate to `src/api/client.ts` in remote mode. All CLI commands support both modes — no command calls `getDb()` directly (except `search` for local FTS).

**Local mode** (default for `bun src/index.ts`): No config needed. Uses `bun:sqlite` at `~/.releases/releases.db`.

**Remote mode** (default for compiled binary): Set `RELEASED_API_URL` and `RELEASED_API_KEY` for admin access. Public read-only access works without any env vars — the compiled binary defaults to `https://api.releases.sh`.

**API auth model**: GET endpoints are public (no auth required). Write operations (POST/PATCH/DELETE) require a Bearer token. The `publicReadAuthMiddleware` in `workers/api/src/middleware/auth.ts` handles this split. Admin-only routes (sessions, fetch-log, usage-log, discover, blocked-urls, aliases) require auth for all methods.

The API Worker lives at `workers/api/` and shares the Drizzle schema from `src/db/schema.ts`. D1 migrations are in `workers/api/migrations/`. Deploy with `cd workers/api && wrangler deploy`.

**Migration filename convention:** New migrations use a timestamp prefix (`YYYYMMDDHHMMSS_slug.sql`) to prevent filename collisions when two branches generate migrations concurrently. This applies to both Drizzle migrations under `src/db/migrations/` (driven by `migrations.prefix: "timestamp"` in `drizzle.config.ts`) and hand-written D1 migrations under `workers/api/migrations/`. Existing numeric files (`0000..0008` Drizzle, `0000..0011` D1) stay as-is — renaming them would break `__drizzle_migrations` / `d1_migrations` tracking state on already-migrated DBs. Drizzle tracks applied migrations by `folderMillis` (the journal's `when` field), not by filename, so the prefix is purely cosmetic; wrangler sorts D1 files alphabetically and `"0011"` sorts before `"20260413..."`, so mixed ordering works. When two branches still manage to touch the same underlying table, `meta/_journal.json` will conflict on append — resolve with a trivial merge.

CI enforces two guardrails on every PR: `scripts/check-migration-filenames.sh` rejects new migration files added with a legacy `NNNN_` prefix, and a drift check runs `bunx drizzle-kit generate` against a clean data dir and fails if any schema change is detected (catches "edited `schema.ts` but forgot to run `bun run db:generate`"). Run the filename check locally with `bun run db:check-filenames`.

Session management: `task list` shows active sessions, `task cancel <id>` requests cancellation. Sessions track active source slugs for duplicate detection — the CLI refuses to start a fetch if overlapping sources are already in-flight.

Cron polling: The API Worker runs an hourly `scheduled` handler that polls feed sources and fetches changed ones directly. Configure `GITHUB_TOKEN` as a Worker secret for GitHub source access. Tier intervals are controlled by `fetchPriority` on each source.

Discovery guardrails: The discovery worker checks `GET /api/sessions?status=running&type=onboard` before spawning a new session. Returns 409 if the same company (case-insensitive) is already being discovered, 429 if 5+ onboard sessions are running. Uses a service binding (`API_WORKER`) for Worker-to-Worker communication. The `GET /sessions` endpoint supports `?status=` and `?type=` query param filtering.

## Remote MCP Server

The MCP Worker (`workers/mcp/`) exposes a remote MCP server at `mcp.releases.sh` using Cloudflare's `createMcpHandler` with Streamable HTTP transport. It provides read-only tools across three surfaces — search (`search_releases`, `get_latest_releases`, `get_release`), registry detail (`list_sources`, `get_source`, `get_source_changelog`, `list_organizations`, `get_organization`, `list_products`, `get_product`), and AI analysis (`summarize_changes`, `compare_products`, gated behind `ENABLE_AI_TOOLS=true`). No authentication required — all read tools are public.

The worker binds to the same D1 database as the API and discovery workers. AI tools (`summarize_changes`, `compare_products`) use an `ANTHROPIC_API_KEY` from the secrets store. Like the discovery worker, `workers/mcp/` is excluded from root `workspaces` to avoid import conflicts.

Deploy: `bun run deploy:mcp`. Dev: `bun run dev:mcp`. Connect from Claude Desktop: `npx mcp-remote https://mcp.releases.sh/mcp`.

## Agent Architecture

Two Anthropic managed agents handle changelog work, sharing the same tools (`AGENT_TOOLS`) and skills:

- **Discovery agent** (`claude-sonnet-4-6`) — Onboarding, evaluation, and judgment-heavy tasks. System prompt: `src/shared/discovery-prompt.ts`.
- **Worker agent** (`claude-haiku-4-5`) — Fetches, updates, and mechanical operations at ~3x lower cost. System prompt: `src/shared/worker-prompt.ts`. The discovery worker DO routes `mode: "update"` sessions to this agent via `ANTHROPIC_WORKER_AGENT_ID`.

Both agents are deployed via `bun run deploy:agents`. Use `deploy:agents:discovery` or `deploy:agents:worker` to target one. Agent IDs and config state live in `scripts/agent-skills.json`.

The local-only unified agent (`src/agent/releases.ts`) handles all judgment-based changelog work when not using managed agents.

- **Agent skills** live in `src/agent/skills/` as application code (not in `.claude/`). Each skill is a `SKILL.md` with YAML frontmatter. At runtime, `resolveSkillsDir()` finds skills via: `RELEASED_SKILLS_DIR` env var → `/usr/share/releases/skills/` (container) → `~/.releases/skills/` (local) → source tree fallback. The agent symlinks the resolved directory to `.claude/skills/` for SDK discovery. Skills are also synced to the Claude Code plugin (`plugins/claude/releases/skills/`) via `bun run sync:plugin-skills` — this runs automatically as part of `deploy:skills`. Synced copies have an auto-generated comment; edit the source in `src/agent/skills/`, not the plugin copies.
- **Deterministic pipeline** (ingest, incremental, summarize) stays as direct Messages API calls — not routed through the agent.
- **`evaluate` CLI command** runs pre-checks only (provider detection, feed discovery). The agent handles deeper evaluation when needed.

## Claude Code Plugin

A Claude Code plugin at `plugins/claude/releases/` exposes the registry for use in Claude Code sessions. It connects to the remote MCP server at `mcp.releases.sh` and adapts the managed agent prompts for CLI-based operation.

**Components:** `.mcp.json` (MCP connection), 2 agents (discovery/worker), 1 command (`/releases`), 6 skills (1 consumer + 5 synced from `src/agent/skills/`).

**Test locally:** `claude --plugin-dir plugins/claude/releases`

**Validate:** `claude plugin validate plugins/claude/releases`

**Skill sync:** Operational skills are copied from `src/agent/skills/` into the plugin by `scripts/sync-plugin-skills.ts`. This runs as part of `bun run deploy:skills`. The plugin directory is self-contained and committable — synced files include an auto-generated comment warning against direct edits.

## Environment

Do not edit `.env` directly. Required vars documented in `.env.example`.
