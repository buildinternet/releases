# Released — Changelog Indexer Design

## Problem

There's no centralized, AI-queryable source for "what recently changed in product X?" Changelogs live scattered across GitHub releases and product blogs in inconsistent formats. AI agents and developers waste time navigating these manually.

## Solution

Released is a Context7-style tool for changelogs. It fetches, normalizes, and indexes release notes from multiple source types, then exposes them via an MCP server (primary), CLI, and eventually a web viewer. An AI layer handles parsing diverse formats and summarizing/comparing releases on query.

## Architecture

Single TypeScript + Node.js package. One CLI binary handles source management, fetching, serving MCP, and querying. SQLite is the sole data store.

```
Sources (GitHub Releases, Scraped Changelog Pages)
  → Adapters (fetch raw content)
    → AI Ingestion Agent (parse & structure)
      → SQLite (indexed storage, FTS5 for search)
        → MCP Server / CLI (query interfaces)
          → AI Query Agent (summarize & compare on demand)
```

## Data Model

### `sources` table

| Column          | Type        | Notes                                         |
| --------------- | ----------- | --------------------------------------------- |
| id              | INTEGER PK  | Auto-increment                                |
| name            | TEXT        | Display name (e.g. "Vercel")                  |
| slug            | TEXT UNIQUE | URL-safe identifier                           |
| type            | TEXT        | `github` \| `scrape`                          |
| url             | TEXT        | Source URL                                    |
| metadata        | TEXT (JSON) | Type-specific config (e.g. GitHub owner/repo) |
| created_at      | TEXT        | ISO 8601                                      |
| last_fetched_at | TEXT        | ISO 8601, nullable                            |

### `releases` table

| Column          | Type        | Notes                                                      |
| --------------- | ----------- | ---------------------------------------------------------- |
| id              | INTEGER PK  | Auto-increment                                             |
| source_id       | INTEGER FK  | References sources.id                                      |
| version         | TEXT        | Nullable — not all changelogs have versions                |
| title           | TEXT        | Release title                                              |
| content         | TEXT        | Raw markdown/text of the release                           |
| content_summary | TEXT        | AI-generated concise summary                               |
| url             | TEXT        | Link to original release                                   |
| content_hash    | TEXT        | SHA-256 of normalized title+version+published_at for dedup |
| metadata        | TEXT (JSON) | Extensible metadata (e.g. isBreaking, image URLs)          |
| published_at    | TEXT        | ISO 8601                                                   |
| fetched_at      | TEXT        | ISO 8601                                                   |

**Constraints:**

- `UNIQUE(source_id, url)` — primary dedup key
- `UNIQUE(source_id, content_hash)` — fallback dedup via SHA-256 hash of normalized title+version+published_at
- Index on `source_id, published_at DESC` — for latest/summary queries
- Index on `published_at DESC` — for cross-source latest queries

### `releases_fts` virtual table (FTS5)

SQLite FTS5 virtual table for full-text search across releases. Indexes `title`, `content`, and `content_summary` columns. Kept in sync via INSERT/DELETE triggers on the `releases` table. Managed via raw SQL (Drizzle ORM does not support FTS5 natively — use the `sql` template tag for creation and queries).

**Future additions:** `tags` table for categorization (feature, fix, breaking), `images` column or related table for screenshots/media, RSS adapter.

Image URLs encountered during ingestion are preserved as markdown links in `content`. Later phases can fetch and cache them locally.

## Source Adapters

Common interface:

```typescript
interface RawRelease {
  version?: string;
  title: string;
  content: string; // raw markdown/HTML
  url?: string;
  publishedAt?: Date;
}

interface Adapter {
  fetch(source: Source): Promise<RawRelease[]>;
}
```

### GitHub Adapter

- Calls `GET /repos/{owner}/{repo}/releases` via GitHub REST API
- Parses owner/repo from the source URL
- Handles pagination via Link header
- Supports `GITHUB_TOKEN` env var for rate limit headroom (60 req/hr unauthenticated, 5000 with token)
- Returns structured data directly — AI ingestion agent not needed for this adapter

### Scrape Adapter

- Uses Cloudflare Browser Rendering `/markdown` endpoint to convert changelog pages to clean markdown
- Handles JS-rendered pages that simple HTTP fetches would miss
- The AI ingestion agent then parses the markdown into individual release entries
- Requires `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` env vars

**Paginated changelogs via `/crawl`:**
The Cloudflare `/crawl` endpoint is asynchronous — POST returns a job ID, results are polled via GET. The scrape adapter handles this with a polling loop:

1. POST to `/crawl` with the source URL and page limit
2. Poll the job status endpoint every 5 seconds (configurable), with a 5-minute timeout
3. On completion, collect all crawled pages and concatenate the markdown
4. Pass the combined markdown to the AI ingestion agent for parsing

The `released fetch` command blocks during polling (with a spinner on stderr). Job IDs are not persisted — if the process is interrupted, the fetch is simply retried next time.

**Future adapter:** RSS/Atom feeds can be added later as a third adapter type for sources that provide structured feeds.

## AI Layer

Two distinct roles, using the Anthropic SDK (`@anthropic-ai/sdk`):

### Ingestion Agent (fetch-time)

- Takes raw markdown content from the scrape adapter (GitHub adapter returns structured data, no AI needed)
- Critical for scraped changelogs where a single page may contain many releases
- Uses Haiku for speed and cost (configurable via env var)

**Expected output schema (via tool use for structured output):**

```typescript
interface ParsedRelease {
  version?: string; // e.g. "v1.2.3", null if not versioned
  title: string; // release title or heading
  content: string; // the release body as markdown
  publishedAt?: string; // ISO 8601 date if found
  isBreaking: boolean; // whether it contains breaking changes
}
// The agent returns ParsedRelease[] — one entry per release found on the page
```

The `isBreaking` flag is stored in the `metadata` JSON column (added to releases table) for future filtering. The `content` field preserves image URLs as markdown links.

### Query Agent (query-time)

- `summarizeReleases(releases[])` — concise summary of what changed
- `compareProducts(releasesA[], releasesB[])` — trend comparison across products
- Uses Sonnet for quality (configurable via env var)

Cost is bounded: AI calls only on ingestion (per fetch) and queries (per user action).

## CLI Interface

Built with `commander`. Sources managed via CLI, stored in SQLite.

```
released add <name> --type github|scrape --url <url> [--slug <slug>]
released remove <slug>
released list

released fetch [slug]          # fetch all or one source

released search <query>        # full-text search across releases (FTS5)
released latest [slug]         # most recent releases
released summary <slug>        # AI summary of recent changes
released compare <slug> <slug> # AI comparison of two products

released serve                 # start MCP server on stdio
```

**Slug resolution:** CLI commands reference sources by slug. Slug is auto-derived from the display name (lowercased, spaces/special chars to hyphens, e.g. "Next.js" → "next-js"). User can override via `--slug` on `released add`. Duplicate slugs are rejected at insert time.

## MCP Server

Integrated into the CLI as `released serve`. Runs on stdio via `StdioServerTransport`. Registered tools:

| Tool                  | Input                   | Description                      |
| --------------------- | ----------------------- | -------------------------------- |
| `search_releases`     | query, product?, limit? | Full-text search across releases |
| `get_latest_releases` | product?, count?        | Most recent releases             |
| `summarize_changes`   | product, days?          | AI summary of recent changes     |
| `compare_products`    | products[], days?       | Trend comparison                 |
| `list_products`       | —                       | All tracked sources              |

Claude Desktop config:

```json
{
  "mcpServers": {
    "released": {
      "command": "npx",
      "args": ["released", "serve"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-...",
        "CLOUDFLARE_ACCOUNT_ID": "...",
        "CLOUDFLARE_API_TOKEN": "..."
      }
    }
  }
}
```

**Note:** Claude Desktop spawns MCP servers as child processes that do not inherit the user's shell environment on macOS. Required env vars must be specified in the `env` block above, or the MCP server will fail silently on AI/scrape operations. During development, use `node dist/index.js serve` or `npm link` instead of `npx`.

## Key Technical Decisions

- **SQLite WAL mode** — enables concurrent reads (MCP server) + writes (CLI fetch) without locking
- **All logging to stderr** — stdout is reserved for MCP JSON-RPC when in serve mode
- **Deduplication** — enforced at DB level via `UNIQUE(source_id, url)` and `UNIQUE(source_id, content_hash)` constraints. On conflict, skip the duplicate.
- **Data directory** — `~/.released/` stores the SQLite DB
- **Build tooling** — tsup for bundling, vitest for tests, drizzle-orm + drizzle-kit for typed schema and migrations

## NPM Packages

| Package                          | Purpose                                 |
| -------------------------------- | --------------------------------------- |
| `commander`                      | CLI framework                           |
| `drizzle-orm` + `better-sqlite3` | SQLite with type-safe queries           |
| `drizzle-kit`                    | Schema migrations                       |
| `@modelcontextprotocol/sdk`      | MCP server                              |
| `zod`                            | Schema validation (required by MCP SDK) |
| `@anthropic-ai/sdk`              | AI ingestion and query agents           |
| `dayjs`                          | Date normalization                      |
| `chalk` + `cli-table3`           | Terminal output formatting              |
| `tsup`                           | TypeScript bundler                      |
| `vitest`                         | Testing                                 |

## File Structure

```
src/
  index.ts                    # CLI entry point
  db/
    connection.ts             # SQLite connection + WAL mode
    schema.ts                 # Drizzle table definitions
    migrate.ts                # Auto-migration on startup
  cli/
    program.ts                # Commander program definition
    commands/
      add.ts, remove.ts, list.ts, fetch.ts,
      search.ts, latest.ts, summary.ts, compare.ts,
      serve.ts
  adapters/
    types.ts                  # Shared adapter interface
    github.ts, scrape.ts
  ai/
    client.ts                 # Anthropic SDK factory
    ingest.ts                 # Ingestion agent
    query.ts                  # Query agent (summarize, compare)
  mcp/
    server.ts                 # McpServer setup
    tools/
      search-releases.ts, get-latest-releases.ts,
      summarize-changes.ts, compare-products.ts,
      list-products.ts
  lib/
    config.ts                 # Env vars, data directory
    errors.ts                 # Custom error types
    logger.ts                 # Stderr-only logger
```

## Environment Variables

| Variable                | Required           | Default                     | Notes                                          |
| ----------------------- | ------------------ | --------------------------- | ---------------------------------------------- |
| `ANTHROPIC_API_KEY`     | Yes                | —                           | For AI ingestion and query agents              |
| `CLOUDFLARE_ACCOUNT_ID` | For scrape sources | —                           | Cloudflare Browser Rendering                   |
| `CLOUDFLARE_API_TOKEN`  | For scrape sources | —                           | Needs "Browser Rendering - Edit" permission    |
| `GITHUB_TOKEN`          | No                 | —                           | Increases GitHub API rate limit to 5000 req/hr |
| `RELEASED_DATA_DIR`     | No                 | `~/.released`               | Override data directory                        |
| `RELEASED_INGEST_MODEL` | No                 | `claude-haiku-4-5-20251001` | Model for ingestion agent                      |
| `RELEASED_QUERY_MODEL`  | No                 | `claude-sonnet-4-6`         | Model for query agent                          |

## Risks

- **Cloudflare free tier limits** — Cache aggressively, only re-scrape when stale. Tool remains useful without scrape adapter.
- **Diverse changelog formats** — AI ingestion agent handles this, but needs good system prompts with examples of single-release and multi-release pages.
- **GitHub rate limits** — Support GITHUB_TOKEN, implement basic backoff on 429 responses.
- **SQLite concurrency** — WAL mode handles the MCP-server-running + CLI-fetching scenario.

## Web Viewer (Deferred)

A minimal read-only web UI showing tracked products, release timelines, and search. Not in initial build. When added, it will be served via `released web` as a simple Express/static server reading from the same SQLite DB.
