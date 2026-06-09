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
| `src/agent/`         | Managed-agents discovery + worker harness, plus `src/agent/skills/` (canonical skill home)    |
| `.claude-plugin/`    | Claude Code plugin manifest (`releases-dev`) and its assets                                   |

Per-package detail and project conventions live in [AGENTS.md](AGENTS.md); architecture deep-dives in [docs/architecture/](docs/architecture/).

## Consumer surfaces

**Claude Code plugin** — this repo publishes the `releases-dev` plugin (marketplace `releases-monorepo`) for monorepo developers. (End users want the public `releases` / `releases-admin` plugins from the CLI repo instead.) A trusted clone prompts you to install via `.claude/settings.json`, or manually:

```bash
/plugin marketplace add buildinternet/releases
/plugin install releases-dev@releases-monorepo
```

It bundles the hosted MCP tools, every skill in `src/agent/skills/`, the `discovery` / `worker` / `grader` agents, and the `/releases` command. See [plugins/claude/releases/README.md](plugins/claude/releases/README.md).

**Standalone skills** — install the bundled skills into any agent (Claude Code / Codex / Cursor / OpenCode) without the full plugin:

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
