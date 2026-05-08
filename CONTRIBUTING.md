# Contributing

Build, run, deploy, and operate the monorepo behind [releases.sh](https://releases.sh) — the API worker, MCP server, web frontend, discovery agents, and shared packages. The user-facing CLI lives separately in [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli) and ships through npm + Homebrew; this repo talks to the world over HTTP.

This repo is private. The conventions below cover the shape of changes so PRs stay easy to review and the published packages (`@buildinternet/releases-core`, `@buildinternet/releases-api-types`, `@buildinternet/releases-lib/logger`) behave consistently for the OSS CLI.

## Setup

```bash
bun install
```

Working in a git worktree? Run `./scripts/setup-worktree.sh` once after `git worktree add` — it installs dependencies and copies `.env` + `web/.env.local` from the main checkout. Claude Code sessions trigger the dependency install automatically via a `SessionStart` hook; the script is for terminal-driven bootstraps.

The monorepo no longer ships a local CLI. If you need `releases <cmd>` while working on backend changes, clone [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli) alongside this repo and point it at a local API worker (`bun run dev:api`) via `RELEASED_API_URL=http://localhost:8787`.

## Environment variables

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — Required for AI-powered parsing and summaries
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` — Required for scraping changelog pages (only used as a fallback when no feed is available)
- `GITHUB_TOKEN` — Optional, increases GitHub API rate limits
- `RELEASED_API_URL` / `RELEASED_API_KEY` — Remote mode: route CLI data operations through the API Worker. Compiled binaries default to `https://api.releases.sh` when unset
- `VOYAGE_API_KEY` — Required on the API and MCP workers for semantic search ingest and queries. Provision the Vectorize indexes once with `./scripts/create-vectorize-indexes.sh`, then add `VOYAGE_API_KEY` to Cloudflare's Secrets Store and confirm both workers bind it in `workers/{api,mcp}/wrangler.jsonc` under `secrets_store_secrets`
- `EMBEDDING_PROVIDER` — Optional, defaults to `voyage` (`voyage-4-lite`, requested at 512 dims). Set to `openai` or `workers-ai` in `workers/{api,mcp}/wrangler.jsonc` to switch; recreate the indexes if vector dimensionality changes

## Local development

```bash
bun run db:migrate:local     # apply D1 migrations (required before first dev:api run)
bun run dev:web              # Next.js frontend on :3000
bun run dev:api              # API worker on :8787 (local D1)
bun run dev:discovery        # Discovery worker locally
bun run dev:mcp              # MCP worker locally
```

Point the web frontend at the local API worker by setting `RELEASED_API_URL=http://localhost:8787` in `web/.env.local`.

`wrangler dev` does not pull from Cloudflare's Secrets Store, so any endpoint that reads `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `VOYAGE_API_KEY`, `RELEASED_API_KEY`, or `WEBHOOK_HMAC_MASTER` will fail locally unless you create `workers/api/.dev.vars` with the values you need. The file is gitignored.

## Type-checking

```bash
npx tsc --noEmit                     # type-check (root — src/ survivors)
cd workers/api && npx tsc --noEmit   # type-check the API worker
cd web && npx tsc --noEmit           # type-check the frontend
bun run db:generate                  # scaffold a migration preview under .drizzle-out/ (then hand-author the real file under workers/api/migrations/)
```

## Testing

Tests use Bun's built-in test runner — no extra dependencies required.

```bash
bun test                     # run all tests (evals are excluded by design)
bun test tests/unit/         # run unit tests only
bun test tests/api/          # run worker-side route tests
bun test --watch             # re-run on file changes
```

Tests live in `tests/` with this structure:

```
tests/
  db-helper.ts          # createTestDb() — in-memory bun:sqlite + drizzle + migrations
  tsconfig.json         # separate type-check config for tests
  fixtures/
    feeds/              # RSS, Atom, JSON Feed samples
    html/               # HTML pages for parser testing
  unit/                 # pure function tests and Hono route tests via app.fetch()
  api/                  # worker-side route + query tests
  evals/                # AI eval suites (see below)
```

Type-check tests separately (they have their own tsconfig):

```bash
npx tsc --noEmit --project tests/tsconfig.json
```

## Evals

Eval suites measure the quality of AI-powered features — changelog parsing, source evaluation, and agent discovery. They call real AI models and are not part of the normal test run.

```bash
bun run eval:evaluation      # URL evaluation evals (~30 sec, no API key needed)
```

Parsing + discovery evals used to live in this repo but followed the CLI into [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli); the parser and discovery harness there own their own eval suites.

**Fixtures** live in `tests/evals/fixtures/`. Fixture `.expected.json` files are grading specs with fields like `contentContains` and `isBreaking` that enable code-based grading of structured AI output. **Results** are saved to `tests/evals/results/` (gitignored) as timestamped JSON.

## Deployment

Workers auto-deploy on merges to `main` via `.github/workflows/deploy-workers.yml` — the workflow path-filters so only the workers whose code changed are rebuilt, fans out across `production` and `staging`, and runs `wrangler d1 migrations apply` against each environment's DB before the new code starts serving (so additive schema lands first). Managed agents + skills auto-deploy the same way via `.github/workflows/deploy-managed-agents.yml`, path-filtered on `src/shared/agent-tools.ts`, `src/shared/worker-prompt.ts`, `src/shared/discovery-prompt.ts`, `src/agent/skills/**`, and `scripts/sync-agent-skills.ts`. Both workflows expose `workflow_dispatch` for manual redeploys.

To deploy manually from the project root, set `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` in `.env` (Bun autoloads it) and run:

```bash
bun run deploy               # deploy all workers (API + Discovery + MCP)
bun run deploy:api           # deploy API worker only
bun run deploy:discovery     # deploy Discovery worker only
bun run deploy:mcp           # deploy MCP worker only
bun run deploy:agents            # sync both managed agents (discovery + worker)
bun run deploy:agents:discovery  # sync discovery agent only (Sonnet)
bun run deploy:agents:worker     # sync worker agent only (Haiku)
bun run deploy:skills            # sync skills only (SKILL.md files)
bun run deploy:agents --dry-run  # preview agent changes without pushing
bun run db:migrate:remote    # apply D1 migrations to production (rarely needed — auto-applied on deploy)
```

The discovery worker runs **managed agents** (Anthropic-hosted). Sessions are Durable Objects that stream events from the Anthropic API via typed executor tools.

Agent tools, system prompts, and skills auto-deploy on merges to `main` — `deploy-managed-agents.yml` watches the five paths listed above and pushes prompt + tools + skills + model to both Anthropic-hosted agents. For local iteration, `bun run deploy:agents` does the same push on demand (requires `ANTHROPIC_API_KEY`); use `deploy:agents:discovery` or `deploy:agents:worker` for single-agent deploys, or `-- --env staging` for staging. Agent IDs and skill mappings are stored in `scripts/agent-skills.json`.

## Database tools

```bash
bun run db:studio:d1         # browse local D1 database (Drizzle Studio)
bun run db:query "SQL"       # run a query against local D1
bun run db:pull              # sync remote D1 data into local D1
```

## Pull requests

PR titles follow [Conventional Commits](https://www.conventionalcommits.org/) with an optional scope identifying the workspace or surface:

```
feat(api): admin write endpoints for collections
fix(sitemap): include /collections/<slug>
chore(api-types): publish 0.9.0 with collection write types
```

- Subject starts with a lowercase letter.
- Use `feat`, `fix`, `perf`, `docs`, `chore`, `refactor`, `test`.
- Append `!` for breaking changes (`feat(api)!: ...`).
- Avoid sensational language ("comprehensive", "world-class", etc.).

A few project-specific things to keep in mind:

- **Workers and managed agents auto-deploy from `main` on merge** — every PR ships to production the moment it lands. Treat reviews accordingly.
- **Schema changes land in `packages/core/` first**, not under `workers/api/migrations/`. The OSS CLI consumes `@buildinternet/releases-core` from npm, so the shared schema is the source of truth.
- **Wire-protocol changes** (request/response shapes the API serves) land in `packages/api-types/` first. Additive by default — renames or removals go through a one-minor-version deprecation alias before the field disappears.
- **Drizzle migrations are mandatory** for any new table or column. Schema-only changes that skip the migration crash local DBs on the next `db:migrate:local`.
- **D1's 100-bind limit** is real. Batch inserts chunk at `floor(100 / binds_per_row)` per statement; raising without re-checking surfaces as a 500 in production.
- **Workers logging uses `logEvent()`** from `@releases/lib/log-event` (worker-safe). Don't pull `@buildinternet/releases-lib/logger` into a worker — it writes to a virtual `fs` discarded per request.

For deep architectural context, see `docs/architecture/` — separate documents cover MCP, semantic search, agents, the event bus, and the extract pipeline.

## Search-query observability

Every call to `/v1/search` and the MCP `search` / `search_releases` / `search_registry` tools writes a row to the `search_queries` table — query text (truncated to 200 chars), surface (`web` | `mcp` | `api`), retrieval mode, per-section result counts, and duration. Inspect via:

- `GET /v1/admin/search-queries?since=7d&surface=mcp` — paginated raw rows, newest first. Bearer-auth.
- `GET /v1/admin/search-queries/top?since=30d` — grouped by query, count desc.

Both endpoints accept `?bots=exclude|include|only` (default: `exclude`). `exclude` hides rows where `user_agent` is empty or matches common crawler patterns (`%bot%`, `%crawl%`, `%spider%`, `%slurp%`). `include` returns all rows (pre-filter behavior). `only` returns just the bot rows, useful for tuning the heuristic.

The web frontend tags requests as `web` via the `X-Releases-Surface` header so admin reads can split visitor searches from direct API consumers. This log is intentionally separate from `telemetry_events`, which carries only command names and stays PII-clean for the OSS CLI contract. Set `SEARCH_QUERY_LOG_DISABLED=true` on the API or MCP worker to disable writes without removing call sites.

Rows are retained for **90 days** by default. A nightly cron at 05:00 UTC deletes rows older than the configured window, keeping the table bounded and reducing exposure of user-typed query text. Override with `SEARCH_QUERY_RETENTION_DAYS` in `workers/api/wrangler.jsonc`.
