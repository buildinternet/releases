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

### Fetch releases

```bash
released fetch             # all sources
released fetch next-js     # one source
released fetch --since 2025-01-01 --max 50
released fetch --all       # no date/count limits
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
- **Migrations** — Drizzle Kit (`bun run db:generate` to create, applied automatically at startup)

## Data Storage

Data is stored in `~/.released/released.db` (configurable via `RELEASED_DATA_DIR`).

## Development

```bash
bun src/index.ts <command>   # run directly without linking
npx tsc --noEmit             # type-check
bun run db:generate          # generate migration after schema change
```
