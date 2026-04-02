# Released

Changelog indexer and registry for AI agents and developers. Fetches, normalizes, and indexes release notes from GitHub releases, RSS/Atom/JSON feeds, and product changelog pages, then exposes them via an MCP server or CLI.

## Setup

```bash
bun install
bun link        # makes `released` available as a CLI command
```

### Environment Variables

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — Required for AI-powered parsing and summaries
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` — Required for scraping changelog pages (only used as a fallback when no feed is available)
- `GITHUB_TOKEN` — Optional, increases GitHub API rate limits
- `RELEASED_API_URL` / `RELEASED_API_KEY` — Remote mode: route CLI data operations through the API Worker
- `RELEASED_DISCOVERY_URL` — Remote onboarding: route `onboard` through the discovery worker (e.g. `https://released-discovery.rally-workers-test.workers.dev`)

## Usage

### Add sources

```bash
released add "Next.js" --url https://github.com/vercel/next.js
released add "Linear" --url https://linear.app/changelog
released add --name "My Blog" --url https://example.com/changelog
```

The name can be a positional argument or passed via `--name`.

By default, `add` runs automated pre-checks that determine the best ingestion method for a URL. This includes provider detection (Mintlify, Docusaurus, etc.), feed discovery, and markdown suffix probing:
- **GitHub URLs** → uses the GitHub Releases API directly
- **Other URLs** → evaluates and stores the recommended method (feed, markdown, scrape, or crawl) so the first `fetch` already knows the optimal path

You can override detection with `--type github`, `--type scrape`, or `--type feed`. Use `--skip-eval` to bypass evaluation and fall back to basic heuristic detection. Batch mode (`--batch`) skips evaluation by default for speed.

If you know the feed URL and it isn't easily discoverable, provide it explicitly (skips evaluation):

```bash
released add "Claude Code" --url https://docs.anthropic.com/en/changelog \
  --feed-url https://docs.anthropic.com/en/changelog/rss.xml
```

To evaluate a URL without adding it as a source:

```bash
released evaluate https://linear.app/changelog
```

### Edit sources

```bash
released edit next-js --url https://github.com/vercel/next.js/releases
released edit linear --name "Linear Changelog" --feed-url https://linear.app/rss/changelog.json
released edit my-blog --org acme               # set organization
released edit my-blog --no-org                  # remove organization
released edit my-blog --type feed               # change adapter type
released edit my-blog --no-feed-url             # clear stored feed URL
released edit my-blog --markdown-url https://example.com/changelog.md
released edit my-blog --fetch-method markdown   # set recommended fetch method
released edit my-blog --provider mintlify       # set detected provider
released edit my-blog --primary                 # mark as org's primary changelog
released edit my-blog --no-primary              # unmark as primary
```

### Fetch releases

```bash
released fetch next-js     # one source (or: released fetch --source next-js)
released fetch --since 2025-01-01 --max 50
released fetch --max 500   # fetch up to 500 releases per source
released fetch --all       # no date/count limits
released fetch --stale 24  # only stale sources, with backoff
released fetch --retry-errors  # retry failed sources
released fetch --unfetched --concurrency 5  # parallel fetch
released fetch next-js --no-summarize      # skip summary generation
```

By default, fetch caps at 200 releases per source to avoid API pagination limits (e.g., GitHub's 10K result cap). Use `--max <n>` to request more, or `--all` to remove the cap entirely.

> **Remote mode:** bare `released fetch` (no slug or filter) is blocked to prevent expensive bulk operations. Use `--stale`, `--unfetched`, `--retry-errors`, or a source slug. Remote concurrency defaults to 3 (max 5). Duplicate source fetches are detected and blocked.

### Crawl mode

For changelogs spread across multiple pages, crawl mode follows links and parses each page individually:

```bash
released fetch linear --crawl                    # enable crawl, auto-detect pattern
released fetch linear --crawl --crawl-pattern "https://linear.app/changelog/*"
released fetch linear --no-crawl                 # one-off skip, keeps setting
```

Crawl mode persists on the source — subsequent `released fetch linear` calls will automatically crawl. Only works with `scrape` sources.

### Enrich releases

For feed sources with sparse content (short summaries), hydrate releases with full page content:

```bash
released enrich sentry-changelog              # enrich sparse releases
released enrich sentry-changelog --dry-run    # preview what would be enriched
released enrich sentry-changelog --limit 5    # process at most 5 releases
released enrich sentry-changelog --json       # machine-readable output
```

Enrichment uses AI triage (Haiku) to judge which releases need enrichment, then fetches and extracts full page content. Token usage is reported per run.

### Import sources from manifest

Bulk-import organizations and sources from a JSON file — the discovery agent handoff point:

```bash
released import manifest.json              # import orgs and sources
released import manifest.json --dry-run    # preview what would be created
released import manifest.json --skip-existing  # skip duplicate URLs silently
released import manifest.json --json       # machine-readable output
```

Manifest format:

```json
{
  "organizations": [
    {
      "name": "Vercel",
      "slug": "vercel",
      "domain": "vercel.com",
      "accounts": [
        { "platform": "github", "handle": "vercel" }
      ],
      "sources": [
        { "name": "Vercel Changelog", "type": "scrape", "url": "https://vercel.com/changelog" }
      ]
    }
  ],
  "sources": [
    { "name": "Standalone Source", "url": "https://example.com/changelog" }
  ]
}
```

Slugs are auto-derived from names. Source types are auto-detected from URLs (GitHub URLs become `github`, others default to `scrape`). Existing orgs are found-or-created by slug. Source URLs are deduped against the database.

### Smart fetch

```bash
released fetch --stale 24          # only fetch sources older than 24h, respecting backoff
released fetch --retry-errors      # only fetch sources whose last attempt failed
```

Sources that repeatedly return no changes back off automatically (1h → 2h → 4h → ... up to 48h). Error backoff caps at 72h. Successful fetches reset all counters. Paused sources (`fetchPriority = "paused"`) are always skipped by `--stale`. The default 200-release cap applies to smart fetch as well — use `--max` to adjust per-run.

### Task management

Manage remote fetch and discovery sessions (requires remote mode):

```bash
released task list                    # list active and recent sessions
released task list --json             # machine-readable output
released task cancel <sessionId>      # cancel a running session (prefix match supported)
```

Sessions track which sources are actively being fetched. The CLI blocks new fetches if overlapping sources are already in-flight — cancel the existing session first with `task cancel`.

### Inspect sources

```bash
released list                          # list all sources
released list next-js                  # show details for a single source
released list next-js --json           # machine-readable output
released list --org sentry             # filter by organization
released list --query shadcn           # filter by name, slug, or URL
released list --has-feed               # sources with a discovered feed URL
released list --enrichable             # sources eligible for content enrichment
released list --has-feed --org sentry  # combine filters
```

### Query

```bash
released search "authentication"
released latest --count 5
released latest next-js
released summary next-js --days 30
released summary next-js --instructions "focus on API breaking changes"
released compare next-js linear --days 30
```

### Organizations

Group sources under organizations for aggregate queries:

```bash
released org add "Vercel"
released org link vercel --platform github --handle vercel
released add "Next.js" --type github --url https://github.com/vercel/next.js --org vercel
released org list
released org show vercel
```

### Products

Group sources under products within an organization — useful for multi-product orgs like Vercel (Next.js, Turborepo, v0):

```bash
released product add "Next.js" --org vercel --url https://nextjs.org
released product add "Turborepo" --org vercel --url https://turbo.build
released product list vercel
released product edit nextjs --description "React framework for production"
released product remove nextjs                    # sources become unlinked, not deleted
```

Assign sources to products:

```bash
released add "Next.js Releases" --url https://github.com/vercel/next.js/releases --org vercel --product nextjs
released edit next-js-releases --product nextjs   # assign existing source
released edit next-js-releases --no-product       # unlink from product
released list --product nextjs                    # filter by product
```

Convert an org that should be a product (e.g., "Next.js" was added as a standalone org but should be under Vercel):

```bash
released product adopt nextjs --into vercel                    # convert org to product
released product adopt nextjs --into vercel --dry-run          # preview changes
released product adopt nextjs --into vercel --url https://nextjs.org  # override URL
```

Adopt creates the product, moves all sources and accounts to the target org, then deletes the source org.

Products are also supported in import manifests:

```json
{
  "organizations": [
    {
      "name": "Vercel",
      "slug": "vercel",
      "products": [
        {
          "name": "Next.js",
          "slug": "nextjs",
          "url": "https://nextjs.org",
          "sources": [
            { "name": "Next.js GitHub Releases", "url": "https://github.com/vercel/next.js/releases" }
          ]
        }
      ],
      "sources": [
        { "name": "Vercel Changelog", "url": "https://vercel.com/changelog" }
      ]
    }
  ]
}
```

Org-level `sources` (no product) and product-level `sources` coexist in the same manifest.

### Categories & Tags

Organize entities with a controlled category vocabulary and freeform tags:

```bash
released categories                                  # list valid categories
released categories --json                           # as JSON

# Categories on orgs and products
released org add "Acme" --category cloud --tags typescript,edge
released org edit acme --category developer-tools
released org edit acme --no-category                 # clear category
released product add "CLI" --org acme --category developer-tools --tags golang

# Manage tags separately
released org tag add acme react serverless           # add tags
released org tag remove acme react                   # remove tags
released org tag list acme                           # list tags
released product tag add acme-cli testing            # same for products

# Filter by category
released list --category ai                          # sources in AI orgs/products
```

Categories and tags are also supported in import manifests:

```json
{
  "organizations": [{
    "name": "Vercel",
    "category": "cloud",
    "tags": ["typescript", "edge-computing"],
    "products": [{
      "name": "Next.js",
      "category": "framework",
      "tags": ["react", "ssr"]
    }]
  }]
}
```

### AI-powered onboarding

Use the AI agent to discover, validate, and add changelog sources for a company:

```bash
released onboard "Vercel"                                    # local agent (default)
released onboard "Stripe" --domain stripe.com --github-org stripe
released onboard "Acme" --remote                             # run on the discovery worker
released onboard "Acme" --local                              # force local even in remote mode
released onboard "Acme" --json                               # machine-readable output
```

When `RELEASED_API_URL` and `RELEASED_DISCOVERY_URL` are set, `onboard` defaults to remote mode — the discovery runs on the Cloudflare discovery worker and progress appears on the `/status` dashboard. Use `--local` to override and run the agent in-process.

**Discovery worker secrets** (required for remote onboarding):

| Secret | Purpose |
|--------|---------|
| `ANTHROPIC_API_KEY` | Powers the AI agent inside the sandbox |
| `CLOUDFLARE_ACCOUNT_ID` | Browser rendering for scrape sources |
| `CLOUDFLARE_API_TOKEN` | Browser rendering for scrape sources |
| `GITHUB_TOKEN` | GitHub API access (optional, increases rate limits) |
| `RELEASED_API_URL` | API worker URL for data operations inside the sandbox |
| `RELEASED_API_KEY` | Authenticates requests to the API worker |

Set secrets with `cd workers/discovery && wrangler secret put <NAME>`.

**Discovery guardrails:** The discovery worker prevents duplicate sessions — starting onboard for a company that's already being discovered returns 409, and exceeding 5 concurrent discovery sessions returns 429.

### Discover sources

Automatically find changelog and release-note pages for a domain:

```bash
released discover vercel.com              # scan domain, show results (dry-run)
released discover vercel.com --verify     # use AI to verify results and find more
released discover vercel.com --add        # auto-add all discovered sources
released discover vercel.com --json       # machine-readable output
released discover --org vercel            # use org's domain and GitHub handle
```

Discovery uses multiple evidence-based strategies in parallel:
- **Well-known files** — checks `/.well-known/changelog.json`, `/.well-known/releases.json`, `/.well-known/changelog.txt`, `/AGENTS.md`, and root-level `/changelog.md` or `/releases.md` files. Cascading — stops at the first tier that produces results.
- **Link relations** — detects `<link rel="changelog">`, `<link rel="releases">`, and `<link rel="release-notes">` tags in the page `<head>`
- **Sitemap parsing** — robots.txt → sitemap(s) → filter changelog-like URLs
- **Feed discovery** — RSS/Atom/JSON feed probing via HTML `<link>` tags and well-known feed paths
- **HTML link analysis** — scans the homepage for changelog-related links
- **GitHub repo enumeration** — lists repos with releases (when org has a linked GitHub handle)
- **Provider detection** — identifies hosting platforms (Mintlify, ReadMe, Zendesk, Intercom, Docusaurus, WordPress, etc.) via DNS, HTTP headers, and HTML signatures, then uses provider-specific hints for feed paths and crawl patterns

The `--verify` flag adds an AI verification pass (requires `ANTHROPIC_API_KEY`) that filters out false positives and suggests additional changelog URLs the automated methods may have missed — useful for sites where changelogs live on unexpected subdomains or paths.

### Web Frontend

Browse the catalog in your browser:

```bash
released api              # start the API server on :3456
cd web && bun run dev     # start the Next.js frontend on :3000
```

The API server exposes read-only JSON endpoints (`/api/stats`, `/api/orgs`, `/api/orgs/:slug/activity`, `/api/orgs/:slug/releases`, `/api/sources`, `/api/sources/:slug/activity`, `/api/search`). The frontend is a Next.js app in `web/` that fetches from the API. Configure the API URL for the frontend with `RELEASED_API_URL` (defaults to `http://localhost:3456`).

Production deployment: the API and frontend are deployed separately. The frontend will be hosted at [releases.sh](https://releases.sh).

### MCP Server

Start the MCP server for AI agent integration:

```bash
released serve
```

Claude Desktop config:

```json
{
  "mcpServers": {
    "released": {
      "command": "released",
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
| `add_source` | Add a new changelog source |
| `remove_source` | Remove a source and its releases |
| `fetch_source` | Trigger a fetch for a specific source by slug |
| `add_organization` | Create a new organization |
| `link_account` | Link a platform account to an organization |
| `list_ignored_urls` | List ignored URLs for an organization |
| `ignore_url` | Ignore a URL for an organization |
| `unignore_url` | Remove a URL from an org's ignore list |
| `list_blocked_urls` | List globally blocked URL patterns |
| `block_url` | Block a URL or domain globally |
| `unblock_url` | Remove a URL/domain from the global block list |
| `suppress_release` | Suppress a release from queries and search |
| `unsuppress_release` | Restore a suppressed release |

### Ignored URLs & Blocked URLs

Prevent unwanted sources from being re-discovered:

```bash
# Org-scoped: ignore a URL for a specific org (same URL can be valid for another org)
released ignore add https://example.com/blog --org vercel --reason "Not a changelog"
released ignore list --org vercel
released ignore remove https://example.com/blog --org vercel

# Global: block a URL or domain everywhere (spam, aggregators)
released block add medium.com --domain --reason "Aggregator, not primary source"
released block add https://spam.example.com/changelog --reason "SEO spam"
released block list
released block remove medium.com
```

When adding sources, both lists are checked automatically. The `remove --ignore` flag on source removal adds the URL to the org's ignore list.

### Release Suppression

Hide individual releases from queries without deleting them — useful when a source contains non-changelog content like promotional posts:

```bash
released release suppress rel_abc123 --reason "promotional content"
released release unsuppress rel_abc123
```

Suppressed releases are filtered from all read paths (search, latest, stats, API) but remain in the database and can be restored at any time.

### Release Management

View, edit, and delete individual releases:

```bash
released release show rel_abc123               # view full release details
released release show rel_abc123 --json        # machine-readable output

released release edit rel_abc123 --title "Fixed title" --version "v2.0.1"
released release edit rel_abc123 --content "Updated content"   # recomputes contentHash

released release delete rel_abc123             # delete by ID
released release delete --source next-js       # delete all releases for a source
released release delete --source next-js --before 2025-01-01
released release delete --before 2024-01-01    # prune old releases across all sources
```

### Release Summaries

AI-generated thematic summaries of release activity, produced automatically at fetch time:

```bash
released summarize next-js                # generate rolling summary (last 90 days)
released summarize next-js --window 30    # custom window
released summarize next-js --monthly      # generate last month's archive summary
released summarize next-js --json         # machine-readable output
released summarize next-js --force        # override opt-out
```

Summaries identify themes and directional trends rather than listing features — e.g., "Significant investment in developer tooling" rather than "shipped X, Y, Z." Rolling summaries are regenerated each fetch; monthly summaries are write-once archives.

**Opt-out:** Set `"summarize": false` in a source's metadata (`released edit <slug> --metadata '{"summarize": false}'`) or in an org's metadata to disable summary generation.

**Web app:** Source detail pages show a Highlights tab (default) with the rolling summary and monthly archives, alongside an All Releases tab with the full changelog.

### Source Health Checks

Probe source URLs to check availability and detect issues:

```bash
released check             # check all sources
released check next-js     # check one source
released check --json      # machine-readable output
```

Reports HTTP status, response time, and health classification (`healthy`, `degraded`, `error`). For feed sources, also probes the feed URL.

### Feed Change Detection

Lightweight check for upstream feed changes using HTTP HEAD requests — no content download or AI involved:

```bash
released poll                  # check all feed sources for changes
released poll next-js          # check a single source
released poll --changed        # only show sources with detected changes
released poll --json           # machine-readable output
```

Compares ETag, Last-Modified, and Content-Length headers against stored values to flag sources that have upstream changes available. The `fetch` command also uses HEAD as a pre-filter to skip unchanged feeds automatically.

### Fetch History

View recent fetch activity:

```bash
released fetch-log                   # recent fetch logs across all sources
released fetch-log next-js           # logs for one source
released fetch-log --limit 50        # more entries
released fetch-log --json            # machine-readable output
```

### Statistics

```bash
released stats             # index overview, source health, recent fetch activity
released stats --days 7    # adjust period
released stats --json      # machine-readable output
```

### Usage Tracking

```bash
released usage             # show API token usage summary
released usage --days 7    # last 7 days
```

## Architecture

- **TypeScript + Bun** — single package, compiles to a self-contained binary via `bun build --compile`
- **SQLite** (Bun built-in + Drizzle ORM) with WAL mode and FTS5 for search
- **Adapters** — GitHub Releases API, RSS/Atom/JSON Feed parser, Cloudflare Browser Rendering for scraping
- **AI Layer** — Anthropic SDK for changelog parsing (ingestion) and summarization (query)
- **Agent** — Unified Agent SDK agent (`src/agent/released.ts`) handles discovery, evaluation, and onboarding. Domain knowledge lives in skill files at `src/agent/skills/`. The deterministic fetch pipeline (ingest, incremental, enrich, summarize) stays as direct Messages API calls.
- **MCP Server** — `@modelcontextprotocol/sdk` on stdio
- **API Server** — Bun HTTP server with read-only JSON endpoints, CORS enabled
- **Web Frontend** — Next.js 15 (App Router) + Tailwind CSS in `web/`
- **Migrations** — Drizzle Kit (`bun run db:generate` to create, applied automatically at startup)

## Data Storage

Data is stored in `~/.released/released.db` (configurable via `RELEASED_DATA_DIR`).

## Deployment

All workers can be deployed from the project root:

```bash
bun run deploy               # deploy all workers (API + Discovery)
bun run deploy:api           # deploy API worker only
bun run deploy:discovery     # deploy Discovery worker only
bun run db:migrate:remote    # apply D1 migrations to production
```

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

The discovery worker's sandbox container runs compiled binaries — no Bun runtime, source tree, or node_modules. Build with `bun run build:all:linux` before deploying. The root `.dockerignore` uses an **allowlist pattern** — only `dist/released`, `dist/released-mcp-browser`, and `src/agent/skills/` are included. Old container images are not auto-pruned — use `wrangler containers images list` and `wrangler containers images delete` periodically to clean up.

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
