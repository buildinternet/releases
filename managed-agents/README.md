# Managed agents

The Releases changelog-discovery agents — deployed Anthropic managed-agent
definitions plus the harness that drives them. Discovery runs as a Sonnet
coordinator delegating to Haiku workers to find, evaluate, and onboard
changelog sources; the production entrypoint is the discovery worker
(`workers/discovery/`).

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

### Harness code (`src/`)

- `src/agent/managed-discovery.ts` — the harness that drives a discovery session
- `src/agent/discovery.ts` — discovery prompt builder + shared types
- `src/shared/agent-tools.ts` — typed tools available to the agents
- `src/shared/coordinator-prompt.ts`, `discovery-prompt.ts`, `worker-prompt.ts` — prompt builders
- `src/shared/onboard-task-message.ts`, `parse-args.ts`, `memory-store-attach.ts` — supporting harness utilities
- `src/shared/rubrics/*.md` — grader rubrics (`breaking.md`, `collection-summary.md`, `overview.md`, `release-summary.md`)

`src/shared/*` is imported by workers as `@releases/shared/*` and is shared
across the harness, the discovery worker, and the eval suite.

## Docs

- [Managed agents](../docs/architecture/agents.md) — managed agents (discovery + worker), skills, Claude Code integration
