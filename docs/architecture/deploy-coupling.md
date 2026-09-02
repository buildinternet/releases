# Deploy coupling and open-core boundary

Everything here is Apache-2.0 and runnable locally for contribution. The
canonical [releases.sh](https://releases.sh) deployment pins Cloudflare resource
IDs, custom domains, Anthropic managed-agent resources, and observability sinks
in `workers/{api,mcp,discovery,webhooks}/wrangler.jsonc`.

This doc is what a **fork or self-hoster** must replace. It inventories account-scoped bindings; it does not parameterize them. For local setup, see [CONTRIBUTING.md](../../CONTRIBUTING.md). Staging mirrors prod with different IDs — [AGENTS.md → Staging](../../AGENTS.md#staging).

## The short version

You can contribute locally without production infrastructure. `bun test`,
`bun run check`, and `dev:api` + `dev:web` on miniflare-backed D1 need no
production credentials.

Self-hosting the full releases.sh stack means replacing account-scoped
Cloudflare, Anthropic, Vercel, email, Firecrawl, and observability resources.
Most contributors never need this inventory; self-hosters do.

## What works locally

| Surface                                                   | Without prod bindings | Degrades to                                      |
| --------------------------------------------------------- | --------------------- | ------------------------------------------------ |
| Tests, `check`, `dev:api` + local D1                      | Yes                   | Full contributor path; FTS search; cron off      |
| `dev:web` / `dev:mcp`                                     | Yes                   | UI + MCP against your laptop                     |
| Semantic search                                           | Partial               | FTS when Vectorize or `VOYAGE_API_KEY` is absent |
| Managed agents, email, Firecrawl, webhooks worker, Stripe | No                    | Needs the bindings below                         |

**Rule of thumb:** third-party control planes (Anthropic agents, Firecrawl, Stripe, Axiom) and outbound email are infrastructure-bound. D1 reads/writes through the API worker are reproducible once you provision your own D1 + workers.

## Replacement checklist

1. Provision Cloudflare resources: D1, KV, R2, Vectorize, Queues, Secrets Store,
   Flagship apps, rate limiters, and email.
2. Replace IDs, routes, `store_id`, service bindings, and custom domains in the
   worker `wrangler.jsonc` files.
3. Provision every Secrets Store secret referenced by the worker, including a valid
   `IDEMPOTENCY_ENCRYPTION_KEY` for API deployments, before any idempotency migration
   or deploy. Generate exactly 32 random bytes and base64-encode them; never place
   the value in a vars or environment file. See [idempotency.md](idempotency.md).
4. Run `./scripts/create-vectorize-indexes.sh`, then `bun run db:migrate:remote`,
   then `bun run deploy`.
5. Deploy managed agents with `bun run deploy:agents` if you are using the
   hosted discovery flow.
6. Point Vercel or your web host at the new API, then re-register OAuth, MCP,
   and inbound webhooks for your domains.

## Full binding inventory

Source of truth for names, comments, and staging overrides: the wrangler files.
Replace these values in a fork.

### Account-scoped IDs (prod)

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

`RELEASED_API_KEY`, `RELEASES_API_KEY`, `RELEASES_PROXY_KEY`, `IDEMPOTENCY_ENCRYPTION_KEY`, `GITHUB_TOKEN`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_API_KEY`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `VOYAGER_API_KEY`, `ANTHROPIC_API_KEY`, `AI_GATEWAY_TOKEN`, `OPENROUTER_API_KEY`, `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `WEBHOOK_HMAC_MASTER`, `WEB_SERVICE_KEY` (prod only — see below), `WEB_BOT_AUTH_PRIVATE_KEY`, `FIRECRAWL_API_KEY`, `FIRECRAWL_WEBHOOK_SECRET`, `RELEASES_GITHUB_WEBHOOK_SECRET`, `STAGING_ACCESS_KEY` (staging only).

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

### Container image retention

**Content-hash pin (#2261).** Before #2261, the discovery worker's `Sandbox` container was built from `workers/discovery/Dockerfile` on every `wrangler deploy`, so each deploy pushed a fresh, unpruned tag — how `releases-discovery-sandbox` reached 712 tags. `containers[].image` (root **and** `env.staging` — both container apps accept the same prod registry reference) is now pinned to a literal `registry.cloudflare.com/<account>/releases-discovery-sandbox:<tag>`, where `<tag>` is `sha256(manifest of the Dockerfile's real inputs).slice(0, 12)` — the Dockerfile plus the `.claude/skills/` tree it `COPY`s (build context is the repo root). Managed by `scripts/discovery-container-image.ts` (ports buildinternet/sunny#1657/#1773; Sunny reference: `scripts/render-container-image.mjs`):

- `bun run containers:image tag` — print the current tag.
- `bun run containers:image check` — fail if wrangler.jsonc doesn't pin it (runs in CI's `test` job so a stale pin fails the PR).
- `bun run containers:image write` — rewrite both `image` fields to the current tag.
- `bun run containers:image ensure` — hard-fail if wrangler.jsonc doesn't pin the current tag, otherwise check `wrangler containers images list --json` (the only trusted exists oracle) and build + push only if missing. Idempotent; runs before `wrangler deploy` in the discovery job of `deploy-workers.yml`. A deploy no longer pushes a new image unless the Dockerfile or the skills it bundles actually changed — the **first** CI deploy after this PR merges still builds and pushes the pinned tag once (the tag isn't in the registry yet); every deploy after that is a no-op unless the inputs move again.
- `wrangler containers build <PATH>` has no separate build-context flag — it expects the Dockerfile literally at `<PATH>/Dockerfile` with `<PATH>` as context, which can't express this repo's split (Dockerfile at `workers/discovery/Dockerfile`, context the repo root). `ensure` instead runs `docker build -f workers/discovery/Dockerfile <repo root>` directly, then `wrangler containers push` — the same two primitives `containers build -p` composes internally.
- **Local `wrangler dev`/`preview:discovery`:** fails hard (`docker: failed to resolve reference … not found`) if the pinned tag hasn't been pushed yet (confirmed by testing). Run `bun run containers:image ensure` once locally (needs Docker + `wrangler` auth) before starting dev against a freshly-pinned tag that CI hasn't deployed yet.

**Prune (#2260, updated for #2261).** `scripts/prune-container-images.ts` deletes registry tags outside a keep set, spanning both the pre- and post-#2261 tagging schemes during the transition:

- **Keep policy:** the union of (1) the content-hash tag currently pinned in the working tree, (2) the pinned tag at each of the last `--keep` (default 5) commits on `origin/main` that touched `workers/discovery/wrangler.jsonc` (Sunny's `resolveTagsFromGitHistory`, buildinternet/sunny#1771), and (3) per environment, the currently deployed Worker version's tag plus the previous `--keep` deployed versions (the old version-id scheme, still live until each environment redeploys under the new pin).
- **Tag ↔ version link (version-id era):** the tag is the first 8 hex chars of the Worker version id (`wrangler deployments list --json`). `versions view` never exposes the image, so the script proves the link before deleting: for each environment, the live app's image digest (`wrangler containers info`) must equal the registry digest of **some** tag in that environment's keep set — the content-hash tag once redeployed post-#2261, or still the version-id tag until then. Any mismatch aborts without deleting anything.
- **Run:** `CLOUDFLARE_ACCOUNT_ID=<Build Internet account> bun run containers:prune` (dry run) → review → add `--yes`. Only `wrangler containers images list --json` is trusted as the exists/doesn't oracle; the registry tags endpoint under-reports and `docker manifest inspect` reports expired logins as "missing".
- **Scope:** `releases-discovery-sandbox` by default. `--repo releases-discovery-staging-sandbox-staging` prunes the pre-#2261 staging repo (orphaned — staging now pulls from the prod repo); the script refuses that repo while any live container app still references it, and still keeps staging's recent version-id tags for rollback. Any other repo name (`sunny-render*`, …) is rejected outright.
- **Blob sharing:** layers dedupe across tags (a 200 MB image; ~4 GB of unique blobs across 700 tags), so what the cap counts may differ from the per-tag sum. The dashboard is the only place that shows account-wide usage.

### Outside wrangler

- **Web (Vercel):** `web/.env.example` — `NEXT_PUBLIC_BETTER_AUTH_URL`, `RELEASES_API_URL`, `RELEASES_SERVICE_KEY` (channel credential for API-worker → web internal endpoints, mirroring `RELEASES_PROXY_KEY` inbound; must match the api worker's `WEB_SERVICE_KEY`; deliberately unbound on staging so prod ingest can't reach staging web's ISR cache).
- **MCP Registry:** `sh.releases/mcp` — domain auth via `/.well-known/mcp-registry-auth`; CI secret `MCP_REGISTRY_PRIVATE_KEY_PEM`.
- **Security disclosure:** `security@releases.sh`, [releases.sh/.well-known/security.txt](https://releases.sh/.well-known/security.txt) (no root `SECURITY.md`).
