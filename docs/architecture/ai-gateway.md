# AI Gateway passthrough

Optional Cloudflare AI Gateway proxy in front of every direct Anthropic SDK call made from our workers. Enables unified observability (per-route cost + latency), exact-match caching, rate limiting, and provider-level retry / fallback configuration without modifying any call sites.

## Scope

Covered when `ANTHROPIC_BASE_URL` is set:

- `workers/api` — `admin-ai` summarize + compare routes, scrape-agent cron preflight
- `workers/mcp` — AI-backed tools (`summarizeChanges`, `compareProducts`)
- `workers/discovery` — extract-deps agent/incremental paths only (managed-agents sessions are routed direct, see below)
- `scripts/run-eval-task.ts` — local eval runner

Not covered (by design):

- **Voyage embeddings.** Gateway's supported-provider list excludes Voyage; embedding calls go direct. Behavior unchanged.
- **Managed-agent internal loop.** Tool use, skill loading, and sub-agent fanout run inside Anthropic's managed-agents environment on their infra. We only proxy non-streaming SDK calls we originate. Per-tool-call attribution stays in the Anthropic console.
- **Managed-agents session events stream/send + sessions.create + memory store CRUD.** AI Gateway buffers SSE-over-GET responses until the upstream connection closes (#547), which deadlocks `client.beta.sessions.events.stream(...)` because the agent never receives the initial `user.message`. The managed-agents API surface (`/v1/sessions/*`, `/v1/memory_stores/*`) also isn't part of the gateway's documented Anthropic provider scope, so non-Messages paths fall back to authenticated pass-through and reject when the cf-aig-authorization header is missing in some constructor sites (#545). The constructors in `workers/discovery/src/managed-agents-session.ts`, `workers/api/src/routes/errata.ts`, and `src/agent/managed-discovery.ts` (legacy CLI) bypass the gateway by explicitly passing `baseURL: "https://api.anthropic.com"` to the SDK constructor — this overrides the `ANTHROPIC_BASE_URL` env var that the SDK auto-reads, which would otherwise route the call through the gateway. Cost telemetry for session inference still surfaces in the Anthropic console.

## Configuration

Two optional env vars, both no-op when unset (falls back to direct Anthropic API):

- `ANTHROPIC_BASE_URL` — full URL to the gateway's Anthropic sub-path, e.g. `https://gateway.ai.cloudflare.com/v1/<account-id>/<gateway-id>/anthropic`. Plain env var (not a secret).
- `AI_GATEWAY_TOKEN` — Bearer token for Cloudflare AI Gateway authenticated mode. Only required when the gateway is configured to require auth. Provisioned via Secrets Store when needed.

For prod/staging deploys, set `ANTHROPIC_BASE_URL` in the `vars` block of each worker's `wrangler.jsonc`, and bind `AI_GATEWAY_TOKEN` through `secrets_store_secrets` if authenticated mode is enabled. Rollback: unset the var, redeploy.

**Current deploy state.** Both environments run through the gateway in authenticated mode:

| Env        | Gateway ID         | Secret Store key           | Workers             |
| ---------- | ------------------ | -------------------------- | ------------------- |
| Production | `releases`         | `AI_GATEWAY_TOKEN`         | api, mcp, discovery |
| Staging    | `releases-staging` | `AI_GATEWAY_TOKEN_STAGING` | api, mcp, discovery |

Tokens are account-scoped (not gateway-scoped), so the prod and staging tokens are kept separate purely for operational hygiene — they aren't an isolation boundary.

## Shared helper

Every Anthropic SDK constructor goes through `buildAnthropicClient()` in [`packages/lib/src/anthropic-client.ts`](../../packages/lib/src/anthropic-client.ts). The helper is a pure factory — callers that want per-isolate caching (currently just `workers/api/src/lib/anthropic.ts`) wrap it. Errors propagate unchanged so `@releases/lib/anthropic-errors` classification works identically with or without the gateway in front.

Two routing modes:

- **Through the gateway** — pass `baseURL: env.ANTHROPIC_BASE_URL` and `gatewayToken: env.AI_GATEWAY_TOKEN` (when set). The helper attaches the `cf-aig-authorization` header. This is the default for Messages-API call sites listed under Scope above.
- **Direct, bypassing the gateway** — pass `baseURL: "https://api.anthropic.com"` explicitly. The explicit value overrides the `ANTHROPIC_BASE_URL` env var (which the SDK auto-reads if `baseURL` is omitted), forcing the call straight to Anthropic. Required for the call sites listed under "Not covered" above (`workers/discovery/src/managed-agents-session.ts`, `workers/api/src/routes/errata.ts`, `src/agent/managed-discovery.ts`). New code should follow this pattern any time it touches the managed-agents API surface (`/v1/sessions/*`, `/v1/memory_stores/*`).

## What this PR does not configure

Gateway-level features (fallback chains, caching TTLs, rate limits, reranking) are configured in the Cloudflare dashboard, not in this repo. This PR is passthrough only: flip the env var and telemetry starts flowing. Per-route cache config and provider fallbacks land in follow-up changes once there's a week of baseline metrics.

## OpenRouter Broadcast observability

The cheap-call OpenRouter lanes (marketing classifier, live summarizer — see [`packages/ai/src/text-model.ts`](../../packages/ai/src/text-model.ts)) attach optional **Broadcast** trace tags to every request via `OpenRouterTrace` on `openRouterChat`. Broadcast is OpenRouter's account-level observability side-channel: it forwards a copy of each traced request (tokens, cost, latency, model, and our tags) to a configured destination. It is **not** provider fan-out, and it adds no per-call latency (forwarding is server-side, after the response returns).

What the code sends today: a static `trace` block with `generation_name` (`"marketing-classifier"` / `"summarize-release"`, or `"summarize-eval"` from the local eval) and `environment` (the worker's `ENVIRONMENT` var). No prompt/completion content is in the trace block — only labels — so it is never a PII surface on its own.

**The tags are inert until Broadcast is enabled in the OpenRouter dashboard.** To activate (all dashboard, no code):

1. **Cloudflare R2** (stays inside our existing ecosystem — Broadcast's **S3 / S3-compatible** destination speaks the S3 API, which R2 serves): create a bucket, e.g. `released-openrouter-traces`, and an R2 access key/secret with write scope on it.
2. **OpenRouter → Settings → Observability → Broadcast**: add the **S3-compatible** destination pointed at the R2 S3 endpoint (`https://<account-id>.r2.cloudflarestorage.com`) with the bucket name + access key/secret. Trace objects land in R2 as JSON; query them with R2 SQL or any S3 tooling.
3. **Privacy Mode: leave off** for the R2 destination. The prompt content in these lanes is public changelog/release text — the same content we already persist in `release.content` and serve through the API — so a trace copy in our own bucket is no more exposing than what we already publish, and the prompt→completion pair is the most useful part of the trace when debugging a bad summary. Privacy Mode is per-destination, so if a **third-party** sink (Langfuse, Datadog) is added later, strip content there while keeping it full in R2.

This keeps observability entirely within Cloudflare (no new third-party account, no Axiom dataset consumed). It's archival object storage, not a live dashboard — for an at-a-glance per-lane cost/latency UI, **Langfuse** (LLM-eval-specialized, free tier) is a native destination that maps our `generation_name`/`environment` tags directly onto its generation model. Broadcast supports multiple destinations at once, so Langfuse (or Axiom via OTLP) can be added alongside R2 later without disturbing it.

## Routing policy + the elastic-lane provider switch

**Layer 1 — Transport (fixed rule, not a flag).** Every non-managed-agent call traverses exactly one proxy, chosen by protocol — never two in series:

- Anthropic-protocol calls → CF AI Gateway (base-URL passthrough; preserves prompt caching).
- OpenRouter calls → OpenRouter directly.
- Managed-agents session/memory surface → direct to Anthropic (see "Not covered" above).

There is deliberately **no transport-selector flag**: the protocol decides the proxy, so a call is never double-hopped, and CF-AI-Gateway-fronting-OpenRouter is not adopted.

**Layer 2 — Provider selection (the switch).** A single Flagship flag, `openrouter-enabled`, governs every secondary lane on the `TextModel` seam (marketing classifier, live summarizer, …). ON moves each lane that ALSO has an OpenRouter model var configured (e.g. `MARKETING_CLASSIFIER_MODEL`) onto OpenRouter at runtime; OFF returns them all to Anthropic. A lane with an empty model var stays on Anthropic regardless (fail-open), so per-lane control is just "set the model var or leave it empty" — there are no per-lane flags. Implemented in `workers/api/src/lib/text-model.ts` (`resolveTextModel`).

**Unified usage view.** `resolveTextModel` wraps every resolved model in `withUsageLogging`, emitting one `ai_usage` `logEvent` per call: `provider`, `model`, `lane`, `environment`, token counts, and `costUsd` (provider-reported for OpenRouter; derived via `@releases/lib/anthropic-pricing` for Anthropic). These ride in the existing `releases-cloudflare-logs` Axiom dataset as the `ai_usage` event — **no new dataset**. Query example: `["releases-cloudflare-logs"] | where ["event"] == "ai_usage" | summarize sum(toreal(costUsd)) by ["lane"], ["provider"]`. The daily batch summarize/overview workflows are **not** on this seam — they call the Anthropic Message Batches API directly and price via `estimateCost()`. That is correct because there is no OpenRouter Batches equivalent, so batch spend is always Anthropic; a future OpenRouter batch path is the one place this assumption would need revisiting.

**Enabling the switch (Flagship, no deploy).** Create the `openrouter-enabled` key in BOTH Flagship apps (`releases-platform` and `releases-platform-staging`) per the feature-flag convention; default OFF. There is no wrangler var for this flag — Flagship drives it, with the registry default (`false`) as the floor. Rollback is a Flagship toggle.
