# AI Gateway passthrough

Optional Cloudflare AI Gateway proxy in front of every direct Anthropic SDK call made from our workers. Enables unified observability (per-route cost + latency), exact-match caching, rate limiting, and provider-level retry / fallback configuration without modifying any call sites.

## Scope

Covered when `ANTHROPIC_BASE_URL` is set:

- `workers/api` — `admin-ai` summarize + compare routes, scrape-agent cron preflight
- `workers/mcp` — AI-backed tools (`summarizeChanges`, `compareProducts`)
- `workers/discovery` — managed-agents session creation + streaming, extract-deps agent/incremental paths
- `scripts/run-eval-task.ts` — local eval runner

Not covered (by design):

- **Voyage embeddings.** Gateway's supported-provider list excludes Voyage; embedding calls go direct. Behavior unchanged.
- **Managed-agent internal loop.** Tool use, skill loading, and sub-agent fanout run inside Anthropic's managed-agents environment on their infra. We only proxy the _session create_ and direct SDK calls we originate. Per-tool-call attribution stays in the Anthropic console.

## Configuration

Two optional env vars, both no-op when unset (falls back to direct Anthropic API):

- `ANTHROPIC_BASE_URL` — full URL to the gateway's Anthropic sub-path, e.g. `https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/anthropic`. Plain env var (not a secret).
- `AI_GATEWAY_TOKEN` — Bearer token for Cloudflare AI Gateway authenticated mode. Only required when the gateway is configured to require auth. Provisioned via Secrets Store when needed.

For prod/staging deploys, set `ANTHROPIC_BASE_URL` in the `vars` block of each worker's `wrangler.jsonc`, and bind `AI_GATEWAY_TOKEN` through `secrets_store_secrets` if authenticated mode is enabled. Rollback: unset the var, redeploy.

## Shared helper

All five constructor sites route through `buildAnthropicClient()` in [`packages/lib/src/anthropic-client.ts`](../../packages/lib/src/anthropic-client.ts). The helper is a pure factory — callers that want per-isolate caching (currently just `workers/api/src/lib/anthropic.ts`) wrap it. Errors propagate unchanged so `@releases/lib/anthropic-errors` classification works identically with or without the gateway in front.

## What this PR does not configure

Gateway-level features (fallback chains, caching TTLs, rate limits, reranking) are configured in the Cloudflare dashboard, not in this repo. This PR is passthrough only: flip the env var and telemetry starts flowing. Per-route cache config and provider fallbacks land in follow-up changes once there's a week of baseline metrics.
