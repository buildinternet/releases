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

- Type-check: `npx tsc --noEmit`
- Tests: `bun test`
- **Evals (`tests/evals/`) are manual and on-demand only.** They call AI APIs, cost money, and take minutes to complete. Only run when explicitly asked via `bun run eval:parsing`, `bun run eval:evaluation`, or `bun run eval:discovery`.

## Building

The CLI compiles to a self-contained binary via `bun build --compile`:

```bash
bun run build                 # compile for current platform (macOS)
bun run build:linux           # cross-compile for Linux (sandbox container)
bun run build:all             # compile CLI + MCP browser server
bun run build:all:linux       # cross-compile both for Linux
```

Output goes to `dist/`. The compiled binary requires remote mode (`RELEASED_API_URL`) — local SQLite mode is only supported via `bun src/index.ts`.

**Workspaces:** Root `package.json` declares `workers/api`, `web`, `npm/*`, and `packages/*` as workspaces. `workers/discovery/` and `workers/mcp/` are intentionally excluded because Bun eagerly resolves imports across all workspace members at startup — the `cloudflare:workers` imports in those workers' files cause `bun src/index.ts` to fail even though the CLI never imports from them. Wrangler manages those workers' dependencies independently.

**Carved-out packages:** Shared code is split between published npm packages (`@buildinternet/releases-*`) and private in-tree packages (`packages/`):

- `packages/core/` → imported as **`@releases/core-internal`** inside the monorepo. Private superset: DB schema (source of truth), `release-upsert`, `tokens`, `changelog-range`, `hash`, `webhook-sign`, and the monorepo copies of `categories`, `dates`, `changelog-slice`, `overview`, `id`, `slug`. The OSS CLI (`buildinternet/releases-cli`) independently publishes `@buildinternet/releases-core` — a **narrower, curated** subset of these exports for thin-client use. The two are intentional forks; **do not import `@buildinternet/releases-core` inside this monorepo**. Tracked in #370 (consolidation plan).
- `packages/adapters/` — adapter primitives (`types`, `source-meta`, `content-hash`), the `github`, `cloudflare`, and `crawl` adapters, and the pure subset of `feed`. DB-coupled adapters (`src/adapters/{feed,agent,scrape,resolve}.ts`) stay in `src/` because they reach into `src/db/queries` and `src/ai/*`.
- `packages/lib/` — `@releases/lib/{config,errors}` private. `logger` is published as `@buildinternet/releases-lib/logger`. Published lib exposes only `getDataDir`/`getLogsDir`.

Worker tsconfigs map `@releases/lib/*` to `../../src/lib/*` for files not yet carved out.

## Conventions

- All logging goes to **stderr** via `@buildinternet/releases-lib/logger` (source at `packages/lib/src/logger.ts`). stdout is reserved for MCP JSON-RPC in serve mode.
- Source types: `github`, `scrape`, `feed`, `agent`. The `scrape` adapter auto-discovers RSS/Atom/JSON feeds before falling back to Cloudflare + AI. Feed metadata (URL, type, ETag) is cached in `source.metadata`.
- Crawl mode (`--crawl`) uses Cloudflare's `/crawl` endpoint for multi-page changelogs, stored in `source.metadata.crawlEnabled`. See `packages/adapters/src/crawl.ts`.
- Use shared DB query helpers in `src/db/queries.ts` instead of inlining drizzle queries.
- `toReleaseInput()` from `src/ai/query.ts` maps DB rows (nullable) to AI input shape — don't hand-roll.
- `daysAgoIso()` from `@releases/core-internal/dates` for date cutoffs.
- CLI data commands support `--json` for machine-readable output.
- Batch DB inserts chunk in 500s locally (SQLite variable limit). D1's hard limit is **100 bound parameters per prepared statement**, so `workers/api/src/routes/sources.ts` chunks at `floor(100 / binds_per_row)` per INSERT. For `releases` (13 binds/row) that's 7 rows per statement. `inArray(...)` lookups chunk at 90 IDs. Raising without re-checking bind count surfaces as a 500 on `/releases/batch`.
- Dedup via `UNIQUE(source_id, url)` and the shared `RELEASE_URL_UPSERT` config in `@releases/core-internal/release-upsert` — on URL collision, content is backfilled when incoming is non-empty and existing is empty. Both local and worker paths import it so they can't drift.
- `releases admin source import <file>` bulk-imports orgs/sources from a JSON manifest (discovery agent handoff). Supports `--dry-run`, `--json`, `--skip-existing`.
- Smart fetch: `--stale <hours>` respects backoff + `fetchPriority`. `--changed` targets sources with `changeDetectedAt`. `--retry-errors` retries failed fetches. Backoff counters (`consecutiveNoChange`, `consecutiveErrors`) on the `sources` table drive exponential backoff (no_change: 1h–48h, errors: 1h–72h). Default max 200 releases/source; `--max <n>` or `--all` overrides.
- Categories validated against `CATEGORIES` in `@releases/core-internal/categories` — adding one requires a code change. Tags are freeform (get-or-create via `tags` table). Join tables are `org_tags` and `product_tags` (not polymorphic).
- Domain aliases (`domain_aliases` table) map alternate domains to orgs/products. Globally unique. CLI: `releases admin {org,product} alias add/remove/list`. Matched in `findOrg()`/`findProduct()` fallback and in search LEFT JOINs.
- Products are an **optional** grouping layer between orgs and sources (nullable `productId`). Multi-product orgs (e.g. Vercel → Next.js, Turborepo) use them; simple orgs skip. CLI: `releases admin product list/add/edit/remove/adopt`. `product adopt` converts an org into a product under another org.
- Ignored URLs are **org-scoped** (`ignored_urls`, requires `orgId`); blocked URLs are **global** (`blocked_urls`, spam/bad domains). CLI: `releases admin policy {ignore,block} ...`. Both checked by `isUrlExcluded()`.
- Release suppression: `releases admin release suppress <id> --reason "..."` hides from all read paths without deleting. `unsuppress` restores.
- Release coverage: multiple releases can cover one launch (marketing post + changelog + app note). Canonical + coverage items tracked in `release_coverage`; read paths hide coverage-side rows by default. See [coverage.md](docs/architecture/coverage.md) for cluster verb, ingest-time grouping, and cron observability.
- Org overviews: AI-generated `knowledge_pages` (scope `org`) summarize recent activity. Staleness threshold `OVERVIEW_STALE_DAYS = 30` from `@releases/core-internal/overview`; past threshold surfaces show a `⚠ older than 30 days` warning. See [web.md](docs/architecture/web.md).
- Release type: `feature` (default) or `rollup` (seasonal/quarterly catch-all like Brex Fall Release). Classified by the parse agent via the `parsing-changelogs` skill. `RELEASE_TYPES`/`ReleaseType` exported from `@releases/core-internal/schema`. `search_releases` and `get_latest_releases` accept a `type` filter. `search_releases` also takes `mode: "lexical"|"semantic"|"hybrid"` and returns a `kind: "release"|"changelog_chunk"` discriminator — see [semantic-search.md](docs/architecture/semantic-search.md).
- GitHub CHANGELOG files are fetched alongside tagged releases and stored in `source_changelog_files`; refresh piggybacks on every GitHub fetch. Web surfaces the file in a Changelog tab via `GET /v1/sources/:slug/changelog`. See [web.md](docs/architecture/web.md).
- Entity resolution prefers IDs over slugs. All lookups (CLI, API, agent tools) accept either `{org_|src_|prod_|rel_}...` or a slug. IDs are immutable; prefer them when available.
- Media pipeline: `filterJunkMedia()` (tracking pixels, favicons, AI-classified chrome) then `processMediaForR2()` uploads survivors to R2. `normalizeMediaUrl()` unwraps Next.js/Vercel image-optimizer URLs before upload. Web renders `r2Url ?? url`; `FallbackImage` shows a placeholder on load error. See [web.md](docs/architecture/web.md).
- Remote mode fetch requires a filter (`--stale`, `--unfetched`, `--changed`, `--retry-errors`, or a source slug). Bare `releases admin source fetch` is blocked to prevent expensive bulk ops. Remote concurrency defaults to 3, capped at 5.

## Common CLI Patterns

```bash
releases show <id|slug>         # Inspect any entity by ID (rel_/src_/org_/prod_) or slug
releases tail                   # Latest releases across all sources (alias: latest)
releases tail <slug> --count 5  # Latest releases from one source
releases tail -f                # Follow new releases as they arrive (polls every 60s)
releases tail -f --interval 30  # Same, with a 30s interval
releases tail --once --json     # Single poll, JSON output (for scripts/cron)
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

- Commands accept entity IDs (`org_...`, `src_...`, `prod_...`, `rel_...`) or slugs. IDs are preferred — slugs can change, IDs cannot. The top-level `show <id|slug>` dispatches by ID prefix, falling back to a slug lookup (org → product → source) for bare strings.
- `edit` accepts IDs or slugs. Slug renames (`--slug`) require `--confirm-slug-change` because they break web links.
- `releases list` is aliased as `releases admin source list`.
- Source slug is always a **positional argument** (e.g., `admin source fetch claude-code`), not a flag. `--source <slug>` is accepted as an alias.
- `releases admin org list` returns a summary view. Use `releases admin org show <slug>` for full details.

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
