# Released

Changelog indexer for AI agents and developers. Context7-style tool for release notes.

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
- `released import <file>` bulk-imports orgs and sources from a JSON manifest. Used as the discovery agent handoff point. Supports `--dry-run`, `--json`, `--skip-existing`.
- Smart fetch: `fetch --stale <hours>` respects backoff (`nextFetchAfter`) and `fetchPriority`. `fetch --retry-errors` retries sources whose last fetch failed. Backoff counters (`consecutiveNoChange`, `consecutiveErrors`) on the `sources` table drive exponential backoff (no_change: 1h–48h, errors: 1h–72h). Default max of 200 releases per source prevents API pagination limits (e.g., GitHub's 10K cap). Use `--max <n>` to adjust or `--all` to remove the cap.
- Ignored URLs are **org-scoped** — a URL ignored for one org can still be valid for another. The `ignored_urls` table requires `orgId`. CLI: `ignore list/add/remove --org <org>`. Blocked URLs (`blocked_urls` table) are **global** — for spam domains and known-bad URLs. CLI: `block list/add/remove`. Both lists are checked by `isUrlExcluded()` before adding sources.
- Release suppression: individual releases can be suppressed (`release suppress <id> --reason "..."`) to hide them from queries and search without deleting. Suppressed releases are filtered out of all read paths (search, latest, stats, API). Use `release unsuppress <id>` to restore.

## Common CLI Patterns

```bash
bun src/index.ts list <slug> --json     # Inspect a single source
bun src/index.ts fetch <slug> --max 5   # Fetch limited releases for one source
bun src/index.ts fetch-log <slug>       # Check recent fetch history for a source
```

- Source slug is always a **positional argument** (e.g., `fetch claude-code`), not a flag. The `fetch` command also accepts `--source <slug>` as an alias for convenience.

## Remote Mode (D1)

When `RELEASED_API_URL` is set, the CLI routes data operations through the API Worker instead of local SQLite. `RELEASED_API_KEY` is required alongside it. The switch point is `src/lib/mode.ts` — `isRemoteMode()` checks the env var once and caches the result. Query functions in `src/db/queries.ts` delegate to `src/api/client.ts` in remote mode. All CLI commands support both modes — no command calls `getDb()` directly (except `search` for local FTS).

**Local mode** (default): No config needed. Uses `bun:sqlite` at `~/.released/released.db`.

**Remote mode**: Set `RELEASED_API_URL` and `RELEASED_API_KEY`. All data operations go through the Cloudflare Worker API backed by D1.

The API Worker lives at `workers/api/` and shares the Drizzle schema from `src/db/schema.ts`. D1 migrations are in `workers/api/migrations/`. Deploy with `cd workers/api && wrangler deploy`.

## Agent Architecture

The unified agent (`src/agent/released.ts`) handles all judgment-based changelog work: finding sources, evaluating them, onboarding, and validation. It replaces the separate discovery and evaluation agents.

- **Agent skills** live in `src/agent/skills/` as application code (not in `.claude/`). Each skill is a `SKILL.md` with YAML frontmatter. The agent symlinks them to `.claude/skills/` at runtime so the Agent SDK discovers them via `settingSources: ["project"]`. In the sandbox container, the Dockerfile copies them into place.
- **Deterministic pipeline** (ingest, incremental, enrich, summarize) stays as direct Messages API calls — not routed through the agent.
- **`evaluate` CLI command** runs pre-checks only (provider detection, feed discovery). The agent handles deeper evaluation when needed.

## Environment

Do not edit `.env` directly. Required vars documented in `.env.example`.
