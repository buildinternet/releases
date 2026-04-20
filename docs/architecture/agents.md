# Agent Architecture

Two Anthropic managed agents handle changelog work, sharing the same tools (`AGENT_TOOLS`) and skills:

- **Discovery agent** (`claude-sonnet-4-6`) — Onboarding, evaluation, and judgment-heavy tasks. System prompt: `src/shared/discovery-prompt.ts`.
- **Worker agent** (`claude-haiku-4-5`) — Fetches, updates, and mechanical operations at ~3x lower cost. System prompt: `src/shared/worker-prompt.ts`. The discovery worker DO routes `mode: "update"` sessions to this agent via `ANTHROPIC_WORKER_AGENT_ID`.

Both agents are deployed via `bun run deploy:agents`. Use `deploy:agents:discovery` or `deploy:agents:worker` to target one. Agent IDs and config state live in `scripts/agent-skills.json`.

- **Agent skills** live in this monorepo at `src/agent/skills/`. Each skill is a `SKILL.md` with YAML frontmatter. Skills are uploaded to the managed agent definition via `bun run deploy:skills`.
- **Deterministic pipeline** (ingest, incremental, summarize) stays as direct Messages API calls — not routed through the agent.
- **URL evaluation** runs pre-checks only (provider detection, feed discovery) via `POST /v1/evaluate`. The discovery agent handles deeper evaluation when needed.

### Skills vs. playbooks

Agents operate on three layers of fetch guidance:

| Layer                 | Scope      | Location                                     | Example                                     |
| --------------------- | ---------- | -------------------------------------------- | ------------------------------------------- |
| **Global skills**     | All orgs   | `src/agent/skills/**/SKILL.md`               | `parsing-changelogs`, `managing-sources`    |
| **Playbook**          | One org    | `knowledge_pages` rows with `scope=playbook` | "Vercel canary releases ship empty content" |
| **parseInstructions** | One source | `sources.parseInstructions` column           | "Skip entries tagged `marketing`"           |

**A playbook is a per-org skill.** Same mental model as the global skill corpus — imperative instructions an LLM follows when fetching — scoped to one organization. When an agent fetches any of an org's sources, it should load that org's playbook into context alongside the global skills. Global skills teach general patterns; the playbook overrides with org-specific behavior (naming conventions, what counts as a release, rollup cadence, cross-source dedup rules); per-source `parseInstructions` add source-specific hints on top.

Playbook notes are written by the discovery/worker agents themselves (via the `seeding-playbooks` skill for bulk creation, or inline during fetch when something new is learned). They're owned by agents, not humans — think "the agent's own notebook for this company," not "operator documentation."

## Claude Code Plugin

A Claude Code plugin at `plugins/claude/releases/` exposes the registry for use in Claude Code sessions. It connects to the remote MCP server at `mcp.releases.sh` and adapts the managed agent prompts for CLI-based operation.

**Components:** `.mcp.json` (MCP connection), 2 agents (discovery/worker), 1 command (`/releases`), 8 skills synced from `src/agent/skills/` (`analyzing-releases`, `classify-media-relevance`, `finding-changelogs`, `grouping-releases`, `maintaining-orgs`, `managing-sources`, `parsing-changelogs`, `seeding-playbooks`).

**Test locally:** `claude --plugin-dir plugins/claude/releases`

**Validate:** `claude plugin validate plugins/claude/releases`

**Skill sources of truth.** Two skill trees coexist and do not share tooling:

- `src/agent/skills/` (this monorepo) is the canonical source for managed agents and this repo's Claude plugin at `plugins/claude/releases/skills/`. Copies are maintained by hand — `scripts/sync-plugin-skills.ts` was removed when local mode was killed. After editing `src/agent/skills/<skill>/SKILL.md`, copy the change to `plugins/claude/releases/skills/<skill>/SKILL.md` in the same PR, then run `bun run deploy:skills` to push the managed-agents update.
- The OSS CLI at [`buildinternet/releases-cli`](https://github.com/buildinternet/releases-cli) ships its own `skills/` tree (publishes `@buildinternet/releases-skills` + a separate Claude plugin) that includes the six user-oriented skills plus `releases-cli` / `releases-mcp`. When you edit one of the six shared skills here, mirror the change into the OSS CLI so the published package doesn't drift.
