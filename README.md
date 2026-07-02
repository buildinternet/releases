# Releases (monorepo)

[![CI](https://github.com/buildinternet/releases/actions/workflows/ci.yml/badge.svg)](https://github.com/buildinternet/releases/actions/workflows/ci.yml)
[![npm (CLI)](https://img.shields.io/npm/v/@buildinternet/releases?color=cb3837&label=%40buildinternet%2Freleases&logo=npm)](https://www.npmjs.com/package/@buildinternet/releases)

Backend, workers, web frontend, and agent tooling behind [releases.sh](https://releases.sh) — a changelog indexer and registry for developers and AI agents. Private repo; it talks to the world over HTTP via the API worker.

The user-facing CLI (`@buildinternet/releases`) ships separately from [buildinternet/releases-cli](https://github.com/buildinternet/releases-cli) (npm + Homebrew). All CLI changes — reader and operator/admin — land there.

## Layout

| Path                 | What                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------- |
| `workers/api/`       | Hono API on Cloudflare D1 — the authoritative data plane                                      |
| `workers/mcp/`       | Remote MCP server at `mcp.releases.sh`                                                        |
| `workers/discovery/` | Durable-Object agent-session orchestrator                                                     |
| `workers/webhooks/`  | Signs + delivers `release.created` events (HMAC-SHA256, retry/DLQ) — [docs](docs/webhooks.md) |
| `web/`               | Next.js frontend, deploys on Vercel                                                           |
| `packages/`          | Shared code — `core` + `api-types` publish to npm; the rest are private workspaces            |
| `src/agent/`         | Managed-agents discovery + worker harness (prompt builder + shared types)                     |
| `.claude/`           | Claude Code config — `skills/` (canonical skill home), `agents/`, `commands/`, `workflows/`   |

Per-package detail and project conventions live in [AGENTS.md](AGENTS.md); architecture deep-dives in [docs/architecture/](docs/architecture/), with a reader's guide at [docs/README.md](docs/README.md). Agents getting oriented should start from [llms.txt](llms.txt).

## Consumer surfaces

**Claude Code (monorepo developers)** — everything under `.claude/` auto-loads on a trusted clone, no install step: the skills in `.claude/skills/`, the eval agents in `.claude/agents/` (`rubric-grader`, `overview-writer`), the repo-local commands in `.claude/commands/`, and the hosted MCP tools from the repo-root `.mcp.json`. On top of that, `.claude/settings.json` registers the public [CLI marketplace](https://github.com/buildinternet/releases-cli) and suggests installing the consumer `releases` plugin (the `/releases` changelog-lookup command + reader skills) — after you trust the repo, Claude Code prompts to install it; it's a suggestion, not a forced install. Operators who maintain sources may also want the `releases-admin` plugin from the same marketplace (`/plugin install releases-admin@releases`); it's not auto-suggested because it needs admin access to the registry. End users who don't have the repo checked out install those plugins from the [CLI repo](https://github.com/buildinternet/releases-cli) directly.

**Standalone skills** — install the published skills into any agent (Claude Code / Codex / Cursor / OpenCode) without checking out the monorepo:

```bash
npx skills add buildinternet/releases-cli
```

**MCP server** — hosted at `mcp.releases.sh`. Read tools are public (no auth); per-user `follow` / personalized-feed tools take a user token. Listed in the [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers?search=sh.releases/mcp) as `sh.releases/mcp`. Connect:

```bash
claude mcp add --transport http releases https://mcp.releases.sh/mcp   # Claude Code
codex mcp add releases --url https://mcp.releases.sh/mcp                # Codex
```

stdio-only clients (VS Code, Windsurf, Zed) bridge via `npx -y mcp-remote https://mcp.releases.sh/mcp`. The web app also registers a read-only [WebMCP](https://webmachinelearning.github.io/webmcp/) subset on `navigator.modelContext`. The full tool / resource / prompt catalog, auth model, and registry-publishing flow live in [docs/architecture/mcp.md](docs/architecture/mcp.md).

## Architecture

- **Storage** — Cloudflare D1 (FTS5 + Vectorize). The API worker is the sole data plane.
- **Adapters** — GitHub Releases, RSS/Atom/JSON feeds, and a Cloudflare browser-rendering fallback for feed-less pages (`packages/adapters/`). The crawler signs its outbound fetches (RFC 9421) so it can register as a Cloudflare Verified Bot — see [docs/runbooks/web-bot-auth-registration.md](docs/runbooks/web-bot-auth-registration.md).
- **AI** — changelog parsing, summarization, grouping, and overviews run in the API worker as direct Anthropic SDK calls.
- **Agents** — discovery + worker run as Anthropic-hosted managed agents; definitions auto-deploy on merge to `main` when their source changes.
- **API** — public GET endpoints, Bearer-token writes, CORS.

## Contributing

Setup, environment variables, local dev, deployment, testing, evals, and admin observability all live in [CONTRIBUTING.md](CONTRIBUTING.md).
