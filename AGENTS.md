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
bun src/index.ts <command>    # run directly during development
```

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
- Dedup via `UNIQUE(source_id, url)` and `UNIQUE(source_id, content_hash)` with `onConflictDoNothing()`.
- `releases import <file>` bulk-imports orgs and sources from a JSON manifest. Used as the discovery agent handoff point. Supports `--dry-run`, `--json`, `--skip-existing`.
- Smart fetch: `fetch --stale <hours>` respects backoff (`nextFetchAfter`) and `fetchPriority`. `fetch --changed` targets sources where `poll` detected upstream changes (`changeDetectedAt IS NOT NULL`). `fetch --retry-errors` retries sources whose last fetch failed. Backoff counters (`consecutiveNoChange`, `consecutiveErrors`) on the `sources` table drive exponential backoff (no_change: 1h–48h, errors: 1h–72h). Default max of 200 releases per source prevents API pagination limits (e.g., GitHub's 10K cap). Use `--max <n>` to adjust or `--all` to remove the cap.
- Categories are validated against `CATEGORIES` in `src/lib/categories.ts`. Adding a new category requires a code change. Tags are freeform — get-or-create semantics via `tags` table. Tag join tables use separate `org_tags` and `product_tags` with proper FK cascades (not polymorphic).
- Domain aliases (`domain_aliases` table) map alternate domains to orgs or products for searchability and dedup. An alias domain is globally unique — only one org or product can claim it. CLI: `org alias add/remove/list`, `product alias add/remove/list`. Aliases are checked by `findOrg()` and `findProduct()` as a final fallback step, and matched in search queries via LEFT JOIN.
- Products are an **optional** grouping layer between organizations and sources. Multi-product orgs (e.g., Vercel → Next.js, Turborepo) use products to group their sources. Sources have a nullable `productId` — simple orgs skip this layer. CLI: `product list/add/edit/remove/adopt`. The `product adopt` command converts an org that should be a product into a product under another org, moving sources and accounts. Products have an optional canonical `url` field.
- Ignored URLs are **org-scoped** — a URL ignored for one org can still be valid for another. The `ignored_urls` table requires `orgId`. CLI: `ignore list/add/remove --org <org>`. Blocked URLs (`blocked_urls` table) are **global** — for spam domains and known-bad URLs. CLI: `block list/add/remove`. Both lists are checked by `isUrlExcluded()` before adding sources.
- Release suppression: individual releases can be suppressed (`release suppress <id> --reason "..."`) to hide them from queries and search without deleting. Suppressed releases are filtered out of all read paths (search, latest, stats, API). Use `release unsuppress <id>` to restore.
- Feed change detection: `releases poll` uses HTTP HEAD requests to flag sources with upstream changes (`changeDetectedAt` column). The `fetch` command uses HEAD as a pre-filter to skip unchanged feeds. Both are purely mechanical — no AI or content parsing involved. The API Worker runs an hourly cron that polls feed sources on tier-based intervals (`fetchPriority`: normal=4h, low=24h, paused=never) and fetches changed feed/GitHub sources directly via D1. Scrape/agent sources are flagged for CLI pickup. The `lastPolledAt` column tracks when each source was last polled by the cron.
- Remote mode fetch requires a filter (`--stale`, `--unfetched`, `--changed`, `--retry-errors`, or a source slug). Bare `fetch` is blocked in remote mode to prevent expensive bulk operations. Remote concurrency defaults to 3, capped at 5.

## Common CLI Patterns

```bash
bun src/index.ts list <slug> --json     # Inspect a single source
bun src/index.ts list --query <text>    # Filter sources by name, slug, or URL
bun src/index.ts list --has-feed        # Sources with a discovered feed URL
bun src/index.ts list --enrichable      # Sources eligible for content enrichment
bun src/index.ts list --product nextjs  # Filter sources by product
bun src/index.ts fetch <slug> --max 5   # Fetch limited releases for one source
bun src/index.ts fetch --changed        # Fetch only sources where poll detected changes
bun src/index.ts fetch-log <slug>       # Check recent fetch history for a source
bun src/index.ts enrich <slug>          # Enrich sparse feed releases with full page content
bun src/index.ts enrich <slug> --force  # Bypass triage, re-enrich all (backfill media, re-apply parseInstructions)
bun src/index.ts task list              # List active/recent remote sessions
bun src/index.ts task cancel <id>       # Cancel a running remote session
bun src/index.ts product list vercel    # List products for an org
bun src/index.ts product adopt nextjs --into vercel  # Convert org to product
bun src/index.ts categories             # List valid categories
bun src/index.ts org add "Acme" --category cloud --tags typescript,edge
bun src/index.ts org edit acme --category developer-tools
bun src/index.ts org show acme              # Full details: accounts, tags, sources, products
bun src/index.ts org tag add acme react serverless
bun src/index.ts org tag list acme
bun src/index.ts product add "CLI" --org acme --category developer-tools --tags golang
bun src/index.ts product tag add acme-cli testing
bun src/index.ts list --category ai     # Filter sources by category
bun src/index.ts poll                   # Check all feed sources for upstream changes
bun src/index.ts poll --changed         # Show only sources with detected changes
bun src/index.ts poll --json            # Machine-readable output
```

- Source slug is always a **positional argument** (e.g., `fetch claude-code`), not a flag. The `fetch` command also accepts `--source <slug>` as an alias for convenience.
- `org list` returns a summary view (counts, last activity) without accounts or tags. Use `org show <slug>` to see full details including linked platform accounts, tags, sources, and products.

## npm Distribution

The CLI is published as `@buildinternet/releases` on npm with platform-specific binary packages (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`). Package scaffolding is in `npm/`, publish script at `scripts/publish-npm.sh`. Run `bun run publish:npm` for dry run, `bun run publish:npm --publish` to publish. Requires `NPM_PUBLISHING_TOKEN` in `.env`.

## Remote Mode (D1)

When `RELEASED_API_URL` is set, the CLI routes data operations through the API Worker instead of local SQLite. The switch point is `src/lib/mode.ts` — `isRemoteMode()` checks the env var once and caches the result. Compiled binaries auto-detect remote mode and default to `https://api.releases.sh` when `RELEASED_API_URL` is unset. Query functions in `src/db/queries.ts` delegate to `src/api/client.ts` in remote mode. All CLI commands support both modes — no command calls `getDb()` directly (except `search` for local FTS).

**Local mode** (default for `bun src/index.ts`): No config needed. Uses `bun:sqlite` at `~/.releases/releases.db`.

**Remote mode** (default for compiled binary): Set `RELEASED_API_URL` and `RELEASED_API_KEY` for admin access. Public read-only access works without any env vars — the compiled binary defaults to `https://api.releases.sh`.

**API auth model**: GET endpoints are public (no auth required). Write operations (POST/PATCH/DELETE) require a Bearer token. The `publicReadAuthMiddleware` in `workers/api/src/middleware/auth.ts` handles this split. Admin-only routes (sessions, fetch-log, usage-log, discover, blocked-urls, aliases) require auth for all methods.

The API Worker lives at `workers/api/` and shares the Drizzle schema from `src/db/schema.ts`. D1 migrations are in `workers/api/migrations/`. Deploy with `cd workers/api && wrangler deploy`.

Session management: `task list` shows active sessions, `task cancel <id>` requests cancellation. Sessions track active source slugs for duplicate detection — the CLI refuses to start a fetch if overlapping sources are already in-flight.

Cron polling: The API Worker runs an hourly `scheduled` handler that polls feed sources and fetches changed ones directly. Configure `GITHUB_TOKEN` as a Worker secret for GitHub source access. Tier intervals are controlled by `fetchPriority` on each source.

Discovery guardrails: The discovery worker checks `GET /api/sessions?status=running&type=onboard` before spawning a new session. Returns 409 if the same company (case-insensitive) is already being discovered, 429 if 5+ onboard sessions are running. Uses a service binding (`API_WORKER`) for Worker-to-Worker communication. The `GET /sessions` endpoint supports `?status=` and `?type=` query param filtering.

## Agent Architecture

The unified agent (`src/agent/releases.ts`) handles all judgment-based changelog work: finding sources, evaluating them, onboarding, and validation. It replaces the separate discovery and evaluation agents.

- **Agent skills** live in `src/agent/skills/` as application code (not in `.claude/`). Each skill is a `SKILL.md` with YAML frontmatter. At runtime, `resolveSkillsDir()` finds skills via: `RELEASED_SKILLS_DIR` env var → `/usr/share/releases/skills/` (container) → `~/.releases/skills/` (local) → source tree fallback. The agent symlinks the resolved directory to `.claude/skills/` for SDK discovery.
- **Deterministic pipeline** (ingest, incremental, enrich, summarize) stays as direct Messages API calls — not routed through the agent.
- **`evaluate` CLI command** runs pre-checks only (provider detection, feed discovery). The agent handles deeper evaluation when needed.

## Environment

Do not edit `.env` directly. Required vars documented in `.env.example`.
