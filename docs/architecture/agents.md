# Agent Architecture

Two Anthropic managed agents handle changelog work, sharing the same tools (`AGENT_TOOLS`) and skills:

- **Discovery agent** (`claude-sonnet-4-6`) — Onboarding, evaluation, and judgment-heavy tasks. System prompt: `src/shared/discovery-prompt.ts`.
- **Worker agent** (`claude-haiku-4-5`) — Fetches, updates, and mechanical operations at ~3x lower cost. System prompt: `src/shared/worker-prompt.ts`. The discovery worker DO routes `mode: "update"` sessions to this agent via `ANTHROPIC_WORKER_AGENT_ID`.

Both agents are deployed via `bun run deploy:agents`. Use `deploy:agents:discovery` or `deploy:agents:worker` to target one. Agent IDs and config state live in `scripts/agent-skills.json` (prod) and `scripts/agent-skills.staging.json` (staging).

### Per-environment agents

Staging uses a parallel set of Anthropic resources so prompt/skill changes can be iterated without touching prod.

| Resource                 | Production                       | Staging                             |
| ------------------------ | -------------------------------- | ----------------------------------- |
| Discovery agent (Sonnet) | `agent_011CZtWpasPtsYjF3aysf2ZH` | `agent_011CaHHrroDymm1aEitzUmz1`    |
| Worker agent (Haiku)     | `agent_011CZvdgPKDQ2eRs8gTrLnNA` | `agent_011CaHHqcTEy9WDeLPzqsmHP`    |
| Environment              | `env_01Tq7S8F2FK1KBz68NMje2RU`   | `env_015c9WRKAWFfSqAV6tsAj6Qf`      |
| Vault                    | `vlt_011CZvFkwFPgCkGqRqP87AKB`   | `vlt_011CaHHvBA7pA6GDwRHJa4TN`      |
| Worker                   | `releases-discovery`             | `releases-discovery-staging`        |
| Config file              | `scripts/agent-skills.json`      | `scripts/agent-skills.staging.json` |
| Skill display titles     | `Finding Changelogs`, …          | `Finding Changelogs (staging)`, …   |

Skills are account-level Anthropic resources identified by `skill_…` IDs. Staging uses **separate skill resources** (different IDs, suffixed display title) so pushing a new version does not immediately affect prod agents. Add `--env staging` to any of the deploy scripts to target staging:

```bash
bun run deploy:skills -- --env staging              # push staging skill versions only
bun run deploy:agents -- --env staging              # sync prompt/tools/model on both staging agents
bun run deploy:agents:discovery -- --env staging    # discovery only
bun run deploy:agents:worker -- --env staging       # worker only
```

The `deploy-managed-agents.yml` workflow exposes the same selector as a `workflow_dispatch` input.

**Follow-up (not yet done):** there's no CLI/API surface to trigger a staging discovery session against `releases-discovery-staging` — the worker is service-bound from `releases-api-staging` but we haven't threaded an `--env staging` flag through the CLI's onboard/update commands. Track via issue #447.

- **Agent skills** live in this monorepo at `src/agent/skills/`. Each skill is a `SKILL.md` with YAML frontmatter. Skills are uploaded to the managed agent definition via `bun run deploy:skills`.
- **Deterministic pipeline** (ingest, incremental, summarize) stays as direct Messages API calls — not routed through the agent.
- **URL evaluation** runs pre-checks only (provider detection, feed discovery) via `POST /v1/evaluate`. The discovery agent handles deeper evaluation when needed.

## Tool surfaces: MCP vs custom tools

Managed agents operate against two tool surfaces. They share the same tool-use protocol from the model's perspective but are executed completely differently — the MCP surface is a public Worker, the custom-tool surface runs inside the discovery DO. Contributors frequently conflate them.

| Surface          | Declared in                                     | Executed by                           | Writes? |
| ---------------- | ----------------------------------------------- | ------------------------------------- | ------- |
| **MCP tools**    | `workers/mcp/src/mcp-agent.ts` (`createServer`) | `mcp.releases.sh` — remote MCP server | No      |
| **Custom tools** | `src/shared/agent-tools.ts` (`AGENT_TOOLS`)     | Discovery DO (`ManagedAgentsSession`) | Yes     |

Custom tools are plain Anthropic tool definitions ([Managed Agents → Custom tools](https://platform.claude.com/docs/en/managed-agents/tools#custom-tools)) that aren't served by any worker. When the model emits an `agent.custom_tool_use` event, the DO intercepts it, dispatches to `createTypedExecutor`, and sends the result back via `user.custom_tool_result`. Every write the agent performs (`manage_source`, `manage_playbook`, `manage_org`, `manage_product`, etc.) is a custom tool — writes run inside the trust boundary using the shared admin API key, not through the public MCP server.

### Request flow

```mermaid
sequenceDiagram
    autonumber
    participant M as Claude (model)
    participant S as Anthropic session
    participant DO as Discovery DO
    participant MCP as mcp.releases.sh
    participant API as api.releases.sh
    participant D1

    Note over M,MCP: MCP tool (read)
    M->>S: agent.mcp_tool_use
    S->>MCP: Bearer (vault credential)
    MCP->>D1: SELECT
    D1-->>MCP: rows
    MCP-->>S: tool result
    S-->>M: result

    Note over M,API: Custom tool (write)
    M->>S: agent.custom_tool_use
    S-->>DO: stream event
    DO->>API: Bearer RELEASED_API_KEY<br/>(+ X-Releases-Staging-Key in staging)
    API->>D1: INSERT
    D1-->>API: row
    API-->>DO: 200 OK
    DO->>S: user.custom_tool_result
    S-->>M: result
```

### Where to look

- **Add / edit a custom tool** — append to `AGENT_TOOLS` in `src/shared/agent-tools.ts`, add a `case` to `createTypedExecutor` mapping it to a REST call, then `bun run deploy:agents` to sync both managed agents.
- **Add / edit an MCP tool** — register it inside `createServer` in `workers/mcp/src/mcp-agent.ts`, deploy the `mcp` worker.
- **DO interception point** — `workers/discovery/src/managed-agents-session.ts`, the `agent.custom_tool_use` case inside `runSession()`.

### Why not put writes in MCP?

A single write tool in MCP would expose destructive operations to every unauthenticated caller of `mcp.releases.sh`. Adding principal resolution + per-org scoping to the MCP server is real work that depends on a staging auth story (issue #455) and vault-credential → principal mapping. Folding writes into MCP is planned but not scheduled.

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
