# Releases (monorepo)

[![CI](https://github.com/buildinternet/releases/actions/workflows/ci.yml/badge.svg)](https://github.com/buildinternet/releases/actions/workflows/ci.yml)
[![npm (CLI)](https://img.shields.io/npm/v/@buildinternet/releases?color=cb3837&label=%40buildinternet%2Freleases&logo=npm)](https://www.npmjs.com/package/@buildinternet/releases)

Private monorepo for the backend, workers, web frontend, and agent tooling behind [releases.sh](https://releases.sh).

The user-facing CLI (`@buildinternet/releases`) lives in [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli). That repo owns npm publishing, the Homebrew tap, and the install docs at [releases.sh/docs/installation](https://releases.sh/docs/installation). All CLI changes — user-facing commands and operator/admin flows — land there. This monorepo talks to the world over HTTP via the API worker.

## What's in this repo

- `workers/api/` — Hono API backed by Cloudflare D1 (the authoritative data plane).
- `workers/discovery/` — Durable-Object-backed agent session orchestrator.
- `workers/mcp/` — Remote MCP server at `mcp.releases.sh`.
- `workers/webhooks/` — Outbound webhook consumer: signs and delivers `release.created` events to subscribed endpoints with HMAC-SHA256, retry/DLQ via Cloudflare Queues, and a 7-day replay window. See [docs/webhooks.md](docs/webhooks.md).
- `web/` — Next.js frontend for releases.sh.
- `packages/` — In-tree shared code. `packages/core/` publishes `@buildinternet/releases-core` (schema + pure helpers shared with the OSS CLI). `packages/core-internal/`, `packages/lib/`, `packages/adapters/`, `packages/ai/` are private workspaces. `packages/lib/src/logger.ts` is also published via the OSS CLI as `@buildinternet/releases-lib/logger`.
- `src/agent/` — Managed-agents discovery + worker harness (invoked by the discovery worker's Durable Object).
- `plugins/claude/releases/` — Claude Code plugin (committed copy; skill source of truth is OSS `@buildinternet/releases-skills`).

## Development Setup

```bash
bun install
```

Working in a git worktree? Run `./scripts/setup-worktree.sh` once after `git worktree add` — it installs dependencies and copies `.env` + `web/.env.local` from the main checkout. Claude Code sessions trigger the dependency install automatically via a `SessionStart` hook; the script is for terminal-driven bootstraps.

The monorepo no longer ships a local CLI. If you need `releases <cmd>` while working on backend changes, clone [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli) alongside this repo and point it at a local API worker (`bun run dev:api`) via `RELEASED_API_URL=http://localhost:8787`.

### Environment Variables

Copy `.env.example` to `.env` and fill in:

- `ANTHROPIC_API_KEY` — Required for AI-powered parsing and summaries
- `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` — Required for scraping changelog pages (only used as a fallback when no feed is available)
- `GITHUB_TOKEN` — Optional, increases GitHub API rate limits
- `RELEASED_API_URL` / `RELEASED_API_KEY` — Remote mode: route CLI data operations through the API Worker. Compiled binaries default to `https://api.releases.sh` when unset
- `VOYAGE_API_KEY` — Required on the API and MCP workers for semantic search ingest and queries. Provision the Vectorize indexes once with `./scripts/create-vectorize-indexes.sh`, then add `VOYAGE_API_KEY` to Cloudflare's Secrets Store and confirm both workers bind it in `workers/{api,mcp}/wrangler.jsonc` under `secrets_store_secrets`
- `EMBEDDING_PROVIDER` — Optional, defaults to `voyage` (`voyage-4-lite`, requested at 512 dims). Set to `openai` or `workers-ai` in `workers/{api,mcp}/wrangler.jsonc` to switch; recreate the indexes if vector dimensionality changes

## Consumer surfaces

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

**MCP Tools:**

| Tool                   | Description                                                                                                                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `search_releases`      | Hybrid lexical + semantic search across releases and CHANGELOG chunks (filter by product, org, `type`, or `mode`); each hit carries a `kind` discriminator                           |
| `search_registry`      | Vector-backed search across orgs, products, and sources                                                                                                                              |
| `get_latest_releases`  | Most recent releases (filter by product, org, or `type`)                                                                                                                             |
| `get_release`          | Full content of a single release by id (accepts `rel_` prefix or bare nanoid)                                                                                                        |
| `summarize_changes`    | AI summary of a product's recent changes (gated)                                                                                                                                     |
| `compare_products`     | AI comparison between two products (gated)                                                                                                                                           |
| `list_sources`         | List all tracked sources                                                                                                                                                             |
| `get_source`           | Detail for a single source with org/product linkage, release count, and whether a CHANGELOG file is stored                                                                           |
| `get_source_changelog` | Canonical `CHANGELOG.md` stored for a GitHub source, with heading-aligned `offset` + `limit` (chars) or `tokens` (cl100k_base) slicing for Context7-style paging through large files |
| `list_organizations`   | List all organizations with their linked sources                                                                                                                                     |
| `get_organization`     | Detailed view of a single org (accounts, tags, sources, products, aliases)                                                                                                           |
| `list_products`        | List products, optionally scoped to one organization                                                                                                                                 |
| `get_product`          | Detail for a single product with its organization, tags, and the sources grouped under it                                                                                            |

**Gated** = requires `ENABLE_AI_TOOLS=true`. These tools make Anthropic API calls and are disabled by default. Set the env var in the worker config. Admin/write flows (adding sources, fetching, suppressing releases, etc.) live behind the API worker's bearer-auth endpoints, not MCP.

#### In-browser (WebMCP)

When a visitor loads `releases.sh` in a browser that implements the emerging [WebMCP](https://webmachinelearning.github.io/webmcp/) API (Chrome's Early Preview Program today), the web app registers a read-only subset of the MCP tools on `navigator.modelContext` so browser-side AI agents can query the registry without setting up a remote MCP connection. Currently exposed: `search_releases`, `list_organizations`, `get_organization`, `get_source`, `get_release`, plus an `open_search_page` navigation helper. Implementation: `web/src/components/webmcp-provider.tsx`.

**Keep them in parity.** If you add, rename, or change a read-only tool in `workers/mcp/src/tools.ts`, update the WebMCP provider in the same PR. The OSS CLI's stdio bridge (`releases admin mcp serve`) proxies to the hosted MCP server, so it picks up tool changes automatically once the worker redeploys. Write/admin tools stay remote-only — the browser can't hold an API key safely.

---

---

## Architecture

- **Storage** — Cloudflare D1 (FTS5 + vector indexes via Vectorize). The API worker is the sole data plane.
- **Adapters** — GitHub Releases API, RSS/Atom/JSON Feed parser, and Cloudflare browser-rendering fallback for pages without feeds (`packages/adapters/`).
- **AI Layer** — changelog parsing, summarization, grouping, and overviews run inside the API worker as direct Anthropic SDK calls.
- **Agents** — discovery + worker agents run as Anthropic-hosted **managed agents**. Agent definitions (system prompt, tools, skills, model) sync via `bun run deploy:agents`.
- **MCP Server** — hosted at `mcp.releases.sh`, read-only tools, no auth required.
- **API Server** — JSON endpoints with CORS. GET endpoints are public; write operations require a Bearer token.
- **Web Frontend** — Next.js app in `web/`, deploys on Vercel.
- **CLI** — lives out-of-tree at [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli). The monorepo no longer carries a CLI.

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

Local worker/web development:

```bash
bun run db:migrate:local     # apply D1 migrations (required before first dev:api run)
bun run dev:web              # Next.js frontend on :3000
bun run dev:api              # API worker on :8787 (local D1)
bun run dev:discovery        # Discovery worker locally
bun run dev:mcp              # MCP worker locally
```

Point the web frontend at the local API worker by setting `RELEASED_API_URL=http://localhost:8787` in `web/.env.local`.

`wrangler dev` does not pull from Cloudflare's Secrets Store, so any endpoint that reads `ANTHROPIC_API_KEY`, `GITHUB_TOKEN`, `VOYAGE_API_KEY`, `RELEASED_API_KEY`, or `WEBHOOK_HMAC_MASTER` will fail locally unless you create `workers/api/.dev.vars` with the values you need. The file is gitignored.

The discovery worker runs **managed agents** (Anthropic-hosted). Sessions are Durable Objects that stream events from the Anthropic API via typed executor tools.

After changing agent tools, system prompt, or skills, run `bun run deploy:agents` to sync both Anthropic-hosted agent definitions. Use `deploy:agents:discovery` or `deploy:agents:worker` to target a single agent. The script tracks content hashes for prompt and tools to avoid unnecessary updates. State is stored in `scripts/agent-skills.json`.

Database tools:

```bash
bun run db:studio:d1         # browse local D1 database (Drizzle Studio)
bun run db:query "SQL"       # run a query against local D1
bun run db:pull              # sync remote D1 data into local D1
```

## Development

```bash
npx tsc --noEmit             # type-check (root — src/ survivors)
cd workers/api && npx tsc --noEmit   # type-check the API worker
cd web && npx tsc --noEmit   # type-check the frontend
bun run db:generate          # generate a D1 migration after a schema change
```

### Testing

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

### Evals

Eval suites measure the quality of AI-powered features — changelog parsing, source evaluation, and agent discovery. They call real AI models and are not part of the normal test run.

```bash
bun run eval:evaluation      # URL evaluation evals (~30 sec, no API key needed)
```

Parsing + discovery evals used to live in this repo but followed the CLI into [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli); the parser and discovery harness there own their own eval suites.

**Fixtures** live in `tests/evals/fixtures/`. Fixture `.expected.json` files are grading specs with fields like `contentContains` and `isBreaking` that enable code-based grading of structured AI output. **Results** are saved to `tests/evals/results/` (gitignored) as timestamped JSON.
