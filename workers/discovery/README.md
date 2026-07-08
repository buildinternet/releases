# Releases discovery worker

Onboarding-only production entrypoint for the managed-agents discovery harness — a Sonnet coordinator delegating to Haiku workers to find, evaluate, and onboard changelog sources for an organization.

## Layout

| Path                        | Purpose                                                        |
| --------------------------- | -------------------------------------------------------------- |
| `index.ts`                  | Worker entrypoint / routing.                                   |
| `managed-agents-session.ts` | `ManagedAgentsSession` Durable Object driving the harness.     |
| `identity.ts`               | Request/session identity helpers.                              |
| `fetch-wrappers.ts`         | Outbound fetch wrappers (staging-gate header injection, etc.). |
| `session-usage.ts`          | Session usage/cost tracking.                                   |
| `error-response.ts`         | Error response helpers.                                        |
| `types.ts`                  | Shared discovery types.                                        |
| `stubs/`                    | Type stubs for the excluded workspace.                         |

> The `/update` route is retired — the `OrgActor` Durable Object now drains stranded scrape/agent sources via the API worker's `DeterministicUpdateWorkflow`; this worker serves onboarding only.

## Deploy

Deployed as `releases-discovery` (prod) / `releases-discovery-staging` (staging):

```bash
bunx wrangler deploy --config workers/discovery/wrangler.jsonc
bunx wrangler deploy --env staging --config workers/discovery/wrangler.jsonc
```

Local dev: `bun run dev:discovery` (served via portless at `https://discovery.releases.localhost`).

## Docs

| Doc                                                      | Covers                                                                  |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| [agents.md](../../docs/architecture/agents.md)           | Managed agents (discovery + worker), skills, Claude Code integration.   |
| [remote-mode.md](../../docs/architecture/remote-mode.md) | Auth model, cron polling, workflows-based ingest, discovery guardrails. |
