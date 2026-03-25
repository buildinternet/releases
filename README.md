# Released

A Context7-style changelog indexer for AI agents and developers. Fetches, normalizes, and indexes release notes from GitHub releases and product changelog pages, then exposes them via an MCP server, CLI, or (eventually) a web viewer.

## Setup

```bash
bun install
```

### Environment Variables

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — Required for AI-powered parsing and summaries
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` — Required for scraping changelog pages
- `GITHUB_TOKEN` — Optional, increases GitHub API rate limits

## Usage

### Add sources

```bash
bun src/index.ts add "Next.js" --type github --url https://github.com/vercel/next.js
bun src/index.ts add "Vercel" --type scrape --url https://vercel.com/changelog
```

### Fetch releases

```bash
bun src/index.ts fetch           # all sources
bun src/index.ts fetch next-js   # one source
```

### Query

```bash
bun src/index.ts search "authentication"
bun src/index.ts latest --count 5
bun src/index.ts latest next-js
bun src/index.ts summary next-js --days 30
bun src/index.ts compare next-js vercel --days 30
```

### MCP Server

Start the MCP server for AI agent integration:

```bash
bun src/index.ts serve
```

Claude Desktop config:

```json
{
  "mcpServers": {
    "released": {
      "command": "bun",
      "args": ["src/index.ts", "serve"],
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

## Architecture

- **TypeScript + Bun** — single package, one CLI binary
- **SQLite** (Bun built-in + Drizzle ORM) with WAL mode and FTS5 for search
- **Adapters** — GitHub Releases API, Cloudflare Browser Rendering for scraping
- **AI Layer** — Anthropic SDK for changelog parsing (ingestion) and summarization (query)
- **MCP Server** — `@modelcontextprotocol/sdk` on stdio

## Data Storage

Data is stored in `~/.released/released.db` (configurable via `RELEASED_DATA_DIR`).
