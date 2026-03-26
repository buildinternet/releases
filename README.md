# Released

A Context7-style changelog indexer for AI agents and developers. Fetches, normalizes, and indexes release notes from GitHub releases, RSS/Atom/JSON feeds, and product changelog pages, then exposes them via an MCP server or CLI.

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

## Usage

### Add sources

```bash
released add "Next.js" --url https://github.com/vercel/next.js
released add "Linear" --url https://linear.app/changelog
released add "My Blog" --url https://example.com/changelog
```

The source type is auto-detected from the URL:
- **GitHub URLs** → uses the GitHub Releases API
- **Other URLs** → probes for an RSS/Atom/JSON feed, then uses the scrape adapter (feed-first with Cloudflare + AI fallback)

You can override detection with `--type github`, `--type scrape`, or `--type feed` if needed. Discovered feed URLs are cached so subsequent fetches skip discovery.

If you know the feed URL and it isn't easily discoverable, provide it explicitly:

```bash
released add "Claude Code" --url https://docs.anthropic.com/en/changelog \
  --feed-url https://docs.anthropic.com/en/changelog/rss.xml
```

### Edit sources

```bash
released edit next-js --url https://github.com/vercel/next.js/releases
released edit linear --name "Linear Changelog" --feed-url https://linear.app/rss/changelog.json
released edit my-blog --org acme               # set organization
released edit my-blog --no-org                  # remove organization
released edit my-blog --type feed               # change adapter type
released edit my-blog --no-feed-url             # clear stored feed URL
```

### Fetch releases

```bash
released fetch             # all sources
released fetch next-js     # one source
released fetch --since 2025-01-01 --max 50
released fetch --all       # no date/count limits
```

### Crawl mode

For changelogs spread across multiple pages, crawl mode follows links and parses each page individually:

```bash
released fetch linear --crawl                    # enable crawl, auto-detect pattern
released fetch linear --crawl --crawl-pattern "https://linear.app/changelog/*"
released fetch linear --no-crawl                 # one-off skip, keeps setting
```

Crawl mode persists on the source — subsequent `released fetch linear` calls will automatically crawl. Only works with `scrape` sources.

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

The API server exposes read-only JSON endpoints (`/api/stats`, `/api/orgs`, `/api/sources`, `/api/search`). The frontend is a Next.js app in `web/` that fetches from the API. Configure the API URL for the frontend with `RELEASED_API_URL` (defaults to `http://localhost:3456`).

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

- **TypeScript + Bun** — single package, one CLI binary
- **SQLite** (Bun built-in + Drizzle ORM) with WAL mode and FTS5 for search
- **Adapters** — GitHub Releases API, RSS/Atom/JSON Feed parser, Cloudflare Browser Rendering for scraping
- **AI Layer** — Anthropic SDK for changelog parsing (ingestion) and summarization (query)
- **MCP Server** — `@modelcontextprotocol/sdk` on stdio
- **API Server** — Bun HTTP server with read-only JSON endpoints, CORS enabled
- **Web Frontend** — Next.js 15 (App Router) + Tailwind CSS in `web/`
- **Migrations** — Drizzle Kit (`bun run db:generate` to create, applied automatically at startup)

## Data Storage

Data is stored in `~/.released/released.db` (configurable via `RELEASED_DATA_DIR`).

## Development

```bash
bun src/index.ts <command>   # run directly without linking
npx tsc --noEmit             # type-check (CLI)
cd web && npx tsc --noEmit   # type-check (frontend)
bun run db:generate          # generate migration after schema change
```
