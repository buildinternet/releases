# Deploy coupling and open-core boundary

Everything in this repo is Apache-2.0 and runnable locally for contribution — `bun test`, `bun run check`, and `dev:api` + `dev:web` on miniflare-backed D1 need no production credentials. The canonical [releases.sh](https://releases.sh) deployment is a separate concern: worker `wrangler.jsonc` files pin Cloudflare resource IDs, custom domains, Anthropic managed-agent resources, and observability sinks that belong to the Build Internet account.

This doc is the inventory a **fork or self-hoster** must replace to run their own stack. It documents bindings; it does not parameterize them into env vars. For local setup, see [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Open-core boundary

| Surface | Runs without prod bindings? | What you get |
| ------- | --------------------------- | ------------ |
| Unit/route tests, `bun run check` | Yes | Full CI parity, no external accounts |
| `dev:api` + local D1 | Yes | REST API, auth (with `BETTER_AUTH_SECRET_DEV`), FTS search, cron disabled |
| `dev:web` | Yes (point at local API) | UI against your laptop |
| `dev:mcp` / `dev:discovery` | Yes (limited) | MCP tools; discovery onboarding only — no managed-agent dispatch without Anthropic agent IDs |
| Semantic search (Vectorize + Voyage) | Partial | Code paths fail-open to FTS when `VOYAGE_API_KEY` or Vectorize indexes are absent |
| Managed-agent discovery/onboarding | No | Requires Anthropic agent + environment + vault + memory stores (see below) |
| Email (digests, alerts, auth mail) | No | Requires Cloudflare Email Routing/Sending + verified sender domains |
| Firecrawl monitoring | No | Requires `FIRECRAWL_*` secrets and inbound webhook routing to prod |
| Webhook delivery worker | No | Requires Queues + Analytics Engine + `WEBHOOK_HMAC_MASTER` |
| Stripe customer seam | No | Inert until both `STRIPE_*` secrets resolve; no subscriptions yet |
| Hosted registry data | N/A | The public catalog at releases.sh is operational data, not shipped in git |

**Rule of thumb:** if a feature talks to a third-party control plane (Anthropic agents, Firecrawl, Stripe, Axiom) or sends email, assume it is infrastructure-bound. If it reads/writes D1 through the API worker, it is reproducible once you provision your own D1 + workers.

## Cloudflare account resources

Source of truth: `workers/{api,mcp,discovery,webhooks}/wrangler.jsonc`. Staging blocks (`[env.staging]`) mirror the shape with different IDs — see [AGENTS.md → Staging](../../AGENTS.md#staging).

### D1

| Binding | Prod `database_name` | Prod `database_id` | Workers |
| ------- | -------------------- | ------------------ | ------- |
| `DB` | `released-db` | `73be1562-d900-4e25-a62b-650ab74488b7` | api, mcp, discovery, webhooks |
| `DB` (staging) | `released-db-staging` | `68d44939-feab-4fcb-8f4f-19778ca1dee8` | api-staging, mcp-staging, discovery-staging |

Migrations live in `workers/api/migrations/`. Apply with `wrangler d1 migrations apply` on deploy (automated in CI) or `bun run db:migrate:remote` manually.

### KV namespaces

| Binding | Prod `id` | Used for |
| ------- | --------- | -------- |
| `EMBED_CACHE` | `93b87ae5e253445cabbaaa7a71264915` | Query-embedding cache (api + mcp) |
| `LATEST_CACHE` | `178c70f9abd940478d5b5a053bf123bb` | `GET /v1/releases/latest` cache; MA kill switch + spend counters (api + discovery) |
| `ALERT_DEDUP_KV` | `178c70f9abd940478d5b5a053bf123bb` | Tier-1 alert dedup (reuses `LATEST_CACHE` namespace, distinct key prefix) |
| `CREDENTIAL_CACHE` | `bae0fa6a594448d483176fe90a9a0479` | Account-tier rate-limit credential memoization (api only) |
| `AUTH_RATE_LIMIT_KV` | `1d1c229b6a71483ab9517bf316e4a7b4` | Better Auth brute-force counters (api only) |

`preview_id` values are for `wrangler dev` / miniflare — forks can keep them or provision preview namespaces in their account.

### R2

| Binding | `bucket_name` | Role |
| ------- | ------------- | ---- |
| `MEDIA` | `released-media` | Public mirrored media (`https://media.releases.sh/...`) |
| `RAW_SNAPSHOTS` | `released-raw` | Ephemeral scrape snapshots for backfill/re-extract (90-day lifecycle) |

Unbound `MEDIA` → ingest stores third-party media URLs verbatim. Unbound `RAW_SNAPSHOTS` → raw capture and durable backfill paths no-op.

### Vectorize

Provision once: `./scripts/create-vectorize-indexes.sh`. Index names (not account-specific UUIDs):

| Binding | `index_name` |
| ------- | ------------ |
| `RELEASES_INDEX` | `releases-v1` |
| `ENTITIES_INDEX` | `entities-v1` |
| `CHANGELOG_CHUNKS_INDEX` | `changelog-chunks-v1` |

Absent indexes → hybrid search degrades to FTS; MCP/API set `degraded: true` on related endpoints.

### Queues

| Queue name | Producer | Consumer |
| ---------- | -------- | -------- |
| `webhook-delivery` | api | webhooks |
| `webhook-dlq` | — | webhooks (DLQ) |
| `digest-delivery` | api | api |
| `release-events` | api | api |

Staging omits consumers where crons are disabled; queue names can be reused within an account.

### Analytics Engine

| Binding | `dataset` | Worker |
| ------- | --------- | ------ |
| `WEBHOOK_DELIVERIES_AE` | `webhook_deliveries` | webhooks |

### Durable Objects + Workflows

Declared in `workers/api/wrangler.jsonc`: `StatusHub`, `ReleaseHub`, `SourceActor`, `OrgActor`, and the workflow classes under `workers/api/src/workflows/`. DO migrations are in the wrangler `migrations` array — deploy creates SQLite backing per colo.

Discovery worker DOs: `Sandbox` (container-backed), `ManagedAgentsSession`.

### Rate limiters (`unsafe.bindings`)

`namespace_id` is a developer-chosen integer, **account-scoped** (shared IDs share counters across workers). Allocation convention: **api = 100x**, **mcp = 200x**, **webhooks = 300x**.

| Worker | Binding | `namespace_id` |
| ------ | ------- | -------------- |
| api | `PUBLIC_RATE_LIMITER` | 1001 |
| api | `TOKEN_RATE_LIMITER` | 1002 |
| api | `FEEDBACK_RATE_LIMITER` | 1003 |
| api | `WEBHOOK_TEST_SUB_RATE_LIMITER` | 1004 |
| api | `WEBHOOK_TEST_USER_RATE_LIMITER` | 1005 |
| api | `USER_RATE_LIMITER` | 1006 |
| api | `AUTH_RATE_LIMITER` | 1007 |
| api | `LISTING_RATE_LIMITER` | 1008 |
| api | `LISTING_DOMAIN_RATE_LIMITER` | 1009 |
| mcp | `PUBLIC_RATE_LIMITER` | 2001 |
| mcp | `TOKEN_RATE_LIMITER` | 2002 |
| mcp | `USER_RATE_LIMITER` | 2006 |
| webhooks | `PER_SUB_RATE_LIMITER` | 3002 |

Absent bindings → limiter calls no-op (fail-open). Staging api block omits the entire `unsafe` section.

### Flagship (feature flags)

| Environment | App name | `app_id` |
| ----------- | -------- | -------- |
| Production | `releases-platform` | `2cf02390-e39a-477a-91c1-571d07b987ef` |
| Staging | `releases-platform-staging` | `548a95f1-4f8c-402d-8aa2-1b861523d377` |

Each flag key must exist in **both** apps when you use Flagship. Unbound `FLAGS` → `flag()` falls back to wrangler vars. Registry: `@releases/lib/flags`; reference: [feature-flags.md](feature-flags.md).

### Secrets Store

All workers share one store in the canonical deployment:

- `store_id`: `a887a71cab084105b79706df23380723`

Secret **names** bound (values live in the dashboard, never in git):

| Secret name | Typical bindings |
| ----------- | ---------------- |
| `RELEASED_API_KEY` / `RELEASES_API_KEY` | Root API credential (dual-bound during prefix migration) |
| `RELEASES_PROXY_KEY` | Web server-to-server rate-limit bypass (api) |
| `GITHUB_TOKEN` | GitHub adapter rate limits (api) |
| `BETTER_AUTH_SECRET` | Session signing (api) |
| `BETTER_AUTH_API_KEY` | Better Auth Infrastructure / dash plugin (api) |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google OAuth + One Tap (api) |
| `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe customer seam (api, prod only) |
| `VOYAGER_API_KEY` | Voyage embeddings (api, mcp) |
| `ANTHROPIC_API_KEY` | Direct SDK calls (api, discovery) |
| `AI_GATEWAY_TOKEN` | Cloudflare AI Gateway auth (api, discovery) |
| `OPENROUTER_API_KEY` | Cheap-call lanes when `openrouter-enabled` (api, discovery) |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | Browser Rendering escalation (api, discovery) |
| `WEBHOOK_HMAC_MASTER` | Subscriber HMAC + webhook signing (api, webhooks) |
| `INDEXNOW_KEY` | IndexNow pings (api; also mirrored in Vercel for `/{key}.txt`) |
| `WEB_BOT_AUTH_PRIVATE_KEY` | Signed bot crawl headers (api, discovery) |
| `FIRECRAWL_API_KEY` / `FIRECRAWL_WEBHOOK_SECRET` | Firecrawl monitor path (api) |
| `RELEASES_GITHUB_WEBHOOK_SECRET` | Inbound GitHub App webhooks (api, prod only) |
| `STAGING_ACCESS_KEY` | Staging access gate (api-staging, mcp-staging, discovery-staging) |

Forks provision their own Secrets Store (or classic `wrangler secret put` for keys not yet on Secrets Store) and replace `store_id` in every `secrets_store_secrets` entry.

### Classic worker secrets (not in Secrets Store)

| Secret | Workers | Notes |
| ------ | ------- | ----- |
| `ANTHROPIC_BASE_URL` | api, discovery (prod + staging) | Account-scoped AI Gateway URL; unset → direct Anthropic. **Never commit** — provisioned via `wrangler secret put`. |

Local dev uses `.dev.vars` per worker; see each `workers/*/.dev.vars.example`.

## Custom domains and service bindings

| Worker | Prod route | Staging route |
| ------ | ---------- | ------------- |
| api | `api.releases.sh` | `api-staging.releases.sh` |
| mcp | `mcp.releases.sh` | `mcp-staging.releases.sh` |
| webhooks | `webhooks.releases.sh` | (not deployed) |
| discovery | (service binding only) | `releases-discovery-staging` |

Service bindings (replace worker **names** when you rename deploys):

| Consumer | Binding | Target service |
| -------- | ------- | -------------- |
| api | `DISCOVERY_WORKER` | `releases-discovery` |
| api | `API_SELF` | `releases-api` |
| mcp | `API` | `releases-api` |
| discovery | `API_WORKER` | `releases-api` |

URL vars that must match your domains: `API_BASE_URL`, `BETTER_AUTH_URL`, `WEB_BASE_URL`, `MEDIA_ORIGIN`, `OAUTH_JWT_{ISSUER,AUDIENCE}`, `OAUTH_RESOURCE_AUDIENCES`, `RELEASES_API_URL` (discovery).

Email sender/recipient vars in wrangler (not Secrets Store): `EMAIL_FROM`, `EMAIL_NOTIFY_TO`, `AUTH_EMAIL_FROM`, `DIGEST_EMAIL_FROM` — domains must be verified for Cloudflare Email Routing/Sending.

## Anthropic managed agents

Provisioned via `scripts/sync-agent-skills.ts` and `bun run deploy:agents`. IDs in `workers/discovery/wrangler.jsonc`:

### Production

| Var | Value |
| --- | ----- |
| `ANTHROPIC_AGENT_ID` | `agent_011CZtWpasPtsYjF3aysf2ZH` (worker / Haiku) |
| `ANTHROPIC_COORDINATOR_AGENT_ID` | `agent_011Can9iMPcPuLy3oEgjGCs6` (discovery / Sonnet) |
| `ANTHROPIC_ENVIRONMENT_ID` | `env_01Tq7S8F2FK1KBz68NMje2RU` |
| `ANTHROPIC_VAULT_ID` | `vlt_011CZvFkwFPgCkGqRqP87AKB` |
| `MEMORY_STORE_ERRATA_ID` | `memstore_012MKStcUM7QxW9qPCLQtwwt` |
| `MEMORY_STORE_TOOL_NOTES_ID` | `memstore_01Jc5WAiqp4fwSJUmjR2excj` |

API worker binds `MEMORY_STORE_ERRATA_ID` only (errata writes). Skills deploy to the vault; mappings live in `scripts/agent-skills.json`.

### Staging

Separate agent/env/vault/memstore IDs in the `[env.staging]` block — never share with prod.

## Observability

Worker `observability` blocks ship logs/traces to Axiom destinations:

- `axiom-logs`
- `axiom-traces`

These are account-configured sinks in the Cloudflare dashboard. Forks either create their own destinations or disable observability export.

## Web frontend (Vercel)

The Next.js app in `web/` deploys separately (not via wrangler). Forks need their own Vercel project and env — see `web/.env.example`. Notable couplings:

- `NEXT_PUBLIC_BETTER_AUTH_URL` → your API worker origin (drives auth UI)
- `RELEASES_API_URL` / proxy keys for server-side fetches
- `INDEXNOW_KEY` must match the API worker secret for ownership file serving
- Image/media URLs assume `MEDIA_ORIGIN` (`https://media.releases.sh` by default)

## MCP Registry

Canonical listing: `sh.releases/mcp` (`workers/mcp/server.json`). Publishing uses HTTP-domain auth against `releases.sh` (`/.well-known/mcp-registry-auth`) and the `MCP_REGISTRY_PRIVATE_KEY_PEM` CI secret. Forks register under their own domain/name.

## Security disclosure

Vulnerability reporting is **not** gated on a root `SECURITY.md`. Canonical policy: [releases.sh/security](https://releases.sh/security) and [/.well-known/security.txt](https://releases.sh/.well-known/security.txt) (`security@releases.sh`).

## Checklist for a new deployment

1. Create D1, KV, R2, Vectorize, Queues, Secrets Store, Flagship apps, Email Routing/Sending.
2. Replace every `database_id`, KV `id`, `store_id`, Flagship `app_id`, and custom-domain route in wrangler files.
3. Populate Secrets Store (or worker secrets) from `.dev.vars.example` templates.
4. Run `./scripts/create-vectorize-indexes.sh` and `bun run db:migrate:remote`.
5. Deploy workers (`bun run deploy` or CI), then `bun run deploy:agents` if using managed agents.
6. Point Vercel (or your web host) at the new API origin and auth URL.
7. Re-register MCP / OAuth redirect URIs / webhooks (Firecrawl, GitHub App, Stripe) against the new hostnames.