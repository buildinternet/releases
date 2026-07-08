# Releases API worker

The Cloudflare Worker serving the public REST API at `api.releases.sh` — a Hono
router over Cloudflare D1, plus the cron/Workflow ingest orchestration,
Durable Objects, and the OAuth/auth surface. Deployed as `releases-api`.

## Layout

| Path                                                                        | Purpose                                                                                     |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                              | Worker entrypoint — routing, middleware wiring, scheduled/queue handlers.                   |
| `src/routes/`                                                               | REST route handlers (org/source/release CRUD, lookups, admin, listing, webhooks).           |
| `src/v1-routes.ts`, `src/route-namespaces.ts`                               | Route registration and naming-bucket wiring.                                                |
| `src/graphql/`                                                              | GraphQL schema/resolvers for web frontend consumers.                                        |
| `src/cron/`                                                                 | Scheduled tasks (poll re-seed heartbeat, staleness scans, overview/summary regen, digests). |
| `src/workflows/`                                                            | Cloudflare Workflows (deterministic update, backfill-source, reextract-source).             |
| `src/queues/`                                                               | Queue consumers.                                                                            |
| `src/db/`, `src/db.ts`, `src/queries/`                                      | Drizzle D1 client, schema wiring, and query helpers.                                        |
| `src/middleware/`                                                           | Hono middleware (auth, rate limiting, staging gate, error handling).                        |
| `src/auth/`                                                                 | Better Auth configuration (sessions, OAuth provider, passkeys, API keys, workspaces).       |
| `src/source-actor.ts`                                                       | `SourceActor` Durable Object — per-source fetch alarm/backoff driver.                       |
| `src/org-actor.ts`                                                          | `OrgActor` Durable Object — per-org scrape/agent drain coordinator.                         |
| `src/release-hub.ts`                                                        | `ReleaseHub` Durable Object — WebSocket release event bus.                                  |
| `src/status-hub.ts`                                                         | Status/health Durable Object.                                                               |
| `src/openapi.ts`                                                            | OpenAPI spec generation / coverage gate.                                                    |
| `src/webhooks/`                                                             | Outbound webhook signing and fan-out.                                                       |
| `src/lib/`, `src/utils.ts`, `src/stubs/`                                    | Worker-local helpers and test stubs.                                                        |
| `src/playbook-regen.ts`, `src/related-ranking.ts`, `src/oauth-discovery.ts` | Misc route-support modules.                                                                 |

## Deploy

Deployed as `releases-api` (production) and `releases-api-staging` (staging — a
read-surface for UI/API iteration; see the Staging section of the top-level
[`AGENTS.md`](../../AGENTS.md)).

```bash
bunx wrangler deploy --config workers/api/wrangler.jsonc
bunx wrangler deploy --env staging --config workers/api/wrangler.jsonc
```

Local dev: `bun run dev:api` (runs through [portless](https://github.com/vercel-labs/portless)
at `https://api.releases.localhost`; requires `workers/api/.dev.vars`, see
`.dev.vars.example`).

## Docs

| Doc                                                   | Covers                                                                        |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| [Routing](../../docs/architecture/routing.md)         | REST route surface, org-scoped routes, lookups, pagination.                   |
| [Remote mode](../../docs/architecture/remote-mode.md) | D1, auth model, rate limiting, cron/Workflows ingest, Durable Object drivers. |
| [Ingest pipeline](../../docs/architecture/ingest.md)  | Adapters, dedup, smart-fetch backoff, AI passes.                              |
| [Errors](../../docs/architecture/errors.md)           | Standardized error envelope and taxonomy.                                     |
| [Events](../../docs/architecture/events.md)           | `ReleaseHub` Durable Object and the release event bus.                        |
