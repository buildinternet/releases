# Agent Architecture

Most ingest is deterministic code, but the judgment-heavy work — onboarding a new company, evaluating a messy changelog page, recovering a broken source — is done by AI agents. This doc covers the two Anthropic-hosted **managed agents** that do that work in production (how they deploy, what tools they see, how their skills and per-org playbooks layer), plus how the same skill corpus serves local Claude Code development. If you're changing a prompt, a tool, or a skill, the [Where to look](#where-to-look) section maps each change to its file and deploy path.

The two agents share the same tools (`AGENT_TOOLS`) and skills:

- **Discovery agent** (`claude-sonnet-5`) — Onboarding, evaluation, and judgment-heavy tasks. System prompt: `managed-agents/src/shared/discovery-prompt.ts`.
- **Worker agent** (`claude-haiku-4-5`) — Mechanical operations at ~3x lower cost. System prompt: `managed-agents/src/shared/worker-prompt.ts`; deployed via `ANTHROPIC_WORKER_AGENT_ID`. Note: routine `update` sessions no longer dispatch to this agent — since #1946 they run as the API worker's `DeterministicUpdateWorkflow` (see [remote-mode.md → Deterministic update runs](remote-mode.md)), and the discovery worker serves onboarding only.

Both agents are auto-deployed by `.github/workflows/deploy-managed-agents.yml` on any push to `main` that touches `managed-agents/src/shared/agent-tools.ts`, `managed-agents/src/shared/worker-prompt.ts`, `managed-agents/src/shared/discovery-prompt.ts`, `.claude/skills/**`, or `scripts/sync-agent-skills.ts` — live Anthropic state stays in lockstep with `main`. For local / ad-hoc deploys: `bun run deploy:agents` (both), `deploy:agents:discovery`, or `deploy:agents:worker`. Agent IDs and skill mappings live in `scripts/agent-skills.json` (prod) and `scripts/agent-skills.staging.json` (staging).

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

The `deploy-managed-agents.yml` workflow exposes the same selector as a `workflow_dispatch` input for manual deploys (environment/deploy-scope/agent-scope). Automatic push deploys always target production with `deploy=both`, `agent=all`.

**Follow-up (not yet done):** there's no CLI/API surface to trigger a staging discovery session against `releases-discovery-staging` — the worker is service-bound from `releases-api-staging` but we haven't threaded an `--env staging` flag through the CLI's onboard/update commands. Track via issue #447.

### Version-controlled definitions (render + verify)

The agent definitions aren't hand-authored YAML — the source of truth is TypeScript (the prompt builders, `AGENT_TOOLS`, and the per-env skill IDs), which the deploy assembles. To make that assembled state reviewable and diffable, a committed mirror lives under `managed-agents/` (`<kind>.<env>.agent.yaml`, six files = discovery/worker/coordinator × production/staging):

```bash
bun scripts/render-managed-agents.ts          # regenerate the six YAML files from source
bun scripts/render-managed-agents.ts --check  # CI drift gate — fails if any file is stale
bun scripts/verify-managed-agents.ts --env staging   # diff committed YAML against the LIVE agents
```

- **`render … --check`** runs in CI (`.github/workflows/ci.yml`, the `test` job). It re-renders from source and fails if the committed YAML drifted — so changing a prompt builder, a tool schema, or the category list without re-rendering is caught at PR time. Pure codegen; no network.
- **`verify`** retrieves each live agent via `ant beta:agents retrieve` and classifies every field diff: `match`, `api-default` (server-injected toolset defaults like `configs: []` / `permission_policy` — benign), `source-ahead` (the live agent predates a merged change; a redeploy reconciles it), or `MISMATCH` (a renderer bug or unexplained live drift — the only thing that fails the run). It's an on-demand check, not a CI gate.
- **Workspace caveat:** `ant`'s default OAuth login resolves to the Rally "Default" workspace, which holds the **staging** agents and both coordinators but not the **prod** discovery/worker agents (they live in a sibling Rally workspace, the one the CI `ANTHROPIC_API_KEY` is scoped to). Bind to that workspace — or export its API key — before running `verify --env production`, or those two agents report `UNREACHABLE`.

### Applying: fetch path vs. render-then-apply (`ant`)

The deploy (`scripts/sync-agent-skills.ts`) has two ways to push an existing agent's config:

- **Render-then-apply via `ant` (default).** Each agent's committed `managed-agents/<kind>.<env>.agent.yaml` is fed verbatim to `ant beta:agents update --agent-id <id> --version <current>` — so the committed YAML is the literal deploy artifact. Because the YAML is the full body, this path also (idempotently) re-asserts `name` and the coordinator's `multiagent` roster; the API re-resolves the roster's worker reference to its current version. It uses the YAML's model verbatim, ignoring `RELEASES_*_AGENT_MODEL` overrides (CI never sets them), and relies on the render `--check` drift gate keeping the YAML current. Skills and memory stores stay on the fetch path regardless. (Renames flow through this path too, since `name` is part of the body.)
- **Fetch path (rollback).** Builds the update body in JS from the same source and `POST`s it to `/v1/agents/{id}`, omitting `name`/`multiagent`. The historical path; reachable via a dispatch that unchecks `apply_via_ant`.

The deploy workflow installs the pinned `ant` CLI (conditional on `AGENT_APPLY_VIA_ANT=1`, which is the default for push deploys and dispatches) and uses the `ant` path. To fall back to fetch for a given run — e.g. if a release download is unavailable — dispatch with `apply_via_ant` unchecked. Both environments were cut over to the `ant` path on 2026-06-02 and verify all-match.

### Version-controlled environments

The sandbox each session runs in — the [environment](https://platform.claude.com/docs/en/api/cli/beta/environments) — is also version-controlled, but unlike the agents it is **not** generated from TypeScript. The env config is small, static, and not derived from anything (`name`, `description`, `scope`, and a `config` of `type: cloud` + `networking: unrestricted` plus server-managed `packages`/`init_script`/`environment` defaults), so the committed YAML _is_ the source of truth — hand-authored mirrors captured via `ant beta:environments retrieve`:

- `managed-agents/production.environment.yaml` (`env_01Tq…`) and `managed-agents/staging.environment.yaml` (`env_015c…`); the IDs live in `scripts/agent-skills{,.staging}.json` as `environmentId`.
- Because the YAML is the source (nothing upstream to drift from), there is **no render `--check`** for environments. `tests/unit/environment-yaml.test.ts` is the CI net against a malformed hand-edit; `bun scripts/verify-managed-agents.ts --env <env>` is the committed-vs-live drift check (runs alongside the agents). `verify` diffs the meaningful writable fields (`name`, `description`, `scope`, `config.type`, `config.networking`) and ignores the server-managed config sub-objects, so server-default churn never reads as a mismatch.
- **Apply** feeds the committed YAML to `ant beta:environments update --environment-id <id>` (no `--version` — environments take no optimistic-lock token), gated by the same `AGENT_APPLY_VIA_ANT` flag. It is **ant-path-only**: with the flag off (fetch rollback), environments are left untouched, which matches their historical behavior. Names are preserved verbatim, so apply is a no-op re-assert until the YAML changes.

Scope: this covers the two discovery environments only. The staging eval agent's own environment and the Anthropic vaults (which hold the MCP credential, i.e. secrets) are intentionally not version-controlled here.

### Per-session cost observability

After each managed-agent session ends — both successful completions and terminal failures (provider `session.error`, retries-exhausted idle) — the discovery DO retrieves the final usage envelope via `client.beta.sessions.retrieve(session.id)` (the shared `captureFinalUsage` helper) and computes a list-price USD estimate using `@releases/lib/anthropic-pricing`. The full block — `inputTokens`, `outputTokens`, `cacheWriteTokens`, `cacheReadTokens`, `model`, and `estimatedUsd` — is forwarded to StatusHub via the `session:complete` / `session:error` events and stored on `SessionState.usage`. The web `/status` page renders it under each session card with an `≈ $` qualifier. The dollar figure is from list prices (not the actual billed amount) — for ground truth use the Anthropic console or AI Gateway dashboards. Pricing constants for new models go in `packages/lib/src/anthropic-pricing.ts`. See #657.

- **Agent skills** live in this monorepo at `.claude/skills/`. Each skill is a `SKILL.md` with YAML frontmatter. Skills are uploaded to the managed agent definition via `bun run deploy:skills`.
- **Deterministic pipeline** (ingest, incremental, summarize) stays as direct Messages API calls — not routed through the agent.
- **URL evaluation** runs pre-checks only (provider detection, feed discovery) via `POST /v1/evaluate`. The discovery agent handles deeper evaluation when needed.

## Tool surfaces: MCP vs custom tools

Managed agents operate against two tool surfaces. They share the same tool-use protocol from the model's perspective but are executed completely differently — the MCP surface is a public Worker, the custom-tool surface runs inside the discovery DO. Contributors frequently conflate them.

| Surface          | Declared in                                                | Executed by                           | Writes? |
| ---------------- | ---------------------------------------------------------- | ------------------------------------- | ------- |
| **MCP tools**    | `workers/mcp/src/mcp-agent.ts` (`createServer`)            | `mcp.releases.sh` — remote MCP server | No      |
| **Custom tools** | `managed-agents/src/shared/agent-tools.ts` (`AGENT_TOOLS`) | Discovery DO (`ManagedAgentsSession`) | Yes     |

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
    DO->>API: Bearer RELEASES_API_KEY<br/>(+ X-Releases-Staging-Key in staging)
    API->>D1: INSERT
    D1-->>API: row
    API-->>DO: 200 OK
    DO->>S: user.custom_tool_result
    S-->>M: result
```

### Where to look

- **Add / edit a custom tool** — append to `AGENT_TOOLS` in `managed-agents/src/shared/agent-tools.ts`, add a `case` to `createTypedExecutor` mapping it to a REST call. Merging to `main` auto-deploys both managed agents; `bun run deploy:agents` is only needed for local iteration or staging.
- **Add / edit an MCP tool** — register it inside `createServer` in `workers/mcp/src/mcp-agent.ts`, deploy the `mcp` worker.
- **DO interception point** — `workers/discovery/src/managed-agents-session.ts`, the `agent.custom_tool_use` case inside `runSession()`.

### Why not put writes in MCP?

A single write tool in MCP would expose destructive operations to every unauthenticated caller of `mcp.releases.sh`. Adding principal resolution + per-org scoping to the MCP server is real work that depends on a staging auth story (issue #455) and vault-credential → principal mapping. Folding writes into MCP is planned but not scheduled.

### How the agent gets MCP access

Each agent must register two things at create/update time for the MCP read surface to work:

1. **`mcp_servers`** — `[{ name: "releases", type: "url", url: "https://mcp.releases.sh" }]` (or `mcp-staging.releases.sh` in staging). Names the server inside the agent definition.
2. **`mcp_toolset`** in `tools` — `{ type: "mcp_toolset", mcp_server_name: "releases", default_config: { enabled: true, permission_policy: { type: "always_allow" } } }`. Without this entry the platform never registers MCP tools with the model. Without `always_allow`, the platform's default `always_ask` policy resolves to deny in non-interactive sessions and every MCP call comes back as `Permission to use <tool> has been denied`.

`scripts/sync-agent-skills.ts` builds both via `buildMcpServerDefinition(env)` and `buildMcpToolset()` from `managed-agents/src/shared/agent-tools.ts`. The vault attached to each session (`vault_ids: [...]`) carries the bearer credential the platform uses when calling out to the MCP server — the credential entry must be named to match `mcp_servers.name` (`"releases"`) so the platform pairs them up.

### Discovery column and on-demand rows

The `discovery` column (text, nullable, indexed) on both `organizations` and `sources` records the origin of each row:

| Value         | Set by                                                          |
| ------------- | --------------------------------------------------------------- |
| `'curated'`   | Manual admin operations; backfilled on all pre-existing rows    |
| `'agent'`     | Discovery agent via `manage_source` / `manage_org` custom tools |
| `'on_demand'` | `POST /v1/lookups` (on-demand GitHub coordinate lookup)         |

Agent-created rows (`discovery = 'agent'`) are treated as curated for AI-feature purposes — they get org overviews, summarization, and playbook regen just like manually added rows. On-demand rows (`discovery = 'on_demand'`) skip all AI features except embeddings; they fold into the normal smart-fetch cron at `low` tier once materialized.

If an agent encounters a source or org with `discovery = 'on_demand'` in the DB, it can promote it to curated by calling `manage_source` / `manage_org` action "edit" — no special promotion command exists; updating any field (e.g. name, description) with an explicit `discovery: 'curated'` value is the promotion ceremony.

### Skills vs. playbooks

Agents operate on three layers of fetch guidance:

| Layer                 | Scope      | Location                                     | Example                                     |
| --------------------- | ---------- | -------------------------------------------- | ------------------------------------------- |
| **Global skills**     | All orgs   | `.claude/skills/**/SKILL.md`                 | `parsing-changelogs`, `managing-sources`    |
| **Playbook**          | One org    | `knowledge_pages` rows with `scope=playbook` | "Vercel canary releases ship empty content" |
| **parseInstructions** | One source | `sources.parseInstructions` column           | "Skip entries tagged `marketing`"           |

**A playbook is a per-org skill.** Same mental model as the global skill corpus — imperative instructions an LLM follows when fetching — scoped to one organization. When an agent fetches any of an org's sources, it should load that org's playbook into context alongside the global skills. Global skills teach general patterns; the playbook overrides with org-specific behavior (naming conventions, what counts as a release, rollup cadence, cross-source dedup rules); per-source `parseInstructions` add source-specific hints on top.

Playbook notes are written by the discovery/worker agents themselves — inline during onboarding/fetch using the rubric in the `managing-sources` skill (Playbooks → Writing good agent notes), or in bulk via the `seeding-playbooks` skill. They're owned by agents, not humans — think "the agent's own notebook for this company," not "operator documentation."

The rubric defines a three-layer routing rule: target-shaped facts go in the playbook; adapter/harness errors route to the `releases-tool-notes` memory store; raw org observations route to the `releases-errata` store. Agents use it to keep playbooks tight and skill-shaped instead of letting transient bugs and onboarding narration pollute the body. `seeding-playbooks` is the bulk-orchestration wrapper — it dispatches sub-agents that follow the same rubric to write or rewrite many playbooks in parallel.

## Claude Code integration

The monorepo's Claude Code assets live under `.claude/` and auto-load on a trusted clone — no plugin, no marketplace, no `/plugin install`. The audience is monorepo developers, who already have the checkout, so native `.claude/` discovery is all that's needed. End users who don't have the repo install the public `releases` plugin from the [`buildinternet/releases-cli`](https://github.com/buildinternet/releases-cli) marketplace instead. (This repo previously shipped a `releases-dev` plugin via a root `.claude-plugin/marketplace.json`; that was redundant ceremony for an audience that already has the working tree, so it was collapsed into `.claude/`.)

**Components:**

- `.claude/skills/` — the production + operator skills; canonical for BOTH managed agents and local Claude Code (see below). User-facing reader skills live in the OSS CLI repo instead.
- `.claude/agents/` — local eval/grader subagents (`rubric-grader`, `overview-writer`). The production discovery/worker prompts live in `managed-discovery.ts` and the `managed-agents/src/shared/*-prompt.ts` builders, not here.
- `.claude/commands/` — repo-local slash commands (e.g. `/discover-changelog`). The consumer-facing `/releases` lookup command is not here — it ships in the public `releases` plugin from the OSS CLI marketplace, so duplicating it in the monorepo only invited drift.
- `.mcp.json` (repo root) — points Claude Code at `mcp.releases.sh`.

**Skill sources of truth — ownership by audience, zero shared files (#1090).** Every skill has exactly one home; nothing is mirrored:

- `.claude/skills/` (this monorepo) owns the **production + operator** skills: the four attached to the managed agents (`finding-changelogs`, `managing-sources`, `parsing-changelogs`, `classify-media-relevance`) and the local-operator set (`local-ingest`, `backfilling-sources`, `maintaining-orgs`, `regenerating-overviews`, `generating-release-content`, `seeding-playbooks`, `grouping-releases`). Claude Code auto-discovers the tree natively; the managed-agent deploy reads the same tree (`scripts/sync-agent-skills.ts`, `bun run deploy:skills`, mapping in `scripts/agent-skills*.json`) and auto-deploys on any `main` push touching `.claude/skills/**`. Top-level `skills/` owns the public owner-facing `creating-releases-json`. Audience groupings for skills.sh live in root `skills.sh.json`.
- The OSS CLI at [`buildinternet/releases-cli`](https://github.com/buildinternet/releases-cli) owns the **user-facing** skills (`releases-cli`, `releases-mcp`, `analyzing-releases`), shipped via its `releases` plugin and `npx skills add buildinternet/releases-cli`. Do not re-add operator-skill copies there, and don't add user-facing skills here — a new skill lands in the repo whose audience consumes it. (The old mirrored copies and the `@buildinternet/releases-skills` npm shim were retired under #1090.)
