# Releases

Changelog indexer and registry for AI agents and developers. Fetches, normalizes, and indexes release notes from GitHub releases, RSS/Atom/JSON feeds, and product changelog pages, then exposes them via an MCP server or CLI.

Website: [releases.sh](https://releases.sh)

## Install

The CLI is available as a prebuilt binary via npm — no source code or runtime dependencies required:

```bash
npm install -g @buildinternet/releases
releases search "react"
```

Or run without installing:

```bash
npx @buildinternet/releases search "react"
npx @buildinternet/releases latest --org vercel
```

The public CLI connects to the hosted API at `api.releases.sh` automatically. Read-only commands (search, latest, stats, list, categories) work without any configuration. Admin commands (fetch, onboard, enrich) require an API key.

## Development Setup

```bash
bun install
bun link        # makes `releases` available as a CLI command
```

### Environment Variables

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — Required for AI-powered parsing and summaries
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` — Required for scraping changelog pages (only used as a fallback when no feed is available)
- `GITHUB_TOKEN` — Optional, increases GitHub API rate limits
- `RELEASED_API_URL` / `RELEASED_API_KEY` — Remote mode: route CLI data operations through the API Worker. Compiled binaries default to `https://api.releases.sh` when unset

## Usage

### Search

```bash
releases search "authentication"
releases search "vercel" --type releases --limit 5
releases search "breaking change" --json
```

### Latest releases

```bash
releases latest                          # across all sources
releases latest next-js                  # from one source
releases latest --org vercel --count 20  # latest 20 from an org
```

### Inspect sources

```bash
releases list                          # list all sources
releases list next-js                  # show details for a single source
releases list --org sentry             # filter by organization
releases list --query shadcn           # filter by name, slug, or URL
releases list --has-feed               # sources with a discovered feed URL
releases list --category ai            # filter by category
releases list --json                   # machine-readable output
```

### Summaries

Generate a natural-language summary of recent releases for a source or organization:

```bash
releases summary next-js --days 30
releases summary --org vercel --days 7
releases summary next-js --instructions "focus on API breaking changes"
```

### Comparisons

Generate a head-to-head comparison of recent releases between two sources:

```bash
releases compare next-js remix --days 30
releases compare neon-changelog planetscale-changelog --days 60
```

### Categories

```bash
releases categories          # list valid category values
releases categories --json
```

### Statistics

```bash
releases stats             # index overview, source health, recent fetch activity
releases stats --days 7    # adjust period
releases stats --json      # machine-readable output
```

### Usage tracking

```bash
releases usage             # show API token usage summary
releases usage --days 7    # last 7 days
```

### Web Frontend

Browse the catalog in your browser:

```bash
releases api              # start the API server on :3456
cd web && bun run dev     # start the Next.js frontend on :3000
```

The API server exposes read-only JSON endpoints (`/api/stats`, `/api/orgs`, `/api/orgs/:slug/activity`, `/api/orgs/:slug/heatmap`, `/api/orgs/:slug/releases`, `/api/sources`, `/api/sources/:slug/activity`, `/api/search`). The frontend is a Next.js app in `web/` that fetches from the API. Configure the API URL for the frontend with `RELEASED_API_URL` (defaults to `http://localhost:3456`).

Production deployment: the API and frontend are deployed separately. The frontend will be hosted at [releases.sh](https://releases.sh).

### MCP Server

Start the MCP server for AI agent integration:

```bash
releases serve
```

Claude Desktop config:

```json
{
  "mcpServers": {
    "releases": {
      "command": "releases",
      "args": ["serve"],
      "env": {
        "ANTHROPIC_API_KEY": "...",
        "CLOUDFLARE_ACCOUNT_ID": "...",
        "CLOUDFLARE_API_TOKEN": "..."
      }
    }
  }
}
```

**MCP Tools:**

| Tool | Description |
|------|-------------|
| `search_releases` | Full-text search across all indexed releases |
| `get_latest_releases` | Most recent releases, optionally filtered by product |
| `summarize_changes` | AI summary of a product's recent changes |
| `compare_products` | AI comparison between two products |
| `list_products` | List all tracked sources |
| `list_organizations` | List all organizations with their linked sources |

---

## Admin CLI

The following commands require an API key (`RELEASED_API_KEY`). They are not available in the public CLI.

### Add sources

```bash
releases add "Next.js" --url https://github.com/vercel/next.js
releases add "Linear" --url https://linear.app/changelog
releases add --name "My Blog" --url https://example.com/changelog
```

The name can be a positional argument or passed via `--name`.

By default, `add` runs automated pre-checks that determine the best ingestion method for a URL. This includes provider detection (Mintlify, Docusaurus, etc.), feed discovery, and markdown suffix probing:
- **GitHub URLs** → uses the GitHub Releases API directly
- **Other URLs** → evaluates and stores the recommended method (feed, markdown, scrape, or crawl) so the first `fetch` already knows the optimal path

You can override detection with `--type github`, `--type scrape`, or `--type feed`. Use `--skip-eval` to bypass evaluation and fall back to basic heuristic detection. Batch mode (`--batch`) skips evaluation by default for speed.

If you know the feed URL and it isn't easily discoverable, provide it explicitly (skips evaluation):

```bash
releases add "Claude Code" --url https://docs.anthropic.com/en/changelog \
  --feed-url https://docs.anthropic.com/en/changelog/rss.xml
```

To evaluate a URL without adding it as a source:

```bash
releases evaluate https://linear.app/changelog
```

### Edit sources

```bash
releases edit next-js --url https://github.com/vercel/next.js/releases
releases edit linear --name "Linear Changelog" --feed-url https://linear.app/rss/changelog.json
releases edit my-blog --org acme               # set organization
releases edit my-blog --no-org                  # remove organization
releases edit my-blog --type feed               # change adapter type
releases edit my-blog --no-feed-url             # clear stored feed URL
releases edit my-blog --markdown-url https://example.com/changelog.md
releases edit my-blog --fetch-method markdown   # set recommended fetch method
releases edit my-blog --provider mintlify       # set detected provider
releases edit my-blog --primary                 # mark as org's primary changelog
releases edit my-blog --no-primary              # unmark as primary
```

### Fetch releases

```bash
releases fetch next-js     # one source (or: releases fetch --source next-js)
releases fetch --since 2025-01-01 --max 50
releases fetch --max 500   # fetch up to 500 releases per source
releases fetch --all       # no date/count limits
releases fetch --stale 24  # only stale sources, with backoff
releases fetch --retry-errors  # retry failed sources
releases fetch --unfetched --concurrency 5  # parallel fetch
releases fetch next-js --no-summarize      # skip summary generation
```

By default, fetch caps at 200 releases per source to avoid API pagination limits (e.g., GitHub's 10K result cap). Use `--max <n>` to request more, or `--all` to remove the cap entirely.

> **Remote mode:** bare `releases fetch` (no slug or filter) is blocked to prevent expensive bulk operations. Use `--stale`, `--unfetched`, `--retry-errors`, or a source slug. Remote concurrency defaults to 3 (max 5). Duplicate source fetches are detected and blocked.

### Smart fetch

```bash
releases fetch --stale 24          # only fetch sources older than 24h, respecting backoff
releases fetch --retry-errors      # only fetch sources whose last attempt failed
```

Sources that repeatedly return no changes back off automatically (1h → 2h → 4h → ... up to 48h). Error backoff caps at 72h. Successful fetches reset all counters. Paused sources (`fetchPriority = "paused"`) are always skipped by `--stale`. The default 200-release cap applies to smart fetch as well — use `--max` to adjust per-run.

### Crawl mode

For changelogs spread across multiple pages, crawl mode follows links and parses each page individually:

```bash
releases fetch linear --crawl                    # enable crawl, auto-detect pattern
releases fetch linear --crawl --crawl-pattern "https://linear.app/changelog/*"
releases fetch linear --no-crawl                 # one-off skip, keeps setting
```

Crawl mode persists on the source — subsequent `releases fetch linear` calls will automatically crawl. Only works with `scrape` sources.

### Enrich releases

For feed sources with sparse content (short summaries), hydrate releases with full page content:

```bash
releases enrich sentry-changelog              # enrich sparse releases
releases enrich sentry-changelog --dry-run    # preview what would be enriched
releases enrich sentry-changelog --limit 5    # process at most 5 releases
releases enrich sentry-changelog --force      # bypass triage, re-enrich all candidates
releases enrich sentry-changelog --json       # machine-readable output
```

Enrichment uses AI triage (Haiku) to judge which releases need enrichment, then fetches and extracts full page content. Token usage is reported per run. Use `--force` to bypass triage and re-process all releases — useful for backfilling media on previously-enriched releases or re-enriching after adding `parseInstructions`. Media from new extractions is merged with existing media (deduped by URL), so `--force` never drops previously-captured media.

### Feed change detection

```bash
releases poll                  # check all feed sources for changes
releases poll next-js          # check a single source
releases poll --changed        # only show sources with detected changes
```

### Organizations

Group sources under organizations for aggregate queries:

```bash
releases org add "Vercel"
releases org link vercel --platform github --handle vercel
releases add "Next.js" --type github --url https://github.com/vercel/next.js --org vercel
releases org list                                          # summary: name, domain, counts
releases org show vercel                                   # full details: accounts, tags, sources
```

### Products

Group sources under products within an organization — useful for multi-product orgs like Vercel (Next.js, Turborepo, v0):

```bash
releases product add "Next.js" --org vercel --url https://nextjs.org
releases product add "Turborepo" --org vercel --url https://turbo.build
releases product list vercel
releases product edit nextjs --description "React framework for production"
releases product remove nextjs                    # sources become unlinked, not deleted
```

Convert an org that should be a product:

```bash
releases product adopt nextjs --into vercel
```

### Domain aliases

```bash
releases org alias add anthropic claude.ai claude.com
releases product alias add nextjs nextjs.org
```

### Categories & tags

```bash
releases org add "Acme" --category cloud --tags typescript,edge
releases org tag add acme react serverless
releases product tag add acme-cli testing
releases list --category ai
```

### Import sources from manifest

Bulk-import organizations and sources from a JSON file:

```bash
releases import manifest.json
releases import manifest.json --dry-run
releases import manifest.json --skip-existing
```

### AI-powered onboarding

Use the AI agent to discover, validate, and add changelog sources for a company:

```bash
releases onboard "Vercel"
releases onboard "Stripe" --domain stripe.com --github-org stripe
```

### Discover sources

Automatically find changelog and release-note pages for a domain:

```bash
releases discover vercel.com
releases discover vercel.com --verify     # AI verification pass
releases discover vercel.com --add        # auto-add all discovered sources
```

### Ignored URLs & blocked URLs

```bash
releases ignore add https://example.com/blog --org vercel --reason "Not a changelog"
releases ignore list --org vercel
releases block add medium.com --domain --reason "Aggregator"
releases block list
```

### Release management

```bash
releases release show rel_abc123
releases release edit rel_abc123 --title "Fixed title" --version "v2.0.1"
releases release delete rel_abc123
releases release suppress rel_abc123 --reason "promotional content"
```

### Release summaries

AI-generated thematic summaries, produced automatically at fetch time:

```bash
releases summarize next-js                # generate rolling summary (last 90 days)
releases summarize next-js --window 30    # custom window
releases summarize next-js --monthly      # generate last month's archive summary
```

### Source health checks

```bash
releases check             # check all sources
releases check next-js     # check one source
```

### Fetch history

```bash
releases fetch-log                   # recent fetch logs across all sources
releases fetch-log next-js           # logs for one source
```

### Task management

Manage remote fetch and discovery sessions (requires remote mode):

```bash
releases task list
releases task cancel <sessionId>
```

## Architecture

- **TypeScript + Bun** — single package, compiles to a self-contained binary via `bun build --compile`. Distributed as `@buildinternet/releases` on npm with platform-specific packages (macOS arm64/x64, Linux x64/arm64)
- **SQLite** (Bun built-in + Drizzle ORM) with WAL mode and FTS5 for search
- **Adapters** — GitHub Releases API, RSS/Atom/JSON Feed parser, Cloudflare Browser Rendering for scraping
- **AI Layer** — Anthropic SDK for changelog parsing (ingestion) and summarization (query)
- **Agent** — Unified Agent SDK agent (`src/agent/released.ts`) handles discovery, evaluation, and onboarding. Domain knowledge lives in skill files at `src/agent/skills/`. The deterministic fetch pipeline (ingest, incremental, enrich, summarize) stays as direct Messages API calls.
- **MCP Server** — `@modelcontextprotocol/sdk` on stdio
- **API Server** — Bun HTTP server with JSON endpoints, CORS enabled. GET endpoints are public (no auth); write operations require a Bearer token
- **Web Frontend** — Next.js 15 (App Router) + Tailwind CSS in `web/`
- **Migrations** — Drizzle Kit (`bun run db:generate` to create, applied automatically at startup)

## Data Storage

Data is stored in `~/.releases/releases.db` (configurable via `RELEASED_DATA_DIR`).

## Deployment

All workers can be deployed from the project root:

```bash
bun run deploy               # deploy all workers (API + Discovery)
bun run deploy:api           # deploy API worker only
bun run deploy:discovery     # deploy Discovery worker only
bun run db:migrate:remote    # apply D1 migrations to production
```

### Publishing the CLI to npm

The CLI is distributed as `@buildinternet/releases` with platform-specific binary packages:

```bash
bun run publish:npm            # dry run — builds all platforms, shows what would publish
bun run publish:npm --publish  # build and publish to npm
```

Requires `NPM_PUBLISHING_TOKEN` in `.env` (a granular access token with "Bypass 2FA" enabled). Version is read from the root `package.json` and synced to all npm packages automatically.

Local development:

```bash
bun run db:migrate:local     # apply D1 migrations (required before first dev:api run)
bun run api                  # start local API server on :3456 (uses local SQLite)
bun run dev:web              # start Next.js frontend on :3000
bun run dev:api              # start API worker locally on :8787 (uses local D1)
bun run dev:discovery        # start Discovery worker locally (Cloudflare)
```

To use the Cloudflare worker API locally with the web frontend, set `RELEASED_API_URL=http://localhost:8787` in `web/.env.local`. The default (`localhost:3456`) uses the Bun-based local API server backed by SQLite.

Workers live in `workers/api/` (Hono API backed by D1) and `workers/discovery/` (Durable Objects + Sandbox for agent-driven source discovery). Both share the same D1 database.

The discovery worker's sandbox container runs compiled binaries — no Bun runtime, source tree, or node_modules. Build with `bun run build:all:linux` before deploying. The root `.dockerignore` uses an **allowlist pattern** — only `dist/releases`, `dist/releases-mcp-browser`, and `src/agent/skills/` are included. Old container images are not auto-pruned — use `wrangler containers images list` and `wrangler containers images delete` periodically to clean up.

Database tools:

```bash
bun run db:studio            # browse local CLI database (Drizzle Studio)
bun run db:studio:d1         # browse local D1 database (Drizzle Studio)
bun run db:query "SQL"       # run a query against local D1
bun run db:pull              # sync remote D1 data into local D1
```

## Development

```bash
bun src/index.ts <command>   # run directly without linking
npx tsc --noEmit             # type-check (CLI)
cd web && npx tsc --noEmit   # type-check (frontend)
bun run db:generate          # generate migration after schema change
bun run build                # compile CLI binary (current platform)
bun run build:all:linux      # compile CLI + MCP server for sandbox container
```

### Testing

Tests use Bun's built-in test runner — no extra dependencies required.

```bash
bun test                     # run all tests
bun test tests/unit/         # run unit tests only
bun test tests/cli/          # run CLI integration tests only
bun test --watch             # re-run on file changes
```

Tests live in `tests/` with this structure:

```
tests/
  utils.ts              # runCli() helper, ANSI stripping
  tsconfig.json         # separate type-check config for tests
  fixtures/
    feeds/              # RSS, Atom, JSON Feed samples
    html/               # HTML pages for parser testing
  unit/                 # pure function tests (dates, slug, hash, feed parsers, etc.)
  cli/                  # integration tests that shell out to the real CLI
```

Type-check tests separately (they have their own tsconfig):

```bash
npx tsc --noEmit --project tests/tsconfig.json
```
