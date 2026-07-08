# Releases discovery worker

Onboarding-only production entrypoint for the managed-agents discovery harness — a Sonnet coordinator delegating to Haiku workers to find, evaluate, and onboard changelog sources for an organization.

## Layout

- `index.ts` — worker entrypoint / routing
- `managed-agents-session.ts` — `ManagedAgentsSession` Durable Object driving the harness
- `identity.ts` — request/session identity helpers
- `fetch-wrappers.ts` — outbound fetch wrappers (staging-gate header injection, etc.)
- `session-usage.ts` — session usage/cost tracking
- `error-response.ts` — error response helpers
- `types.ts` — shared discovery types
- `stubs/` — type stubs for the excluded workspace

Its `/update` route is retired — the `OrgActor` Durable Object now drains stranded scrape/agent sources via the API worker's `DeterministicUpdateWorkflow`; this worker serves onboarding only.

## Deploy

Deployed as `releases-discovery` (prod) / `releases-discovery-staging` (staging):

```bash
bunx wrangler deploy --config workers/discovery/wrangler.jsonc
bunx wrangler deploy --env staging --config workers/discovery/wrangler.jsonc
```

Local dev: `bun run dev:discovery` (served via portless at `https://discovery.releases.localhost`).

## Docs

- [../../docs/architecture/agents.md](../../docs/architecture/agents.md) — managed agents (discovery + worker), skills, Claude Code integration
- [../../docs/architecture/remote-mode.md](../../docs/architecture/remote-mode.md) — auth model, cron polling, workflows-based ingest, discovery guardrails
