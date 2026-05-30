# 2026-05-30 — Cloudflare Flagship feature-flag migration (Tier 1)

## Goal

Move the Tier 1 boolean operational flags — kill switches and rollout/rollback
gates — off plaintext `wrangler.jsonc` vars and onto Cloudflare Flagship, so they
can be flipped at runtime without a redeploy (and, later, gradually rolled out).

The wrangler vars stay in place as the fallback layer: Flagship is the live
control plane, the var is the automatic backstop, a hardcoded constant is the
last resort. No call site can behave worse than it does today.

## Background

### Current state

Every Tier 1 flag is a string var in each worker's `wrangler.jsonc` (`"FOO": "true"`),
with prod defaults plus `[env.staging]` overrides, read at the call site as
`env.FOO === "true"`. Flipping any of them requires editing wrangler config and
redeploying the worker. Flagship is not referenced anywhere in the repo yet.

### Flagship is provisioned

Two apps already exist (the only Flagship-native way to separate environments —
see below):

| Environment | App name                    | `app_id`                               |
| ----------- | --------------------------- | -------------------------------------- |
| Production  | `releases-platform`         | `2cf02390-e39a-477a-91c1-571d07b987ef` |
| Staging     | `releases-platform-staging` | `548a95f1-4f8c-402d-8aa2-1b861523d377` |

Both app IDs were supplied by the operator and go verbatim into the worker
`flagship` binding blocks (prod in base config, staging in `[env.staging]`).

### Flagship data model (verified against docs, 2026-05-30)

- Hierarchy is flat: **Account → Apps → Flags → Variations**. An app is the
  top-level unit that groups flags. **There is no environment dimension inside an
  app.** Prod/staging separation is achieved with **two apps** (the approach
  taken here), or by passing an `environment` attribute in the evaluation context
  and adding per-flag targeting rules (rejected: every flag needs a rule, and the
  attribute must be threaded into every call site).
- OpenFeature support does **not** imply environments. OpenFeature standardizes
  evaluation (`getBooleanValue`, providers, evaluation context); it leaves
  environments to the provider's management plane, and Flagship models them as
  separate apps.
- The native Workers binding evaluates **asynchronously**:
  `await env.FLAGS.getBooleanValue(key, defaultValue, context)`. The 2nd arg is
  returned when the flag is unset or evaluation fails. Flag config is cached
  in-process, so evaluation is a local lookup, not a per-call network round-trip.

## Non-goals

- Tier 2 numeric tunables (spend caps, jitter window, search-ranking knobs).
  Flagship's `getNumberValue` would fit them, but they change rarely; out of scope
  here. The helper is designed so adding them later is additive.
- Secrets (API keys, signing keys) — Flagship does not store secrets; they stay in
  Secrets Store / wrangler secrets.
- Resource bindings, hostnames, and identity config.
- Removing the wrangler vars. They remain as the fallback layer. A later cleanup
  can drop them once Flagship is trusted, but that is explicitly not part of this
  work.

## Architecture

### Shared helper + registry (`@releases/lib/flags`)

All Tier 1 flags span three workers (`api`, `mcp`, `discovery`) and several are
read in more than one, so the core is one worker-safe module in `packages/lib`,
exported alongside the existing worker-safe `log-event`
(`packages/lib/src/flags.ts` → export `"./flags": "./src/flags.ts"`).

A central registry maps each flag's Flagship key ↔ env-var name ↔ hardcoded
default. The Flagship key is the kebab-case of the env var:

```ts
// packages/lib/src/flags.ts — worker-safe, no fs imports

/** Minimal shape of the native Flagship binding (avoids an npm dep for one method). */
export interface FlagshipBinding {
  getBooleanValue(
    key: string,
    defaultValue: boolean,
    context?: Record<string, unknown>,
  ): Promise<boolean>;
}

export interface FlagDef {
  /** Flagship flag key (kebab-case). Must exist identically in BOTH apps. */
  readonly key: string;
  /** wrangler-var name that supplies the fallback value. */
  readonly env: string;
  /** Hardcoded last-resort default when neither Flagship nor the var is set. */
  readonly default: boolean;
}

export const FLAGS = {
  pollFetchUseWorkflow: {
    key: "poll-fetch-use-workflow",
    env: "POLL_FETCH_USE_WORKFLOW",
    default: false,
  },
  scrapeAgentUseWorkflow: {
    key: "scrape-agent-use-workflow",
    env: "SCRAPE_AGENT_USE_WORKFLOW",
    default: false,
  },
  onboardUseWorkflow: { key: "onboard-use-workflow", env: "ONBOARD_USE_WORKFLOW", default: false },
  mediaR2UploadEnabled: {
    key: "media-r2-upload-enabled",
    env: "MEDIA_R2_UPLOAD_ENABLED",
    default: false,
  },
  feedEnrichEnabled: { key: "feed-enrich-enabled", env: "FEED_ENRICH_ENABLED", default: false },
  scrapeChangeDetectEnabled: {
    key: "scrape-change-detect-enabled",
    env: "SCRAPE_CHANGE_DETECT_ENABLED",
    default: false,
  },
  webBotAuthEnabled: { key: "web-bot-auth-enabled", env: "WEB_BOT_AUTH_ENABLED", default: false },
  invalidationEnabled: { key: "invalidation-enabled", env: "INVALIDATION_ENABLED", default: false },
  indexnowEnabled: { key: "indexnow-enabled", env: "INDEXNOW_ENABLED", default: false },
  enableAiTools: { key: "enable-ai-tools", env: "ENABLE_AI_TOOLS", default: false },
  maSessionsDisabled: { key: "ma-sessions-disabled", env: "MA_SESSIONS_DISABLED", default: false },
  batchSummarizeEnabled: {
    key: "batch-summarize-enabled",
    env: "BATCH_SUMMARIZE_ENABLED",
    default: false,
  },
  batchOverviewEnabled: {
    key: "batch-overview-enabled",
    env: "BATCH_OVERVIEW_ENABLED",
    default: false,
  },
  recommendationsDisabled: {
    key: "recommendations-disabled",
    env: "RECOMMENDATIONS_DISABLED",
    default: false,
  },
  feedbackDisabled: { key: "feedback-disabled", env: "FEEDBACK_DISABLED", default: false },
  rateLimitEnabled: { key: "rate-limit-enabled", env: "RATE_LIMIT_ENABLED", default: false },
  searchQueryLogDisabled: {
    key: "search-query-log-disabled",
    env: "SEARCH_QUERY_LOG_DISABLED",
    default: false,
  },
  apiTokensDisabled: { key: "api-tokens-disabled", env: "API_TOKENS_DISABLED", default: false },
  cacheDisabled: { key: "cache-disabled", env: "CACHE_DISABLED", default: false },
  indexingDisabled: { key: "indexing-disabled", env: "INDEXING_DISABLED", default: false },
  extractToolLoopEnabled: {
    key: "extract-toolloop-enabled",
    env: "EXTRACT_TOOLLOOP_ENABLED",
    default: false,
  },
} as const satisfies Record<string, FlagDef>;

type FlagEnv = Record<string, string | undefined>;

/** Resolve the layered fallback: wrangler var if set, else hardcoded default. */
function fallbackOf(env: FlagEnv, f: FlagDef): boolean {
  const raw = env[f.env];
  return raw === undefined ? f.default : raw === "true";
}

/**
 * Evaluate a flag: Flagship value if set → else wrangler var → else hardcoded default.
 * Any binding-missing or eval error collapses to the var/default. Never throws.
 */
export async function flag(
  binding: FlagshipBinding | undefined,
  env: FlagEnv,
  f: FlagDef,
): Promise<boolean> {
  const fb = fallbackOf(env, f);
  if (!binding) return fb;
  try {
    return await binding.getBooleanValue(f.key, fb, {});
  } catch {
    return fb;
  }
}

/** Batch-evaluate several flags (one binding round of work per request). */
export async function flags<K extends FlagDef>(
  binding: FlagshipBinding | undefined,
  env: FlagEnv,
  defs: readonly K[],
): Promise<boolean[]> {
  return Promise.all(defs.map((d) => flag(binding, env, d)));
}
```

> **Implementation note (signature changed):** the shipped helper is
> `flag(binding, varValue, def)` — the caller passes the specific var _value_
> (`env.CACHE_DISABLED`) rather than the whole env object, because worker `Env`
> interfaces hold non-string bindings and aren't assignable to a string-record.
> The `flags()` batch helper sketched above was **not** built (see Hot-path
> handling). The plan's "Key refinements" section is authoritative for the final
> shapes: `docs/superpowers/plans/2026-05-30-flagship-feature-flags.md`.

**Fallback semantics, restated:** the value handed to `getBooleanValue` as its
default is the env-var-derived boolean. So when a flag has not been created/enabled
in the Flagship dashboard, evaluation returns the var value — i.e. **landing the
helper and bindings changes no behavior until someone sets a flag in Flagship.**
That property drives the rollout plan.

### Binding type wiring

No `worker-configuration.d.ts` is generated; each worker declares an inline `Env`
type. Each worker's `Env` gains `FLAGS?: FlagshipBinding` (optional, so the
fallback path type-checks when the binding is absent — e.g. local `bun test`).
The shared `FlagEnv` shape (`Record<string, string | undefined>`) is structurally
satisfied by every worker `Env`, so `flag(env.FLAGS, env, FLAGS.x)` type-checks
without per-worker glue. No `@cloudflare/flagship` npm dependency is added; the
minimal `FlagshipBinding` interface covers the one method used. (Adding the
OpenFeature SDK is only warranted if we later want multi-provider portability.)

## Environments

- The `flagship` binding is declared in each worker's **base/prod** config with
  the prod `app_id`, and **overridden in `[env.staging]`** with the staging
  `app_id`. Both go through a wrangler var (or are inlined in the binding block) so
  the app_id is the only thing that differs by environment.

```jsonc
// base (prod)
"flagship": [{ "binding": "FLAGS", "app_id": "2cf02390-…" }],
// …
"env": {
  "staging": {
    "flagship": [{ "binding": "FLAGS", "app_id": "548a95f1-4f8c-402d-8aa2-1b861523d377" }]
  }
}
```

- The existing `[env.staging].vars` overrides stay as the staging fallback layer.
  Staging runs no crons, so most flags gate code that never fires there; the
  staging Flagship app is wired for parity and to serve as a pre-prod flip
  rehearsal surface, not because staging behavior depends on it today.
- **Flag-key parity is a maintenance invariant:** every key in the `FLAGS`
  registry must exist in _both_ apps. A unit test asserts the registry is the
  single source of truth; a short runbook note covers "add the key in both apps
  before deploying a new flag."

## Flag inventory & call sites

Path-hotness drives how each is converted (cold = a few evals/min; hot = most
inbound requests).

| Flag (registry)           | Worker(s)      | Decision site(s)                                                                                                                         | Hotness                           |
| ------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| `pollFetchUseWorkflow`    | api            | `index.ts:703`                                                                                                                           | cold (cron)                       |
| `scrapeAgentUseWorkflow`  | api            | `index.ts:631`                                                                                                                           | cold (cron)                       |
| `onboardUseWorkflow`      | api            | `routes/sources.ts:2511`                                                                                                                 | warm (handler)                    |
| `mediaR2UploadEnabled`    | api            | `routes/sources.ts:720`, `cron/poll-fetch.ts:1115` (forwarded at `poll-and-fetch.ts:165`, `onboard-source.ts:80`, `sources.ts:640/2306`) | cold                              |
| `feedEnrichEnabled`       | api            | `cron/poll-fetch.ts:2358`, `cron/feed-enrich.ts:235`                                                                                     | cold                              |
| `scrapeChangeDetect`      | api            | `index.ts:807`, `poll-and-fetch.ts:455`, `cron/poll-fetch.ts:122`                                                                        | cold                              |
| `webBotAuthEnabled`       | api, discovery | `lib/web-bot-auth-fetch.ts:24`, `managed-agents-session.ts:47`                                                                           | cold                              |
| `invalidationEnabled`     | api            | `lib/latest-cache.ts:167`                                                                                                                | warm                              |
| `indexnowEnabled`         | api            | `lib/indexnow.ts:64,144`                                                                                                                 | warm                              |
| `enableAiTools`           | mcp            | `mcp-agent.ts:816,871`                                                                                                                   | warm (per request, stateless SSE) |
| `maSessionsDisabled`      | discovery      | `index.ts:49`                                                                                                                            | cold                              |
| `batchSummarizeEnabled`   | api            | `index.ts:579`, `workflows/batch-summarize.ts:163`                                                                                       | cold                              |
| `batchOverviewEnabled`    | api            | `workflows/batch-overview.ts:146`                                                                                                        | cold                              |
| `recommendationsDisabled` | api            | `routes/recommendations.ts:101`                                                                                                          | warm                              |
| `feedbackDisabled`        | api            | `routes/feedback.ts:51`                                                                                                                  | warm                              |
| `rateLimitEnabled`        | api            | `middleware/rate-limit.ts:65`                                                                                                            | **hot**                           |
| `searchQueryLogDisabled`  | api, mcp       | `packages/search/src/log-search.ts:121,214`                                                                                              | warm                              |
| `apiTokensDisabled`       | api, mcp       | `middleware/auth.ts:41`, `mcp/auth.ts:38`                                                                                                | **hot**                           |
| `cacheDisabled`           | api            | `middleware/cache.ts:26`                                                                                                                 | **hot**                           |
| `indexingDisabled`        | api, mcp       | `middleware/indexing.ts:16`, `mcp/index.ts:10,67`, `lib/indexnow.ts:65,145`                                                              | **hot**                           |
| `extractToolLoopEnabled`  | discovery      | forwarded as string at `managed-agents-session.ts:518` → decided in extract path                                                         | cold                              |

### Conversion rules

1. **Decide at the layer where `env.FLAGS` is in scope, forward booleans
   downstream.** Worker entry points, middleware, route handlers, cron, workflows,
   and worker-internal `lib/*` files all receive the worker `Env` (which now
   carries `FLAGS`), so they call `await flag(env.FLAGS, env, FLAGS.x)` directly.
2. **Two cross-package cases** stop reading env strings and take a resolved
   boolean:
   - `packages/search/src/log-search.ts` — resolve `searchQueryLogDisabled` at the
     two API/MCP callers and pass it in (add a boolean param / field), rather than
     widening the package's env shape to include the binding.
   - `extractToolLoopEnabled` — resolve at the discovery worker boundary
     (`managed-agents-session.ts`) into a boolean before forwarding into the
     extract config, replacing the string passthrough at `:518`.
3. **Forwarded MEDIA/scrape/web-bot flags:** resolve once at the worker boundary
   and forward the resolved boolean instead of re-reading the raw string deep down,
   removing the duplicated `=== "true"` checks.
4. **`cacheDisabled` semantics normalization:** the current `if (c.env.CACHE_DISABLED)`
   truthy check means `"false"` would disable the cache. Converting to the helper
   (`=== "true"` fallback) fixes this. Unset in prod today, so no live behavior
   change; called out so the fix is intentional, not silent.

### Hot-path handling

The four hot flags (`rateLimitEnabled`, `apiTokensDisabled`, `cacheDisabled`,
`indexingDisabled`) run on most inbound API requests. Each is read by a **distinct**
middleware, so every middleware resolves its own flag directly with a single
`await flag(...)` — there is exactly one eval per flag per request regardless, and
Flagship binding lookups are in-process (not a network round-trip per call).

> **Implementation note:** an earlier draft of this section batch-resolved all four
> into one early middleware and stashed them on the Hono context via
> `c.set("flags", …)`. That was dropped during implementation: because each hot
> middleware reads a _different_ flag, batching saved no evaluations and only added
> an ordering dependency (every reader would depend on the batch middleware running
> first). Direct per-middleware `await flag(...)` is simpler and equivalent.

The MCP worker's `apiTokensDisabled` / `indexingDisabled` resolve at its request
boundary the same way — the indexing flag is resolved once in `fetch()` and threaded
into `handle()` so it isn't evaluated twice per request.

## Rollout plan

Because Flagship apps start with no flags and the helper falls back to the existing
vars, the work lands behaviour-neutral and is activated per-flag from the
dashboard.

1. **Foundation (no behavior change):** add `@releases/lib/flags` + registry +
   `FlagshipBinding` type + unit tests; add the `flagship` binding (prod + staging
   app_id) and `FLAGS?` Env field to all three workers. Deploy. Nothing reads the
   binding yet; behavior identical.
2. **Cold flags:** convert the cron/workflow/discovery decision sites + the two
   cross-package cases + forwarded-boolean refactor. Deploy. Still var-backed
   until flags are created in Flagship.
3. **Warm flags:** convert handler/lib decision sites.
4. **Hot flags:** add the batch-resolve middleware; convert the four hot decision
   sites; include the `cacheDisabled` normalization.
5. **Activate:** create the flag keys in both Flagship apps (prod + staging),
   confirm each reads back its var-equivalent value, then exercise one real flip
   (recommended pilot: `media-r2-upload-enabled`, mid-rollout and exercises a true
   on/off, or `ma-sessions-disabled` as the incident kill switch).

Each step is independently deployable and reversible (revert the call-site change;
the var still governs). Whether steps 1–4 ship as one PR or a short series is an
implementation-plan decision.

## Testing

- **Unit (`packages/lib/src/flags.test.ts`):** `flag()` returns the Flagship value
  when the binding yields one; returns the var fallback when the binding is absent;
  returns the var fallback when `getBooleanValue` throws; returns the hardcoded
  default when both binding and var are absent; `fallbackOf` maps `"true"`→true,
  `"false"`/unknown→false, `undefined`→default. Mock binding is a stub object.
- **Registry invariant test:** keys are unique and kebab-case; env names match the
  documented vars.
- **Existing flag-dependent tests** (`mcp-scope-enforcement`, `mcp-lookup-gate`,
  etc.) keep passing: they set the env vars and pass no `FLAGS` binding, so the
  fallback path preserves current behavior. Update only where a signature changed
  (the two cross-package cases).
- **Worker tsc** per worker after the Env-type additions; root `tsc --noEmit`;
  `bun test`.

## Risks & mitigations

- **Eval latency on hot paths** — batch-resolve once per request; binding lookups
  are in-process; fallback is synchronous if the binding is absent.
- **Flagship eval failure** — `try/catch` collapses to the var/default; a failure
  is strictly "behaves like today," never worse.
- **Two-app key drift** — registry is the single source of truth; runbook step to
  create keys in both apps; activation step verifies read-back before relying on a
  flag.
- **Forgotten staging parity** — staging keeps its `[env.staging].vars`, so a
  missing staging flag falls back correctly; parity is for rehearsal, not
  correctness.

## Future work (out of scope)

- Tier 2 numeric tunables via `getNumberValue` (additive to the registry).
- Percentage / targeting rollouts (e.g. gradual `media-r2-upload-enabled`) using
  evaluation context.
- Dropping the wrangler boolean vars once Flagship is trusted as authoritative.
- Optional divergence logging (warn when a Flagship value differs from the var) for
  a bake-in period.
