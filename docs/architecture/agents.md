# Agent Architecture

Two Anthropic managed agents handle changelog work, sharing the same tools (`AGENT_TOOLS`) and skills:

- **Discovery agent** (`claude-sonnet-4-6`) — Onboarding, evaluation, and judgment-heavy tasks. System prompt: `src/shared/discovery-prompt.ts`.
- **Worker agent** (`claude-haiku-4-5`) — Fetches, updates, and mechanical operations at ~3x lower cost. System prompt: `src/shared/worker-prompt.ts`. The discovery worker DO routes `mode: "update"` sessions to this agent via `ANTHROPIC_WORKER_AGENT_ID`.

Both agents are deployed via `bun run deploy:agents`. Use `deploy:agents:discovery` or `deploy:agents:worker` to target one. Agent IDs and config state live in `scripts/agent-skills.json`.

- **Agent skills** are sourced from `@buildinternet/releases-skills` (published OSS). Each skill is a `SKILL.md` with YAML frontmatter. Skills are uploaded to the managed agent definition via `bun run deploy:skills`. To add or edit skills, update the OSS repo, publish a new `@buildinternet/releases-skills` version, and redeploy.
- **Deterministic pipeline** (ingest, incremental, summarize) stays as direct Messages API calls — not routed through the agent.
- **`evaluate` CLI command** runs pre-checks only (provider detection, feed discovery). The agent handles deeper evaluation when needed.

## Claude Code Plugin

A Claude Code plugin at `plugins/claude/releases/` exposes the registry for use in Claude Code sessions. It connects to the remote MCP server at `mcp.releases.sh` and adapts the managed agent prompts for CLI-based operation.

**Components:** `.mcp.json` (MCP connection), 2 agents (discovery/worker), 1 command (`/releases`), 6 skills (1 consumer + 5 synced from `src/agent/skills/`).

**Test locally:** `claude --plugin-dir plugins/claude/releases`

**Validate:** `claude plugin validate plugins/claude/releases`

**Skill sync:** Skills are published to npm as `@buildinternet/releases-skills` via the OSS repo. The plugin directory carries committed copies of the skills — update them by editing `src/agent/skills/` in the OSS repo and bumping the package version. `bun run deploy:skills` pushes skill updates to the Anthropic managed-agents API; `scripts/sync-plugin-skills.ts` has been removed — the plugin copies must now be updated manually when OSS skill content changes.
