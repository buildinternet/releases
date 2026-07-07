# Deploy coupling and open-core boundary

Everything here is Apache-2.0 and runnable locally for contribution — `bun test`, `bun run check`, and `dev:api` + `dev:web` on miniflare-backed D1 need no production credentials. The canonical [releases.sh](https://releases.sh) deployment pins Cloudflare resource IDs, custom domains, Anthropic managed-agent resources, and observability sinks in `workers/{api,mcp,discovery,webhooks}/wrangler.jsonc`.

This doc is what a **fork or self-hoster** must replace. It inventories account-scoped bindings; it does not parameterize them. For local setup, see [CONTRIBUTING.md](../../CONTRIBUTING.md). Staging mirrors prod with different IDs — [AGENTS.md → Staging](../../AGENTS.md#staging).

## Open-core boundary

| Surface                                                   | Without prod bindings | Degrades to                                      |
| --------------------------------------------------------- | --------------------- | ------------------------------------------------ |
| Tests, `check`, `dev:api` + local D1                      | Yes                   | Full contributor path; FTS search; cron off      |
| `dev:web` / `dev:mcp`                                     | Yes                   | UI + MCP against your laptop                     |
| Semantic search                                           | Partial               | FTS when Vectorize or `VOYAGE_API_KEY` is absent |
| Managed agents, email, Firecrawl, webhooks worker, Stripe | No                    | Needs the bindings below                         |

**Rule of thumb:** third-party control planes (Anthropic agents, Firecrawl, Stripe, Axiom) and outbound email are infrastructure-bound. D1 reads/writes through the API worker are reproducible once you provision your own D1 + workers.

## Account-scoped IDs (prod)

Source of truth for names, comments, and staging overrides: the wrangler files. Replace these values in a fork:

| Resource                             | Prod identifier                                                         | Workers                                                          |
| ------------------------------------ | ----------------------------------------------------------------------- | ---------------------------------------------------------------- |
| D1 `released-db`                     | `73be1562-d900-4e25-a62b-650ab74488b7`                                  | api, mcp, discovery, webhooks                                    |
| D1 staging                           | `68d44939-feab-4fcb-8f4f-19778ca1dee8`                                  | api-staging, mcp-staging, discovery-staging                      |
| Secrets Store                        | `store_id` `a887a71cab084105b79706df23380723`                           | all bound secrets                                                |
| Flagship prod                        | `2cf02390-e39a-477a-91c1-571d07b987ef`                                  | api, mcp, discovery                                              |
| Flagship staging                     | `548a95f1-4f8c-402d-8aa2-1b861523d377`                                  | api-staging, mcp-staging, discovery-staging                      |
| KV `EMBED_CACHE`                     | `93b87ae5e253445cabbaaa7a71264915`                                      | api, mcp                                                         |
| KV `LATEST_CACHE` / `ALERT_DEDUP_KV` | `178c70f9abd940478d5b5a053bf123bb`                                      | api, discovery                                                   |
| KV `CREDENTIAL_CACHE`                | `bae0fa6a594448d483176fe90a9a0479`                                      | api                                                              |
| KV `AUTH_RATE_LIMIT_KV`              | `1d1c229b6a71483ab9517bf316e4a7b4`                                      | api                                                              |
| R2 `released-media` / `released-raw` | bucket names                                                            | api                                                              |
| Vectorize                            | `releases-v1`, `entities-v1`, `changelog-chunks-v1`                     | api, mcp — provision via `./scripts/create-vectorize-indexes.sh` |
| Queues                               | `webhook-delivery`, `webhook-dlq`, `digest-delivery`, `release-events`  | api + webhooks                                                   |
| Analytics Engine                     | dataset `webhook_deliveries`                                            | webhooks                                                         |
| Rate limiters                        | `namespace_id` integers (api **100x**, mcp **200x**, webhooks **300x**) | see wrangler `unsafe.bindings`                                   |
| Custom domains                       | `api` / `mcp` / `webhooks.releases.sh` (+ `*-staging` hosts)            | routes in wrangler                                               |
| Service bindings                     | `releases-api`, `releases-discovery` worker names                       | api, mcp, discovery                                              |
| Axiom sinks                          | `axiom-logs`, `axiom-traces`                                            | all workers (observability block)                                |

Unbound optional bindings fail open: no `MEDIA` R2 → third-party media URLs stored verbatim; no Vectorize → FTS; no rate-limit binding → limiter no-ops.

### Secrets Store secret names

Values live in the dashboard, never in git. Forks provision their own store and rebind every `secrets_store_secrets` entry:

`RELEASED_API_KEY`, `RELEASES_API_KEY`, `RELEASES_PROXY_KEY`, `GITHUB_TOKEN`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `VOYAGER_API_KEY`, `ANTHROPIC_API_KEY`, `AI_GATEWAY_TOKEN`, `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `WEBHOOK_HMAC_MASTER`, `INDEXNOW_KEY`, `WEB_BOT_AUTH_PRIVATE_KEY`, `FIRECRAWL_API_KEY`, `FIRECRAWL_WEBHOOK_SECRET`, `RELEASES_GITHUB_WEBHOOK_SECRET`, `STAGING_ACCESS_KEY` (staging only).

Classic worker secret (not in Secrets Store): `ANTHROPIC_BASE_URL` — account-scoped AI Gateway URL on api + discovery; unset → direct Anthropic. Local dev: `workers/*/.dev.vars.example`.

### URL vars and email

Must match your hostnames: `API_BASE_URL`, `BETTER_AUTH_URL`, `WEB_BASE_URL`, `MEDIA_ORIGIN`, `OAUTH_JWT_{ISSUER,AUDIENCE}`, `OAUTH_RESOURCE_AUDIENCES`, `RELEASES_API_URL` (discovery).

Operator alerts: `EMAIL_NOTIFY_TO` (`admin@releases.sh`), `EMAIL_FROM`, `AUTH_EMAIL_FROM`, `DIGEST_EMAIL_FROM` — sender domains must be verified in Cloudflare Email Routing/Sending.

### Anthropic managed agents (prod)

Provisioned via `bun run deploy:agents` / `scripts/sync-agent-skills.ts`. IDs in `workers/discovery/wrangler.jsonc`:

| Var                              | Value                               |
| -------------------------------- | ----------------------------------- |
| `ANTHROPIC_AGENT_ID`             | `agent_011CZtWpasPtsYjF3aysf2ZH`    |
| `ANTHROPIC_COORDINATOR_AGENT_ID` | `agent_011Can9iMPcPuLy3oEgjGCs6`    |
| `ANTHROPIC_ENVIRONMENT_ID`       | `env_01Tq7S8F2FK1KBz68NMje2RU`      |
| `ANTHROPIC_VAULT_ID`             | `vlt_011CZvFkwFPgCkGqRqP87AKB`      |
| `MEMORY_STORE_ERRATA_ID`         | `memstore_012MKStcUM7QxW9qPCLQtwwt` |
| `MEMORY_STORE_TOOL_NOTES_ID`     | `memstore_01Jc5WAiqp4fwSJUmjR2excj` |

Staging uses a separate agent/env/vault/memstore set in `[env.staging]`. API worker binds `MEMORY_STORE_ERRATA_ID` only.

### Outside wrangler

- **Web (Vercel):** `web/.env.example` — `NEXT_PUBLIC_BETTER_AUTH_URL`, `RELEASES_API_URL`, `INDEXNOW_KEY` (must match api secret).
- **MCP Registry:** `sh.releases/mcp` — domain auth via `/.well-known/mcp-registry-auth`; CI secret `MCP_REGISTRY_PRIVATE_KEY_PEM`.
- **Security disclosure:** `security@releases.sh`, [releases.sh/.well-known/security.txt](https://releases.sh/.well-known/security.txt) (no root `SECURITY.md`).

## Fork checklist

1. Provision D1, KV, R2, Vectorize, Queues, Secrets Store, Flagship apps, email.
2. Replace IDs/routes/`store_id` in wrangler; populate secrets from `.dev.vars.example`.
3. `./scripts/create-vectorize-indexes.sh` → `bun run db:migrate:remote` → `bun run deploy` (+ `deploy:agents` if using MAs).
4. Point Vercel (or your web host) at the new API; re-register OAuth, MCP, and inbound webhooks.
