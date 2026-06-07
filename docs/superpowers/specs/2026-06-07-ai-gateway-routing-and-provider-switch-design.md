# AI Gateway routing policy + elastic-lane provider switch

**Date:** 2026-06-07
**Status:** Design — awaiting review
**Related:** #1474 (gateway routing coverage), #1466/#1467/#1470 (TextModel seam + cheap-call lanes), #1472 (OpenRouter Broadcast trace tags), `docs/architecture/ai-gateway.md`

## Problem

Every AI model call we originate (excluding the Anthropic managed-agents session/memory surface) should be (a) routed through a gateway, (b) visible in one unified cost/latency view, and (c) shiftable between our two credit pools (Anthropic-via-CF-AI-Gateway and OpenRouter) on a clean, reversible switch.

Today:

- Anthropic-protocol calls route through **CF AI Gateway** (base-URL passthrough; prod + staging; `api`/`mcp`/`discovery`). Worker paths are fully covered — every client is built via `buildAnthropicClient()`.
- The cheap-call **OpenRouter** lane (marketing classifier, live summarizer) calls OpenRouter **directly**, via the protocol-agnostic `TextModel` seam, gated by per-lane flags.
- Observability is split: Anthropic spend in the CF dashboard, OpenRouter spend in OpenRouter. There is no single view.
- There is no single knob to move the elastic lanes between providers; each lane has its own flag, each defaulting to `false`.

The instinct to add "a flag that picks which gateway the non-managed-agent stuff goes through" conflates two concerns and is defeated by a protocol asymmetry (below). This spec separates the concerns and defines the minimal control surface that satisfies all three goals.

## Goals

1. **Unify observability** — one owned query surface for all non-managed-agent AI spend.
2. **Simplify** — one clear mental model; no per-call "which gateway" branching.
3. **Optionality** — a clean, reversible, runtime switch to shift the elastic lanes between credit pools (no specific pool is the target; the lever is what matters).

## Non-goals

- A transport-selector flag (rejected — see Architecture).
- Migrating the protocol-locked Anthropic calls (incremental extraction's `tool_use`, MCP tools, batch workflows) onto the seam. Separate, incremental follow-on; the switch's coverage grows as they migrate.
- Fronting OpenRouter _with_ CF AI Gateway (the daisy-chain), a D1 usage table, or a Langfuse sink. All rejected or deferred in favor of the owned Axiom surface.
- Any change to the managed-agents session/memory path (stays direct to Anthropic, unchanged).

## Key constraint: protocol asymmetry

CF AI Gateway fronts the Anthropic **Messages** API, so routing an Anthropic call through it is a transparent base-URL swap — which is why our Anthropic-protocol call sites already run through it untouched, keeping ephemeral prompt caching. OpenRouter speaks the OpenAI **chat-completions** protocol. The two are **not** wire-compatible. Therefore "route everything through OpenRouter" is not a config flip — every Anthropic-protocol call site would have to be rewritten onto the OpenAI protocol (losing Anthropic prompt caching, a real cost lever on high-volume lanes). A single "which gateway" flag cannot mean the same thing for both classes of call. This drives the two-layer split.

## Architecture: two independent layers

### Layer 1 — Transport (a fixed rule, not a flag)

Every non-managed-agent call traverses exactly **one** proxy, chosen by the model's protocol — never two in series:

- **Anthropic-protocol calls** → CF AI Gateway (status quo; preserves prompt caching).
- **OpenRouter calls** → OpenRouter directly (status quo).
- **Managed-agents session/memory surface** → direct to Anthropic (unchanged; stated exception).

This is the "no daisy-chain" guarantee. There is deliberately **no transport-selector flag**: the protocol determines the proxy, so a call is never double-hopped, and CF-gateway-fronting-OpenRouter is explicitly not adopted. This rule is documented in `docs/architecture/ai-gateway.md`.

### Layer 2 — Provider selection (the actual switch)

For the **elastic lanes** (those on the `TextModel` seam), a flag picks whether the work runs on an Anthropic model or an OpenRouter model. That choice is what shifts the credit pool.

**New global flag** — `elastic-lane-default-openrouter` (env `ELASTIC_LANE_DEFAULT_OPENROUTER`), default `false`, registered in `@releases/lib/flags` and created in both Flagship apps (`releases-platform{,-staging}`) per the flag convention.

`resolveTextModel` resolves the global flag once per call, then resolves each lane as:

> **explicit per-lane setting if present, else the global default.**

- Global flag **ON** in Flagship → every elastic lane that has an OpenRouter model configured moves to OpenRouter at runtime (no deploy). **OFF** → all fall back to Anthropic. This is the clean, reversible, one-knob credit-pool switch.
- A per-lane flag (`marketing-classifier-openrouter`, `summarize-openrouter`, …) still **overrides** the global for exceptions (e.g. keep the user-facing summarizer on Anthropic while everything else is on OpenRouter).

**Properties:**

1. **Model ids stay per-lane.** The global flag flips _intent_ only. Each lane keeps its own model var (`MARKETING_CLASSIFIER_MODEL`, `SUMMARIZE_MODEL`, …) because a classifier model and a summary model differ. A lane with the flag ON but no model configured stays on Anthropic — so turning the global default ON only moves lanes already pointed at an OpenRouter model. Safe by construction.
2. **Inheritance needs three states.** Per-lane resolution must distinguish "lane unset" (→ inherit global) from "lane explicitly false" (→ override). The current `flag()` collapses both to `false`. The implementation adds a small three-state variant that surfaces "unset" as `null` (Flagship key absent **and** env var undefined → inherit). Exact helper to be specified in the implementation plan.

**Scope boundary:** only seam lanes are switchable. Protocol-locked Anthropic calls stay on Anthropic-via-CF-gateway. The switch's coverage grows as lanes migrate onto the seam (out of scope here).

## Observability: one owned query surface

The two providers emit to different native places, so unification uses an **app-owned** sink, not a shared vendor gateway.

### Primary — app-level usage logging (the unified view)

`resolveTextModel` wraps the chosen `TextModel` in a **usage-logging decorator**. Every lane on the seam — today's two plus all future ones — then logs uniformly without touching call sites. One `ai_usage` event per call via `logEvent()` (`@releases/lib/log-event`), carrying: `provider`, `model`, `lane` (= the `generationName`), `environment`, input/output/cache tokens, and `costUsd`.

- **OpenRouter** cost comes from the provider (`usage.costUsd`).
- **Anthropic** cost is derived in the decorator via the existing `@releases/lib/anthropic-pricing` (list-price estimate from token counts), so both providers report comparable cost in one query.

**Dataset constraint (important):** we are at our Axiom dataset limit for the current tier. `logEvent()` does **not** create a dataset — it writes a structured line that CF ships into the **existing** worker-logs dataset (`releases-cloudflare-logs`). The `ai_usage` events ride in as a new _event type_ inside that dataset, queried by filtering on the event name. **No new Axiom dataset is to be provisioned.**

### Secondary — deep traces for debugging (complementary, not the cost view)

- Keep the #1472 OpenRouter Broadcast tags (already wired) and enable Broadcast → **R2** (`released-openrouter-traces`, S3-compatible, per `ai-gateway.md`) so prompt→completion pairs are inspectable when a cheap-lane output looks wrong. Dashboard-only, no code.
- CF AI Gateway's own dashboard remains the Anthropic-side deep view.

These are diagnostics, not the unified cost surface.

## Components touched

| Component                           | Change                                                                                                        |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/lib/src/flags.ts`         | Add `elasticLaneDefaultOpenrouter` FlagDef; add the three-state resolution helper.                            |
| `packages/ai/src/text-model.ts`     | Add `withUsageLogging(model, tags, deriveCost)` decorator.                                                    |
| `workers/api/src/lib/text-model.ts` | `resolveTextModel` consults the global default for inheritance and wraps the result in the logging decorator. |
| `workers/api/wrangler.jsonc`        | Register `ELASTIC_LANE_DEFAULT_OPENROUTER` var (prod + staging), default off.                                 |
| `docs/architecture/ai-gateway.md`   | Document the Layer-1 transport rule, the Layer-2 switch, and the `ai_usage` event.                            |
| Flagship dashboards                 | Create `elastic-lane-default-openrouter` in `releases-platform` and `releases-platform-staging`.              |

## Error handling / fail-open

Unchanged and preserved: a missing OpenRouter key or model var, or any OpenRouter throw, falls back to Anthropic at the call site. The logging decorator must never throw into the call path — a logging failure is swallowed (the AI call's result is what matters).

## Testing

Extend the existing `packages/ai/src/text-model.test.ts` and the resolver tests — no new harness:

- **Inheritance matrix:** lane {on, off, unset} × global {on, off} → correct provider.
- **Fail-open:** missing key / missing model → Anthropic; OpenRouter throw → caller falls back.
- **Decorator:** emitted `ai_usage` event shape; Anthropic cost derivation via `anthropic-pricing`; OpenRouter cost passthrough; decorator swallows logging errors.

## Rollout (all reversible at runtime)

1. Ship everything **OFF** → no behavior change on merge.
2. Enable OpenRouter Broadcast → R2 in the dashboard (no code).
3. Flip `elastic-lane-default-openrouter` in **staging** Flagship; confirm the unified `ai_usage` view in Axiom and the R2 traces.
4. Flip in **prod**.

Rollback at any point is a Flagship toggle — no deploy.

## Open dependencies

- OpenRouter Broadcast → R2 destination must be configured in the OpenRouter dashboard (one-time, no code) before deep traces appear. The cost view (Axiom) does not depend on this.
- The three-state flag helper's exact signature is left to the implementation plan.
