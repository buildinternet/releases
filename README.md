# Releases (monorepo)

[![CI](https://github.com/buildinternet/releases/actions/workflows/ci.yml/badge.svg)](https://github.com/buildinternet/releases/actions/workflows/ci.yml)
[![npm (CLI)](https://img.shields.io/npm/v/@buildinternet/releases?color=cb3837&label=%40buildinternet%2Freleases&logo=npm)](https://www.npmjs.com/package/@buildinternet/releases)

Private monorepo for the backend, workers, web frontend, and agent tooling behind [releases.sh](https://releases.sh).

The public CLI (`@buildinternet/releases`) lives in [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli) — that repo owns npm publishing, the Homebrew tap, and the user-facing install docs at [releases.sh/docs/installation](https://releases.sh/docs/installation). This monorepo still carries a full copy of the CLI source under `src/cli/` for local dev + admin workflows (see below); user-facing CLI changes should land in the OSS repo first.

## What's in this repo

- `src/` — Local CLI source (runs via `bun src/index.ts` or `bun link`), shared adapters, AI pipelines, and the local MCP server.
- `workers/api/` — Hono API backed by Cloudflare D1.
- `workers/discovery/` — Durable-Object-backed agent session orchestrator.
- `workers/mcp/` — Remote MCP server at `mcp.releases.sh`.
- `web/` — Next.js frontend for releases.sh.
- `packages/` — In-tree shared code (core, lib, adapters). The public subset is mirrored to the OSS repo and published as `@buildinternet/releases-*`.
- `plugins/claude/releases/` — Claude Code plugin (committed copy; skill source of truth is OSS `@buildinternet/releases-skills`).

## Development Setup

```bash
bun install
bun link           # register this package
bun link releases  # symlink `releases` into $HOME/.bun/bin
```

If `releases` isn't on your PATH after linking, add `$HOME/.bun/bin` to your shell's PATH:

```bash
export PATH="$HOME/.bun/bin:$PATH"
```

The linked binary runs `src/index.ts` via Bun, so edits are picked up immediately — no rebuild step. The `.env` at the repo root is auto-loaded, so `releases latest` routes to remote mode out of the box.

### Environment Variables

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — Required for AI-powered parsing and summaries
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` — Required for scraping changelog pages (only used as a fallback when no feed is available)
- `GITHUB_TOKEN` — Optional, increases GitHub API rate limits
- `RELEASED_API_URL` / `RELEASED_API_KEY` — Remote mode: route CLI data operations through the API Worker. Compiled binaries default to `https://api.releases.sh` when unset
- `VOYAGE_API_KEY` — Required on the API and MCP workers for semantic search ingest and queries. Provision the Vectorize indexes once with `./scripts/create-vectorize-indexes.sh`, then add `VOYAGE_API_KEY` to Cloudflare's Secrets Store and confirm both workers bind it in `workers/{api,mcp}/wrangler.jsonc` under `secrets_store_secrets`
- `EMBEDDING_PROVIDER` — Optional, defaults to `voyage` (`voyage-4-lite`, requested at 512 dims). Set to `openai` or `workers-ai` in `workers/{api,mcp}/wrangler.jsonc` to switch; recreate the indexes if vector dimensionality changes

## Usage

### Search

```bash
releases search "authentication"
releases search "vercel" --type releases --limit 5
releases search "breaking change" --json
```

Search is hybrid by default — FTS5 fused with vector similarity over both releases and chunked CHANGELOG files via Reciprocal Rank Fusion. The MCP `search_releases` tool and `GET /v1/search` endpoint accept `mode: "lexical"|"semantic"|"hybrid"` (default `hybrid`) and return a `kind` discriminator (`release` or `changelog_chunk`) on every hit; chunk hits include offset/length so agents can chain into `get_source_changelog` for surrounding context. Pass `mode: "lexical"` for the legacy FTS-only shape. A new `search_registry` MCP tool covers org/product/source lookup.

Source pages on the web (`releases.sh/<org>/<source>`) surface related releases and related sources in stacked rails below the release list, backed by the same vectors. The underlying routes — `GET /v1/related/releases` and `GET /v1/related/sources` — accept a `scope` of `org` (same organization) or `global`, and are also useful for third-party clients building recommendation UIs.

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
releases list --json --compact         # lightweight JSON (id, slug, name, type, org, date)
releases list --json --limit 20        # first 20 results as JSON
releases list --json --limit 20 --page 2  # paginated JSON output
```

Also available as `releases admin source list` for discoverability within admin workflows.

Use the top-level `show` command to inspect any entity by ID or slug. It
dispatches to the right entity based on the ID prefix (`rel_`, `src_`, `org_`,
`prod_`) and falls back to a slug lookup for bare strings:

```bash
releases show rel_XqbzLaOqBFz7VSAIqx2zs    # release details
releases show src_abc123                    # source summary
releases show org_abc123                    # org summary
releases show prod_abc123                   # product summary
releases show vercel                        # slug fallthrough (org → product → source)
```

For deeper operator views, use the admin commands (`admin org show <slug>`,
`admin product list <org>`, `admin release show <id>`).

`releases org overview <slug>` prints the full AI-generated overview for an
organization (`org show` shows just a preview). The output includes a
"generated X days ago" line and a stale warning when the overview is more
than 30 days old.

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

### Web Frontend

Browse the catalog in your browser:

```bash
releases admin api serve  # start the API server on :3456
cd web && bun run dev     # start the Next.js frontend on :3000
```

The API server exposes read-only JSON endpoints (`/api/stats`, `/api/orgs`, `/api/orgs/:slug/activity`, `/api/orgs/:slug/heatmap`, `/api/orgs/:slug/releases`, `/api/sources`, `/api/sources/:slug/activity`, `/api/search`). The frontend is a Next.js app in `web/` that fetches from the API. Configure the API URL for the frontend with `RELEASED_API_URL` (defaults to `http://localhost:3456`).

Production deployment: the API and frontend are deployed separately. The frontend will be hosted at [releases.sh](https://releases.sh).

### Claude Code Plugin

Install the plugin to get MCP tools, auto-triggering skills, and operational agents directly in Claude Code:

```bash
claude plugin add /path/to/released/plugins/claude/releases
```

Or load for a single session:

```bash
claude --plugin-dir plugins/claude/releases
```

The plugin includes:
- **MCP tools** — search releases, inspect orgs/products/sources, read stored CHANGELOGs (via `mcp.releases.sh`)
- **Skills** — auto-triggers on changelog/release questions, plus operational skills for source management
- **Agents** — `discovery` (finds and onboards sources) and `worker` (executes fetches)
- **Commands** — `/releases <product> [query]` for quick lookups

See [`plugins/claude/releases/README.md`](plugins/claude/releases/README.md) for full details.

### Standalone Skills (any agent)

The skills bundled with the plugin are also available as a standalone package. Install them into any Claude Code / Codex / Cursor / OpenCode workspace using the [`skills`](https://github.com/vercel-labs/skills) CLI, which reads from the OSS [`buildinternet/releases-cli`](https://github.com/buildinternet/releases-cli) repo (source of truth for `@buildinternet/releases-skills`):

```bash
npx skills add buildinternet/releases-cli
```

Use this when you want skill auto-triggering (on questions about releases or the `releases` CLI) without registering the hosted MCP connection, agents, and `/releases` command that the full plugin provides.

### MCP Server

Released is available as an MCP server for AI agent integration. There are two ways to connect:

#### Remote server (recommended)

Connect to the hosted MCP server at `https://mcp.releases.sh/mcp` — no installation or API keys required for read-only tools. The server is also listed in the [official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=sh.releases/mcp) as `sh.releases/mcp` (HTTP-domain auth against `releases.sh`). Metadata lives in `workers/mcp/server.json`; bump its `version` field when you want to publish an update — the `Deploy Workers` GitHub Action re-publishes automatically on merges that touch that file (gated on the `MCP_REGISTRY_PRIVATE_KEY_PEM` secret).

**General endpoint**

The hosted server uses Streamable HTTP at:

```text
https://mcp.releases.sh/mcp
```

Use that URL directly in clients with native remote MCP support. For clients that only support stdio MCP servers, use `mcp-remote` as a compatibility bridge.

**Client setup**

Claude Code:

```bash
claude mcp add --transport http releases https://mcp.releases.sh/mcp
```

Codex:

```bash
codex mcp add releases --url https://mcp.releases.sh/mcp
```

VS Code, Windsurf, Zed, and other stdio-only clients:

```json
{
  "mcpServers": {
    "releases": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://mcp.releases.sh/mcp"]
    }
  }
}
```

#### Local server

Run a local MCP server over stdio. In default mode it exposes the same read-oriented surface as the hosted MCP server. Admin/write tools are only registered when an API key is configured:

```bash
releases admin mcp serve
```

```json
{
  "mcpServers": {
    "releases": {
      "command": "releases",
      "args": ["admin", "mcp", "serve"],
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

| Tool | Description | Remote | Local |
|------|-------------|:------:|:-----:|
| `search_releases` | Hybrid lexical + semantic search across releases and CHANGELOG chunks (filter by product, org, `type`, or `mode`); each hit carries a `kind` discriminator | Yes | Yes |
| `search_registry` | Vector-backed search across orgs, products, and sources | Yes | Yes |
| `get_latest_releases` | Most recent releases (filter by product, org, or `type`) | Yes | Yes |
| `get_release` | Full content of a single release by id (accepts `rel_` prefix or bare nanoid) | Yes | Yes |
| `summarize_changes` | AI summary of a product's recent changes | Gated | Gated |
| `compare_products` | AI comparison between two products | Gated | Gated |
| `list_sources` | List all tracked sources | Yes | Yes |
| `get_source` | Detail for a single source with org/product linkage, release count, and whether a CHANGELOG file is stored | Yes | Yes |
| `get_source_changelog` | Canonical `CHANGELOG.md` stored for a GitHub source, with heading-aligned `offset` + `limit` (chars) or `tokens` (cl100k_base) slicing for Context7-style paging through large files | Yes | Yes |
| `list_organizations` | List all organizations with their linked sources | Yes | Yes |
| `get_organization` | Detailed view of a single org (accounts, tags, sources, products, aliases) | Yes | Yes |
| `list_products` | List products, optionally scoped to one organization | Yes | Yes |
| `get_product` | Detail for a single product with its organization, tags, and the sources grouped under it | Yes | Yes |
| `add_source` | Add a new changelog source from a URL | -- | Admin only |
| `remove_source` | Remove a source from the index | -- | Admin only |
| `fetch_source` | Fetch new releases from a source | -- | Admin only |
| `add_organization` | Create a new organization | -- | Admin only |
| `link_account` | Link a platform account to an organization | -- | Admin only |
| `suppress_release` / `unsuppress_release` | Hide or restore a release | -- | Admin only |
| `ignore_url` / `unignore_url` | Manage org-scoped URL ignore list | -- | Admin only |
| `block_url` / `unblock_url` / `list_blocked_urls` | Manage global URL block list | -- | Admin only |
| `list_ignored_urls` | List ignored URLs for an organization | -- | Admin only |

**Gated** = requires `ENABLE_AI_TOOLS=true`. These tools make Anthropic API calls and are disabled by default. Set the env var in the worker config or local environment to enable them.

#### In-browser (WebMCP)

When a visitor loads `releases.sh` in a browser that implements the emerging [WebMCP](https://webmachinelearning.github.io/webmcp/) API (Chrome's Early Preview Program today), the web app registers a read-only subset of the MCP tools on `navigator.modelContext` so browser-side AI agents can query the registry without setting up a remote MCP connection. Currently exposed: `search_releases`, `list_organizations`, `get_organization`, `get_source`, `get_release`, plus an `open_search_page` navigation helper. Implementation: `web/src/components/webmcp-provider.tsx`.

**Keep them in parity.** If you add, rename, or change a read-only tool in `workers/mcp/src/tools.ts` or the local stdio server in `src/mcp/`, update the WebMCP provider in the same PR. Write/admin tools stay remote-only — the browser can't hold an API key safely.

---

## Telemetry

The CLI and local MCP server record anonymous usage events so we can see which commands and tools are used. A stable anonymous ID is generated on first run and stored at `~/.releases/telemetry-id`. It is not tied to any account, email, or hostname.

**Collected:** command name (e.g. `search`, `admin source fetch`), CLI version, OS/arch, runtime, exit code, duration.

**Never collected:** arguments, flag values, paths, slugs, search queries, or any content you type.

**Opt out** at any time:

```bash
releases telemetry disable              # persistent opt-out
releases telemetry status               # show current state + anon ID
RELEASED_TELEMETRY_DISABLED=1 releases …  # one-off or CI opt-out
DO_NOT_TRACK=1 releases …                 # also respected
```

Events are posted best-effort to `POST /v1/telemetry` with a 1.5s timeout and silently dropped on failure, so telemetry never blocks commands or produces errors.

---

## Admin CLI

Operator workflows require an API key (`RELEASED_API_KEY`) and now live under `releases admin ...`.

### Add sources

```bash
releases admin source add "Next.js" --url https://github.com/vercel/next.js
releases admin source add "Linear" --url https://linear.app/changelog
releases admin source add --name "My Blog" --url https://example.com/changelog
```

The name can be a positional argument or passed via `--name`.

By default, `add` runs automated pre-checks that determine the best ingestion method for a URL. This includes provider detection (Mintlify, Docusaurus, etc.), feed discovery, and markdown suffix probing:
- **GitHub URLs** → uses the GitHub Releases API directly
- **Other URLs** → evaluates and stores the recommended method (feed, markdown, scrape, or crawl) so the first `fetch` already knows the optimal path

You can override detection with `--type github`, `--type scrape`, or `--type feed`. Use `--skip-eval` to bypass evaluation and fall back to basic heuristic detection. Batch mode (`--batch`) skips evaluation by default for speed.

If you know the feed URL and it isn't easily discoverable, provide it explicitly (skips evaluation):

```bash
releases admin source add "Claude Code" --url https://docs.anthropic.com/en/changelog \
  --feed-url https://docs.anthropic.com/en/changelog/rss.xml
```

To evaluate a URL without adding it as a source:

```bash
releases admin discovery evaluate https://linear.app/changelog
```

### Edit sources

The `edit` command accepts a source ID (`src_...`) or slug as its first argument. IDs are preferred — slugs can change, IDs are immutable.

```bash
releases admin source edit src_abc123 --name "New Name"    # by ID (preferred)
releases admin source edit next-js --url https://github.com/vercel/next.js/releases
releases admin source edit linear --name "Linear Changelog" --feed-url https://linear.app/rss/changelog.json
releases admin source edit my-blog --org acme               # set organization
releases admin source edit my-blog --no-org                # remove organization
releases admin source edit my-blog --type feed             # change adapter type
releases admin source edit my-blog --no-feed-url           # clear stored feed URL
releases admin source edit my-blog --markdown-url https://example.com/changelog.md
releases admin source edit my-blog --fetch-method markdown # set recommended fetch method
releases admin source edit my-blog --provider mintlify     # set detected provider
releases admin source edit my-blog --primary               # mark as org's primary changelog
releases admin source edit my-blog --no-primary            # unmark as primary
releases admin source edit my-blog --slug new-slug --confirm-slug-change  # rename slug (breaks web links)
```

Slug renames require `--confirm-slug-change` because they break existing web links and bookmarks at `releases.sh/<slug>`.

### Fetch releases

```bash
releases admin source fetch next-js     # one source (or: --source next-js)
releases admin source fetch --since 2025-01-01 --max 50
releases admin source fetch --max 500   # fetch up to 500 releases per source
releases admin source fetch --all       # no date/count limits
releases admin source fetch --stale 24  # only stale sources, with backoff
releases admin source fetch --retry-errors
releases admin source fetch --unfetched --concurrency 5
releases admin source fetch next-js --no-summarize
releases admin source fetch next-js --skip-changelog  # skip CHANGELOG.md fetch
```

By default, fetch caps at 200 releases per source to avoid API pagination limits (e.g., GitHub's 10K result cap). Use `--max <n>` to request more, or `--all` to remove the cap entirely.

For `github` sources, the root-level `CHANGELOG.md` (or `CHANGES.md` / `HISTORY.md` / `RELEASES.md` / `NEWS.md`) is fetched alongside tagged releases and surfaced on the web as a "Changelog" tab. Content is capped at 1MB and refresh piggybacks on every GitHub fetch — a content-hash short-circuit means unchanged files skip writes. Use `--skip-changelog` to opt out for a single run, or run `releases admin source refresh-changelog <slug>` to refresh manually (local mode only; the API worker cron handles remote mode).

Read a tracked CHANGELOG directly, with optional heading-aligned slicing for large files:

```bash
releases admin source changelog apollo-client                         # full file to stdout
releases admin source changelog apollo-client --limit 10000           # first 10k chars, ending at a heading
releases admin source changelog apollo-client --tokens 5000           # first ~5k tokens (cl100k_base), ending at a heading
releases admin source changelog apollo-client --offset 10000 --json   # next chunk as JSON
```

The same slicing is exposed over the API and MCP: `GET /v1/sources/:slug/changelog?offset=&limit=&tokens=` and the `get_source_changelog` MCP tool. Char mode (`limit`) and token mode (`tokens`) are both heading-aware; `tokens` wins when both are passed. Every response reports `totalTokens` (cached per file) and, in token mode, `sliceTokens` for the returned chunk so agents can budget context windows precisely. Chain successive requests by feeding the returned `nextOffset` back as the next `offset`. Recommended brackets: 2000 / 5000 / 10000 / 20000 tokens. Useful for agent-friendly access to large files (e.g. Apollo Client's 700KB CHANGELOG).

> **Remote mode:** bare `releases admin source fetch` (no slug or filter) is blocked to prevent expensive bulk operations. Use `--stale`, `--unfetched`, `--retry-errors`, or a source slug. Remote concurrency defaults to 3 (max 5). Duplicate source fetches are detected and blocked.

### Smart fetch

```bash
releases admin source fetch --stale 24
releases admin source fetch --retry-errors
```

Sources that repeatedly return no changes back off automatically (1h → 2h → 4h → ... up to 48h). Error backoff caps at 72h. Successful fetches reset all counters. Paused sources (`fetchPriority = "paused"`) are always skipped by `--stale`. The default 200-release cap applies to smart fetch as well — use `--max` to adjust per-run.

### Crawl mode

For changelogs spread across multiple pages, crawl mode follows links and parses each page individually:

```bash
releases admin source fetch linear --crawl
releases admin source fetch linear --crawl --crawl-pattern "https://linear.app/changelog/*"
releases admin source fetch linear --no-crawl
```

Crawl mode persists on the source — subsequent `releases admin source fetch linear` calls will automatically crawl. Only works with `scrape` sources.

### Feed change detection

```bash
releases admin source poll                  # check all feed sources for changes
releases admin source poll next-js          # check a single source
releases admin source poll --changed        # only show sources with detected changes
```

In remote mode, the API worker polls on an hourly cron and directly fetches sources with a usable feed path; scrape sources without a feed are flagged and drained daily at 01:00 UTC via a managed-agent sweep (runbook in [`docs/architecture/coverage.md`](docs/architecture/coverage.md#cron-observability)). `releases admin source fetch --changed` is still available to drain the backlog manually.

### Organizations

Group sources under organizations for aggregate queries:

```bash
releases admin org add "Vercel"
releases admin org link vercel --platform github --handle vercel
releases admin source add "Next.js" --type github --url https://github.com/vercel/next.js --org vercel
releases admin org list                                    # summary: name, domain, counts
releases admin org show vercel                             # full details: accounts, tags, sources
```

### Products

Group sources under products within an organization — useful for multi-product orgs like Vercel (Next.js, Turborepo, v0):

```bash
releases admin product add "Next.js" --org vercel --url https://nextjs.org
releases admin product add "Turborepo" --org vercel --url https://turbo.build
releases admin product list vercel
releases admin product edit nextjs --description "React framework for production"
releases admin product remove nextjs              # sources become unlinked, not deleted
```

Convert an org that should be a product:

```bash
releases admin product adopt nextjs --into vercel
```

### Domain aliases

```bash
releases admin org alias add anthropic claude.ai claude.com
releases admin product alias add nextjs nextjs.org
```

### Categories & tags

```bash
releases admin org add "Acme" --category cloud --tags typescript,edge
releases admin org tag add acme react serverless
releases admin product tag add acme-cli testing
releases list --category ai
```

### Import sources from manifest

Bulk-import organizations and sources from a JSON file:

```bash
releases admin source import manifest.json
releases admin source import manifest.json --dry-run
releases admin source import manifest.json --skip-existing
```

### AI-powered onboarding

Use the AI agent to discover, validate, and add changelog sources for a company:

```bash
releases admin discovery onboard "Vercel"
releases admin discovery onboard "Stripe" --domain stripe.com --github-org stripe
```

### Discover sources

Automatically find changelog and release-note pages for a domain:

```bash
releases admin discovery discover vercel.com
releases admin discovery discover vercel.com --verify
releases admin discovery discover vercel.com --add
```

### Ignored URLs & blocked URLs

```bash
releases admin policy ignore add https://example.com/blog --org vercel --reason "Not a changelog"
releases admin policy ignore list --org vercel
releases admin policy block add medium.com --domain --reason "Aggregator"
releases admin policy block list
```

### Release management

```bash
releases admin release show rel_abc123
releases admin release edit rel_abc123 --title "Fixed title" --version "v2.0.1"
releases admin release delete rel_abc123
releases admin release suppress rel_abc123 --reason "promotional content"
```

### Release summaries

AI-generated thematic summaries, produced automatically at fetch time:

```bash
releases admin content summary generate next-js                # rolling summary
releases admin content summary generate next-js --window 30    # custom window
releases admin content summary generate next-js --monthly      # last month's archive summary
```

### Source health checks

```bash
releases admin source check             # check all sources
releases admin source check next-js     # check one source
```

### Fetch history

```bash
releases admin source fetch-log                   # recent fetch logs across all sources
releases admin source fetch-log next-js           # logs for one source
```

### Task management

Manage remote fetch and discovery sessions (requires remote mode):

```bash
releases admin discovery task list
releases admin discovery task cancel <sessionId>
```

## Architecture

- **CLI** — TypeScript, compiles to a self-contained binary. Source here is kept in sync with [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli), which publishes `@buildinternet/releases` on npm with platform-specific packages (macOS arm64/x64, Linux x64/arm64) plus the Homebrew tap
- **Storage** — Local SQLite with full-text search; remote mode backed by a hosted database via the API worker
- **Adapters** — GitHub Releases API, RSS/Atom/JSON Feed parser, and headless-browser scraping for pages without feeds
- **AI Layer** — changelog parsing (ingestion) and summarization (query) via AI provider SDK calls
- **Agents** — two agents power discovery and fetch work: a discovery agent for onboarding/evaluation and a worker agent for fetches/updates. Agent definitions (system prompt, tools, skills, model) are synced via `bun run deploy:agents`. The deterministic fetch pipeline (ingest, incremental, summarize) runs as direct SDK calls
- **MCP Server** — Local: stdio transport. Remote: hosted at `mcp.releases.sh` with read-only tools, no auth required
- **API Server** — JSON endpoints with CORS. GET endpoints are public; write operations require a Bearer token
- **Web Frontend** — Next.js app in `web/`

## Data Storage

Data is stored in `~/.releases/releases.db` (configurable via `RELEASED_DATA_DIR`).

## Deployment

Workers auto-deploy on merges to `main` via `.github/workflows/deploy-workers.yml` — the workflow path-filters so only the workers whose code changed are rebuilt. The workflow also exposes `workflow_dispatch` so any worker (or all three) can be redeployed manually from the Actions tab. Managed agents, skills, and D1 migrations stay manual (they change AI behavior or schema and need human review).

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
bun run db:migrate:remote    # apply D1 migrations to production
```

### Publishing the CLI

npm publishing, GitHub Release binaries, and the Homebrew tap all happen from [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli) via Changesets. There are no publish scripts in this repo — user-facing CLI changes go to the OSS repo first.

Local development:

```bash
bun run db:migrate:local     # apply D1 migrations (required before first dev:api run)
bun run api                  # start local API server on :3456 (uses local SQLite)
bun run dev:web              # start Next.js frontend on :3000
bun run dev:api              # start API worker locally on :8787 (uses local D1)
bun run dev:discovery        # start Discovery worker locally (Cloudflare)
bun run dev:mcp              # start MCP worker locally (Cloudflare)
```

To use the Cloudflare worker API locally with the web frontend, set `RELEASED_API_URL=http://localhost:8787` in `web/.env.local`. The default (`localhost:3456`) uses the Bun-based local API server backed by SQLite.

Workers live in `workers/api/` (Hono API backed by D1), `workers/discovery/` (Durable Objects + Sandbox for agent-driven source discovery), and `workers/mcp/` (remote MCP server). All three share the same D1 database.

The discovery worker supports two engines: **managed agents** (default, Anthropic-hosted) and **sandbox** (Cloudflare container). Managed agents sessions run as Durable Objects that stream events from the Anthropic API. The sandbox path runs compiled binaries in a container — build with `bun run build:all:linux` before deploying.

After changing agent tools, system prompt, or skills, run `bun run deploy:agents` to sync both Anthropic-hosted agent definitions. Use `deploy:agents:discovery` or `deploy:agents:worker` to target a single agent. The script tracks content hashes for prompt and tools to avoid unnecessary updates. State is stored in `scripts/agent-skills.json`.

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
bun test                     # run all tests (evals are excluded by design)
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
  integration/          # adapter tests with fixture HTTP servers
  cli/                  # end-to-end tests that shell out to the real CLI
  api/                  # API middleware and content negotiation tests
  evals/                # AI eval suites (see below)
```

Type-check tests separately (they have their own tsconfig):

```bash
npx tsc --noEmit --project tests/tsconfig.json
```

### Evals

Eval suites measure the quality of AI-powered features — changelog parsing, source evaluation, and agent discovery. They call real AI models and are not part of the normal test run.

```bash
bun run eval                 # run all evals
bun run eval:parsing         # parsing pipeline evals (~2 min, needs ANTHROPIC_API_KEY)
bun run eval:evaluation      # URL evaluation evals (~30 sec, no API key needed)
bun run eval:discovery       # agent discovery evals (~3 min/company, ~$2/company)
```

Evals use the same models as production (`config.ingestModel()` for parsing, `config.agentModel()` for discovery). Override with env vars to compare models:

```bash
RELEASED_INGEST_MODEL=claude-sonnet-4-6 bun run eval:parsing
```

**Fixtures** live in `tests/evals/fixtures/`:

- `changelogs/` — markdown + expected JSON pairs for parsing evals. Each `.expected.json` is a grading spec with fields like `contentContains`, `mediaCountMin`, and `isBreaking` that enable code-based grading of structured AI output.
- `discovery/` — company JSON files with expected sources and products for discovery evals.

**Results** are saved to `tests/evals/results/` (gitignored) as timestamped JSON for tracking scores over time.
