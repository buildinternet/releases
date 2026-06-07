# OpenRouter lane consolidation + finish AI-Gateway routing coverage

**Issues:** #1468, #1474
**Date:** 2026-06-07
**Status:** Approved (design)

## Background

#1466 introduced the OpenRouter cheap-call lane on the `TextModel` seam; #1476 added
the global `elastic-lane-default-openrouter` switch that unset lanes inherit. Two
follow-up issues remain:

- **#1474** — complete AI-Gateway routing coverage: standalone `scripts/` bypass the
  gateway, and OpenRouter itself is called direct (not fronted by the gateway).
- **#1468** — route OpenRouter through the AI Gateway for unified telemetry, and make
  cost accounting read provider-reported `usage.costUsd` rather than the Anthropic-only
  price table.

A secondary goal, set by the maintainer: **reduce feature-flag / env-var proliferation.**
The OpenRouter lane currently carries three flags, and the per-lane two are redundant
with the global switch plus the per-lane model var.

## Current state (verified)

- `resolveTextModel` (`workers/api/src/lib/text-model.ts:85-138`) consults, per lane:
  1. the lane's own flag via `flagState()` (`marketing-classifier-openrouter` /
     `summarize-openrouter`),
  2. the global `elastic-lane-default-openrouter` via `flag()`,
  3. the lane's OpenRouter model var (`MARKETING_CLASSIFIER_MODEL` / `SUMMARIZE_MODEL`).

  `useOpenRouter = laneState === "unset" ? globalDefault : laneState === "on"`. Even when
  `useOpenRouter` is true, an empty model var or missing `OPENROUTER_API_KEY` falls back
  to Anthropic (fail-open).

- The two per-lane flags have **no wrangler var set** — they are Flagship-only with
  `default: false`. Their sole read site is `resolveTextModel`.

- Worker config: `MARKETING_CLASSIFIER_MODEL = "google/gemini-2.5-flash-lite"`,
  `SUMMARIZE_MODEL = ""` (prod and staging). So with the global switch on, the marketing
  lane already routes to OpenRouter and the summarizer already stays on Anthropic.

- Cost accounting: `laneCost()` (`text-model.ts:54-66`) derives Anthropic list price via
  `estimateCost()` and returns `undefined` for non-Anthropic, so OpenRouter's own
  `usage.costUsd` is used; both land in the `ai_usage` Axiom event via `withUsageLogging`.

- Standalone scripts build `new Anthropic({ apiKey })` directly:
  `scripts/generate-release-content.ts:427`, `scripts/smoke-toolloop.ts:48`,
  `scripts/eval-release-content-providers.ts:299`.

## Goals

1. Collapse the three OpenRouter flags to one, renamed from the jargon
   `elastic-lane-default-openrouter` to the plain `openrouter-enabled`
   (env `OPENROUTER_ENABLED`, registry field `openrouterEnabled`),
   behavior-preserving against the current config.
2. Route the two operational standalone scripts through the gateway when configured;
   leave the eval script direct (with a reason).
3. Confirm + document that cost accounting already rolls up `costUsd` per provider.
4. Document (not implement) the OpenRouter-gateway-fronting follow-up.

## Non-goals

- Setting `OPENROUTER_BASE_URL` to front OpenRouter with the gateway — **deferred** to a
  follow-up gated on verifying the gateway exposes an OpenRouter provider (#1468.1 /
  #1474b). The seam already supports it via the existing optional var.
- Any change to the batch summarize/overview paths, which stay Anthropic by design.
- Adding any _net-new_ feature flag or env var. This change set deletes two flags and
  renames the third; it adds no new toggle.

## Design

### Part 1 — Retire the per-lane flags

New rule, replacing the per-lane inheritance:

> A lane uses OpenRouter **iff** `openrouter-enabled` is on **and** that lane has a
> non-empty model var **and** `OPENROUTER_API_KEY` is bound. Otherwise Anthropic.

Per-lane control is preserved through the model var: an empty `SUMMARIZE_MODEL` pins the
summarizer to Anthropic even with the global switch on. This is now the _definitional_
guarantee rather than a flag that must be remembered (resolves the
"pin summarize-openrouter=false" footgun).

Changes:

- `packages/lib/src/flags.ts`: delete the `marketingClassifierOpenrouter` and
  `summarizeOpenrouter` entries. Rename `elasticLaneDefaultOpenrouter` →
  `openrouterEnabled` (key `openrouter-enabled`, env `OPENROUTER_ENABLED`), and refresh
  its comment to describe it as the single switch (no per-lane override) gated by the
  per-lane model var.
- `workers/api/src/lib/text-model.ts`:
  - Drop `flagDef` and `varValue` from `resolveTextModel`'s `opts`.
  - Replace the `flagState` + inheritance block with a single
    `useOpenRouter = await flag(env.FLAGS, env.OPENROUTER_ENABLED, FLAGS.openrouterEnabled)`.
  - Rename `ELASTIC_LANE_DEFAULT_OPENROUTER` → `OPENROUTER_ENABLED` on `TextModelEnv`, and
    remove `MARKETING_CLASSIFIER_OPENROUTER` and `SUMMARIZE_OPENROUTER`.
  - `resolveMarketingModel` / `resolveSummarizeModel` lose their flag wiring; they keep
    `orModel`, `anthropicModel`, `generationName`.
  - `flagState` and `FlagDef` imports become unused here — drop them if no longer
    referenced (keep `flag`, `FLAGS`).
- Grep for any other reader of the old key/var/field (`elasticLaneDefaultOpenrouter`,
  `ELASTIC_LANE_DEFAULT_OPENROUTER`, `elastic-lane-default-openrouter`) and update each.
- `workers/api/src/lib/text-model.test.ts`: replace the per-lane-flag cases with
  global-switch + model-var cases (global on + model set → OpenRouter; global on + empty
  model → Anthropic; global off → Anthropic).
- Comment updates: `workers/api/wrangler.jsonc` (lines ~107-118, ~465, ~571-576),
  `packages/ai/src/release-content.ts` (lines ~11, ~526),
  `workers/api/src/cron/poll-fetch.ts:1029`,
  `workers/api/src/workflows/poll-and-fetch.ts:272`,
  `tests/evals/release-summary.eval.ts:79`, and the `Layer 2` section of
  `docs/architecture/ai-gateway.md` — reword from "behind the `summarize-openrouter`
  flag" / "elastic-lane-default-openrouter global default + per-lane override" to "when
  `openrouter-enabled` is on and a model is configured".

**Flagship migration (ordering matters).** `openrouter-enabled` is a renamed key, so it
must exist in **both** Flagship apps (`releases-platform`, `releases-platform-staging`)
**before** the code that reads it deploys; otherwise `flag()` falls back to the var
(unset) → hardcoded `false` and every lane silently reverts to Anthropic. Sequence:

1. Create `openrouter-enabled` in both apps, set to match the current
   `elastic-lane-default-openrouter` value.
2. Merge/deploy the code (now reading `openrouter-enabled`).
3. Delete the three orphaned keys (`elastic-lane-default-openrouter`,
   `marketing-classifier-openrouter`, `summarize-openrouter`) from both apps. Orphaned
   keys are harmless to leave, but delete them to finish the cleanup.

**Pre-flight before deleting the per-lane keys:** confirm neither per-lane key is
currently set to an explicit `false` in either Flagship app that would be overriding an
`on` global — the only case where removal changes live behavior (would flip the marketing
lane). If one is, decide intentionally before removing.

### Part 2 — Route standalone scripts through the gateway (#1474a)

- `scripts/generate-release-content.ts` and `scripts/smoke-toolloop.ts`: replace
  `new Anthropic({ apiKey })` with
  `buildAnthropicClient({ apiKey, baseURL: process.env.ANTHROPIC_BASE_URL, gatewayToken: process.env.AI_GATEWAY_TOKEN })`.
  Both vars are already documented in `.env.example`; unset → direct, so local runs are
  unchanged. No new env vars.
- `scripts/eval-release-content-providers.ts`: stays direct. Add a one-line comment that
  the eval intentionally measures raw provider latency without a proxy hop, so it does
  not route through the gateway.

### Part 3 — Front OpenRouter with the gateway (deferred, documented)

No code change. In `docs/architecture/ai-gateway.md`, record that fronting OpenRouter
with the gateway (`OPENROUTER_BASE_URL` → the gateway's `/openrouter` sub-path) is a
pending follow-up gated on verifying the `releases`/`releases-staging` gateways expose an
OpenRouter provider, and that the seam already threads the existing optional var when set.
Keep #1468 / #1474 open for that item, or open a focused follow-up.

### Part 4 — Cost-accounting audit + doc (#1468.2)

No code change. Confirm and document in `docs/architecture/ai-gateway.md`:

- Per-provider cost source: Anthropic via `estimateCost()` list price; OpenRouter via the
  provider-reported `usage.costUsd`; both surfaced on the `ai_usage` event.
- Batch summarize/overview use `estimateCost()` and that is correct **because the batch
  paths are Anthropic-only** (no OpenRouter Message Batches equivalent). State this
  invariant explicitly so a future OpenRouter batch path is a known place to revisit.

## Testing

- `workers/api/src/lib/text-model.test.ts`: rewritten cases (above) cover the single
  switch and the model-var gate.
- `bun test` (root + `workers/api`), `npx tsc --noEmit`, `bun run lint`,
  `bun run format:check`.
- Scripts: `scripts/smoke-toolloop.ts` run locally with `ANTHROPIC_BASE_URL` unset (direct)
  to confirm no behavior change; spot-check that setting it routes via the gateway.

## Rollout / risk

- Behavior-preserving against current config (marketing on OpenRouter via the set model;
  summarizer on Anthropic via the empty model). Risk is confined to a per-lane Flagship
  key explicitly overriding the global — caught by the pre-flight check.
- The renamed `openrouter-enabled` remains the single runtime kill-switch: flip off →
  every secondary AI lane reverts to Anthropic instantly.
- Net flag surface: 3 → 1. Net env-var surface: unchanged (the per-lane flags had no var;
  the per-lane _model_ vars stay as the eligibility gate).
