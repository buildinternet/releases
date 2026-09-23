# Managed agents

The Releases changelog-discovery agents — deployed Anthropic managed-agent
definitions plus the harness that drives them. Discovery runs as a Sonnet
coordinator delegating to Haiku workers to find, evaluate, and onboard
changelog sources; the production entrypoint is the discovery worker
(`apps/discovery/`).

## Layout

### Agent/environment definitions

- `coordinator.production.agent.yaml` / `coordinator.staging.agent.yaml` — the coordinator agent (Sonnet) that plans discovery and delegates to workers
- `discovery.production.agent.yaml` / `discovery.staging.agent.yaml` — the discovery agent definition
- `worker.production.agent.yaml` / `worker.staging.agent.yaml` — the worker agent (Haiku) that executes fetch/evaluate/onboard steps
- `production.environment.yaml` / `staging.environment.yaml` — per-environment agent environment config

Production and staging are separate deployed resources, not a single
definition with a flag: staging agents and skills are distinct resources
(display title suffixed `(staging)`) so iteration there never affects
production. See [AGENTS.md](../AGENTS.md) for the staging environment details.

### Harness code (`src/agent/`)

- `src/agent/managed-discovery.ts` — the harness that drives a discovery session
- `src/agent/discovery.ts` — discovery prompt builder + shared types

### Prompts, tools, and rubrics

The prompt builders, typed tools (`AGENT_TOOLS`), onboard/memory-store helpers,
and grader rubrics live in [`packages/agent-shared/`](../packages/agent-shared/README.md),
imported as `@releases/agent-shared/*` by the harness, the discovery worker, the
render/sync scripts, and the eval suite. The `*.agent.yaml` files above are
rendered from them with `bun scripts/render-managed-agents.ts`; CI fails if the
committed YAML drifts.

## Docs

- [Managed agents](../docs/architecture/agents.md) — managed agents (discovery + worker), skills, Claude Code integration
