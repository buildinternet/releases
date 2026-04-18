# Agent Architecture

Two Anthropic managed agents handle changelog work, sharing the same tools (`AGENT_TOOLS`) and skills:

- **Discovery agent** (`claude-sonnet-4-6`) — Onboarding, evaluation, and judgment-heavy tasks. System prompt: `src/shared/discovery-prompt.ts`.
- **Worker agent** (`claude-haiku-4-5`) — Fetches, updates, and mechanical operations at ~3x lower cost. System prompt: `src/shared/worker-prompt.ts`. The discovery worker DO routes `mode: "update"` sessions to this agent via `ANTHROPIC_WORKER_AGENT_ID`.

Both agents are deployed via `bun run deploy:agents`. Use `deploy:agents:discovery` or `deploy:agents:worker` to target one. Agent IDs and config state live in `scripts/agent-skills.json`.

The local-only unified agent (`src/agent/releases.ts`) handles all judgment-based changelog work when not using managed agents.

- **Agent skills** are sourced from `@buildinternet/releases-skills` (published OSS). At runtime, `resolveSkillsDir()` finds skills via: `RELEASED_SKILLS_DIR` env var (highest priority) → `skillsDir()` from the npm package (bundled `skills/` directory) → `src/agent/skills/` source tree fallback (for `bun src/index.ts` in the monorepo when the package isn't installed). The agent symlinks the resolved directory to `.claude/skills/` for SDK discovery. Each skill is a `SKILL.md` with YAML frontmatter. To add or edit skills, update the OSS repo and publish a new `@buildinternet/releases-skills` version.
- **Deterministic pipeline** (ingest, incremental, summarize) stays as direct Messages API calls — not routed through the agent.
- **`evaluate` CLI command** runs pre-checks only (provider detection, feed discovery). The agent handles deeper evaluation when needed.

## Claude Code Plugin

A Claude Code plugin at `plugins/claude/releases/` exposes the registry for use in Claude Code sessions. It connects to the remote MCP server at `mcp.releases.sh` and adapts the managed agent prompts for CLI-based operation.

**Components:** `.mcp.json` (MCP connection), 2 agents (discovery/worker), 1 command (`/releases`), 6 skills (1 consumer + 5 synced from `src/agent/skills/`).

**Test locally:** `claude --plugin-dir plugins/claude/releases`

**Validate:** `claude plugin validate plugins/claude/releases`

**Skill sync:** Skills are published to npm as `@buildinternet/releases-skills` via the OSS repo. The plugin directory carries committed copies of the skills — update them by editing `src/agent/skills/` in the OSS repo and bumping the package version. `bun run deploy:skills` pushes skill updates to the Anthropic managed-agents API; `scripts/sync-plugin-skills.ts` has been removed — the plugin copies must now be updated manually when OSS skill content changes.
