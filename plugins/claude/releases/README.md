# `releases-dev` plugin (monorepo developer build)

Internal Claude Code plugin shipped from `buildinternet/releases`. Bundles every skill in `src/agent/skills/`, the `grader` subagent, the `/releases` command, and the hosted MCP connection.

**This plugin is for people developing the monorepo, not end users.** Anyone querying the registry — including engineers at other companies — should install the public `releases` and `releases-admin` plugins from the [`buildinternet/releases-cli`](https://github.com/buildinternet/releases-cli) marketplace instead. The CLI plugins ship the same public-facing skills with a tighter audience split (reader vs admin) and a versioned release process.

## Install (monorepo developers)

```bash
/plugin marketplace add buildinternet/releases
/plugin install releases-dev@releases-monorepo
```

Reload Claude Code; `/releases`, the MCP tools at `mcp.releases.sh`, the `grader` subagent, and the auto-triggering skills should all be available.

## Layout

- **`.claude-plugin/marketplace.json`** (repo root) — single source of plugin definition truth. References `./src/agent/skills/*` canonically and the assets under `./plugins/claude/releases/` for agents, commands, and `.mcp.json`. `strict: false` on the plugin entry means the marketplace entry IS the entire definition — there is no per-plugin `plugin.json`.
- **`./src/agent/skills/<name>/SKILL.md`** — the canonical home for every skill. Managed agents (discovery + worker workers in production) read from here directly; the plugin references the same paths, so there is no mirror tree and no sync script.
- **`./plugins/claude/releases/agents/grader.md`** — a local-only rubric subagent used when iterating on managed-agent rubrics. The production discovery/worker prompts live in `src/agent/managed-discovery.ts` (not here), and the OSS CLI's `releases-admin` plugin is what ships operator-facing `discovery`/`worker` agents — this plugin deliberately no longer mirrors them, since nothing in the monorepo invoked the copies and they only drifted from the TS source.
- **`./plugins/claude/releases/commands/releases.md`** — the `/releases` slash command.
- **`./plugins/claude/releases/.mcp.json`** — points Claude Code at `https://mcp.releases.sh/mcp`.

## Relationship to the CLI plugins

The user-facing OSS CLI ([`buildinternet/releases-cli`](https://github.com/buildinternet/releases-cli)) publishes two plugins via its own marketplace:

| Plugin                     | Audience           | Bundles                                                                          |
| -------------------------- | ------------------ | -------------------------------------------------------------------------------- |
| `releases`                 | Reader             | Hosted MCP, `/releases`, public reader skills                                    |
| `releases-admin`           | Operator           | `discovery` + `worker` agents, operator playbook skills                          |
| `releases-dev` (this repo) | Monorepo developer | Hosted MCP, `/releases`, all public + 4 monorepo-only skills, the `grader` agent |

Six skills exist in both repos as hand-maintained copies — that drift is a known follow-up tracked separately from the marketplace rename. See [#1087](https://github.com/buildinternet/releases/issues/1087) for the cross-repo skill drift discussion.

## Validation

`claude plugin validate . --strict` from the repo root checks the manifest. The same command runs in CI on every PR via `.github/workflows/ci.yml`.

## Available MCP tools

Documented canonically in [`docs/architecture/mcp.md`](../../../docs/architecture/mcp.md) and surfaced via the live server at `https://mcp.releases.sh/mcp`. Tool shapes there are the source of truth; this README intentionally does not duplicate them.

## Standalone skills (no plugin)

To use just the auto-triggering skills in a different host (Codex, Cursor, OpenCode), install the public skill bundle from the OSS CLI repo via the [`skills`](https://github.com/vercel-labs/skills) CLI:

```bash
npx skills add buildinternet/releases-cli
```

That bundle excludes the monorepo-only skills (`regenerating-overviews`, `maintaining-orgs`, `grouping-releases`, `generating-release-content`) and the `grader` agent — those stay monorepo-internal.
