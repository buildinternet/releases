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
- `packages/` — In-tree shared code. `packages/core/` publishes `@buildinternet/releases-core` (schema + pure helpers shared with the OSS CLI) and `packages/api-types/` publishes `@buildinternet/releases-api-types` (wire protocol types). `packages/core-internal/`, `packages/adapters/`, `packages/ai/`, `packages/rendering/`, `packages/search/`, and the slimmed `packages/lib/` are private workspaces. `packages/lib/src/logger.ts` is also published via the OSS CLI as `@buildinternet/releases-lib/logger`.
- `src/agent/` — Managed-agents discovery + worker harness (invoked by the discovery worker's Durable Object).
- `plugins/claude/releases/` — Claude Code plugin (committed copy; skill source of truth is OSS `@buildinternet/releases-skills`).

## Consumer surfaces

### Claude Code Plugin

Install the plugin to get MCP tools, auto-triggering skills, and operational agents directly in Claude Code:

```bash
claude plugin add /path/to/releases/plugins/claude/releases
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

Releases is available as an MCP server for AI agent integration. There are two ways to connect:

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

> Every tool that takes an org / product / source identifier accepts the typed ID (`org_…`, `prod_…`, `src_…`) interchangeably with the slug. Source and product params also accept an `org/slug` coordinate. Releases are addressed by id only (`rel_…` or a bare 21-char nanoid) — there is no release-slug shape.

| Tool                  | Description                                                                                                                                                                                                                                                                                                                                   |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `search`              | Unified search across orgs, catalog (products + standalone sources), and release content. Pass `type: ("orgs"\|"catalog"\|"releases")[]` to skip sections; `entity` to scope releases                                                                                                                                                         |
| `list_catalog`        | Products and standalone sources folded into one list, each row tagged with a `kind: "product"\|"source"` discriminator                                                                                                                                                                                                                        |
| `get_catalog_entry`   | Detail for a catalog entry — dispatches on slug / `prod_` / `src_` id and returns product or source fields. Source entries list tracked CHANGELOG files; pass `include_changelog: true` (or `changelog_path` / `changelog_offset` / `changelog_limit` / `changelog_tokens`) to embed a heading-aligned slice with cl100k_base token budgeting |
| `get_latest_releases` | Most recent releases (filter by product, org, or `type`)                                                                                                                                                                                                                                                                                      |
| `get_release`         | Full content of a single release by id (accepts `rel_` prefix or bare nanoid)                                                                                                                                                                                                                                                                 |
| `summarize_changes`   | AI summary of a product's recent changes (gated)                                                                                                                                                                                                                                                                                              |
| `compare_products`    | AI comparison between two products (gated)                                                                                                                                                                                                                                                                                                    |
| `list_organizations`  | List all organizations with their linked sources                                                                                                                                                                                                                                                                                              |
| `get_organization`    | Detailed view of a single org (accounts, tags, sources, products, aliases). Shows a preview of the AI-generated overview by default; pass `include_overview: true` to inline the full briefing (stale warning if older than 30 days)                                                                                                          |

**Deprecated shims** (one release cycle): `search_releases`, `search_registry`, `list_sources`, `list_products`, `get_product` — each titled `(deprecated)` and pointing callers at the replacement above.

Every tool carries MCP annotations (`readOnlyHint`, `idempotentHint`, `openWorldHint`, and a display `title`) so clients can surface them correctly in low-trust modes.

**MCP Resources** (browseable by resource-aware clients like Inspector):

| URI template                       | Description                                                                                                  |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `releases://org/{orgSlug}`         | Organization profile rendered as Markdown. Completion suggests slugs by substring match against slug + name. |
| `releases://product/{productSlug}` | Product detail rendered as Markdown. Same completion behavior.                                               |
| `releases://source/{sourceSlug}`   | Source detail rendered as Markdown. Same completion behavior.                                                |

All three templates are completion-only — `resources/list` returns empty so the catalog scales without silent truncation. Type a prefix or substring and the client will suggest matching slugs. The URI segment also accepts a typed ID (`org_…`, `prod_…`, `src_…`) when you have one — completion just doesn't surface IDs because they aren't browseable.

**MCP Prompts** (priming conversation starters):

| Prompt             | Arguments                                     | Purpose                                                                        |
| ------------------ | --------------------------------------------- | ------------------------------------------------------------------------------ |
| `whats_new`        | `product` (completable), `days?`              | Summarize recent changes for a product. Uses `summarize_changes` when enabled. |
| `compare_products` | `productA`, `productB` (completable), `days?` | Compare recent releases between two products.                                  |
| `catch_me_up`      | `organization` (completable), `days?`         | Read the org's AI overview, then list recent releases grouped by product.      |

**Gated** = requires `ENABLE_AI_TOOLS=true`. These tools make Anthropic API calls and are disabled by default. Set the env var in the worker config. Admin/write flows (adding sources, fetching, suppressing releases, etc.) live behind the API worker's bearer-auth endpoints, not MCP.

#### In-browser (WebMCP)

When a visitor loads `releases.sh` in a browser that implements the emerging [WebMCP](https://webmachinelearning.github.io/webmcp/) API (Chrome's Early Preview Program today), the web app registers a read-only subset of the MCP tools on `navigator.modelContext` so browser-side AI agents can query the registry without setting up a remote MCP connection. Currently exposed: `search`, `list_organizations`, `get_organization`, `get_catalog_entry`, `get_release`, plus an `open_search_page` navigation helper. Implementation: `web/src/components/webmcp-provider.tsx`.

WebMCP is intentionally a lightweight tool subset — it does not mirror resources, prompts, or the AI tools. If you add, rename, or change a read-only tool in `workers/mcp/src/tools.ts`, update the WebMCP provider in the same PR so the tool subset doesn't drift. The OSS CLI's stdio bridge (`releases admin mcp serve`) proxies to the hosted MCP server, so it picks up tool changes automatically once the worker redeploys. Write/admin tools stay remote-only — the browser can't hold an API key safely.

## Architecture

- **Storage** — Cloudflare D1 (FTS5 + vector indexes via Vectorize). The API worker is the sole data plane.
- **Adapters** — GitHub Releases API, RSS/Atom/JSON Feed parser, and Cloudflare browser-rendering fallback for pages without feeds (`packages/adapters/`).
- **AI Layer** — changelog parsing, summarization, grouping, and overviews run inside the API worker as direct Anthropic SDK calls.
- **Agents** — discovery + worker agents run as Anthropic-hosted **managed agents**. Agent definitions (system prompt, tools, skills, model) auto-deploy on merges to `main` whenever the relevant source files change, keeping live agents in lockstep with the repo.
- **MCP Server** — hosted at `mcp.releases.sh`, read-only tools, no auth required.
- **API Server** — JSON endpoints with CORS. GET endpoints are public; write operations require a Bearer token.
- **Web Frontend** — Next.js app in `web/`, deploys on Vercel.
- **CLI** — lives out-of-tree at [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli). The monorepo no longer carries a CLI.

## Contributing

Setup, environment variables, local dev, deployment, testing, evals, and admin observability all live in [CONTRIBUTING.md](CONTRIBUTING.md).
