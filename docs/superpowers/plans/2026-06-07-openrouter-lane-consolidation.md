# OpenRouter Lane Consolidation — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the three OpenRouter feature flags to one (`openrouter-enabled`), route the two operational standalone scripts through the AI Gateway, and clean up stale "until the gateway's OpenRouter provider is confirmed" comments — all behavior-preserving.

**Architecture:** The cheap-call AI lanes (marketing classifier, live summarizer) resolve their provider in `resolveTextModel` (`workers/api/src/lib/text-model.ts`). Today that consults a per-lane flag, a global default flag, and the lane's model var. We delete the two per-lane flags and rename the global to `openrouter-enabled`, leaving a single switch gated by the per-lane model var (empty model var → that lane stays Anthropic). The scripts adopt the existing `buildAnthropicClient()` gateway pattern already used by `scripts/run-eval-task.ts`.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Workers, Flagship feature flags (`@releases/lib/flags`), Anthropic SDK via `buildAnthropicClient()`.

**Spec:** `docs/superpowers/specs/2026-06-07-openrouter-lane-consolidation-design.md`

**Branch:** `consolidate-openrouter-lane-flags` (already created)

---

## File Structure

- `workers/api/src/lib/text-model.test.ts` — rewritten tests for the single switch (Task 1).
- `packages/lib/src/flags.ts` — delete two FLAGS entries, rename the third (Task 2).
- `packages/lib/src/flags.test.ts` — update the renamed flag's registry assertion (Task 2).
- `workers/api/src/lib/text-model.ts` — simplify `resolveTextModel`; rename/remove env fields (Task 2).
- `workers/api/wrangler.jsonc` — reword stale comments, prod + staging blocks (Task 3).
- `workers/api/src/cron/poll-fetch.ts`, `workers/api/src/workflows/poll-and-fetch.ts`, `packages/ai/src/release-content.ts`, `tests/evals/release-summary.eval.ts` — comment rewording (Task 3).
- `docs/architecture/ai-gateway.md` — Layer 2 + Enabling-the-switch rename, batch-Anthropic-only note (Task 4).
- `scripts/generate-release-content.ts`, `scripts/smoke-toolloop.ts`, `scripts/eval-release-content-providers.ts` — gateway routing + eval comment (Task 5).
- Final verification + Flagship migration checklist (Task 6).

---

## Task 1: Rewrite the resolver tests for the single switch

The current tests assert per-lane-flag inheritance. Rewrite them so they describe the new contract: one `openrouter-enabled` switch, gated by the model var, with legacy per-lane keys having no effect. The "ignores a stray legacy per-lane flag" case is the one that fails against current code (proving the test captures the new behavior).

**Files:**

- Modify: `workers/api/src/lib/text-model.test.ts:25-78`

- [ ] **Step 1: Replace the `describe` block**

Replace the entire `describe("resolveMarketingModel inheritance", …)` block (lines 25-78) with:

```typescript
describe("resolveMarketingModel — single openrouter-enabled switch", () => {
  it("switch ON + model set → OpenRouter", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({ "openrouter-enabled": true }) });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("openrouter:")).toBe(true);
  });

  it("switch OFF → Anthropic", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({}) });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("ignores a stray legacy per-lane flag (consolidated away)", async () => {
    // `marketing-classifier-openrouter` no longer exists. With the global switch
    // off, a leftover Flagship key of that name must have no effect → Anthropic.
    const env = baseEnv({ FLAGS: flagsBinding({ "marketing-classifier-openrouter": true }) });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("switch ON but no model configured → falls back to Anthropic", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": true }),
      MARKETING_CLASSIFIER_MODEL: "",
    });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("switch ON but no OpenRouter key → falls back to Anthropic", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "openrouter-enabled": true }),
      OPENROUTER_API_KEY: undefined,
    });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("returns null when no Anthropic key is available for the fallback", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({}), ANTHROPIC_API_KEY: undefined });
    const model = await resolveMarketingModel(env);
    expect(model).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to confirm the new contract fails against current code**

Run: `cd workers/api && bun test src/lib/text-model.test.ts`
Expected: FAIL — "ignores a stray legacy per-lane flag" expects `anthropic:` but current code returns `openrouter:` (the live per-lane flag still wins). Other cases may pass.

- [ ] **Step 3: Commit the test**

```bash
git add workers/api/src/lib/text-model.test.ts
git commit -m "test(ai): resolver tests for single openrouter-enabled switch"
```

---

## Task 2: Consolidate the flags + simplify the resolver

Delete the two per-lane flags, rename the global to `openrouter-enabled`, and reduce `resolveTextModel` to a single flag read. `flags.ts` and `text-model.ts` must change together to keep `tsc` green.

**Files:**

- Modify: `packages/lib/src/flags.ts:143-176`
- Modify: `packages/lib/src/flags.test.ts:123-131`
- Modify: `workers/api/src/lib/text-model.ts` (imports, `TextModelEnv`, `resolveTextModel`, `resolveMarketingModel`, `resolveSummarizeModel`)

- [ ] **Step 1: Replace the three flag entries in `flags.ts`**

Replace lines 143-176 (the `marketingClassifierOpenrouter`, `summarizeOpenrouter`, and `elasticLaneDefaultOpenrouter` blocks, from the `// OpenRouter cheap-call lane for the per-source marketing classifier.` comment through the closing `},` of `elasticLaneDefaultOpenrouter`) with a single entry:

```typescript
  // Single switch for the secondary AI lanes (marketing classifier, live release
  // summarizer, …) on the TextModel seam. OFF → those lanes use Anthropic Haiku.
  // Flip ON in Flagship to route every such lane that ALSO has an OpenRouter model
  // var configured (e.g. MARKETING_CLASSIFIER_MODEL) onto OpenRouter at runtime; a
  // lane with an empty model var stays on Anthropic regardless (fail-open). This is
  // the ONLY OpenRouter toggle — there are no per-lane flags; per-lane control is
  // "set the model var or leave it empty". Resolved in
  // workers/api/src/lib/text-model.ts (resolveTextModel). OpenRouter is called
  // directly, never fronted by the CF AI Gateway (no double-hop) — see
  // docs/architecture/ai-gateway.md.
  openrouterEnabled: {
    key: "openrouter-enabled",
    env: "OPENROUTER_ENABLED",
    default: false,
  },
```

- [ ] **Step 2: Update the flag-registry assertion in `flags.test.ts`**

Replace lines 123-131 (the `describe("elasticLaneDefaultOpenrouter flag", …)` block) with:

```typescript
describe("openrouterEnabled flag", () => {
  it("is registered with the expected key/env and defaults off", () => {
    expect(FLAGS.openrouterEnabled).toEqual({
      key: "openrouter-enabled",
      env: "OPENROUTER_ENABLED",
      default: false,
    });
  });
});
```

- [ ] **Step 3: Update imports in `text-model.ts`**

At `workers/api/src/lib/text-model.ts:26`, drop the now-unused `flagState` and `FlagDef`:

```typescript
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
```

- [ ] **Step 4: Update `TextModelEnv` in `text-model.ts`**

Replace lines 36-43 (from `OPENROUTER_API_KEY?` through the `ELASTIC_LANE_DEFAULT_OPENROUTER?` field + its comment) with:

```typescript
  OPENROUTER_API_KEY?: SecretBinding;
  OPENROUTER_BASE_URL?: string;
  MARKETING_CLASSIFIER_MODEL?: string;
  SUMMARIZE_MODEL?: string;
  /** Single switch for the secondary AI lanes. Flagship-driven; var optional. */
  OPENROUTER_ENABLED?: string;
```

(This removes `MARKETING_CLASSIFIER_OPENROUTER` and `SUMMARIZE_OPENROUTER`, and renames `ELASTIC_LANE_DEFAULT_OPENROUTER` → `OPENROUTER_ENABLED`.)

- [ ] **Step 5: Simplify the `resolveTextModel` signature + flag read**

Replace lines 78-103 (the doc comment block + the `async function resolveTextModel(...)` opening through the `const useOpenRouter = …` line) with:

```typescript
/**
 * Shared resolver for the secondary cheap-call lanes. A single Flagship switch
 * (`openrouter-enabled`) picks the provider; `orModel` is the lane's OpenRouter
 * model id (empty → stay on Anthropic); `anthropicModel` is the Haiku fallback.
 * `generationName` tags the request for Broadcast trace grouping (inert until
 * Broadcast is configured) and is the axis that breaks usage/cost out per lane.
 */
async function resolveTextModel(
  env: TextModelEnv,
  opts: {
    orModel: string | undefined;
    anthropicModel: string;
    generationName: string;
  },
): Promise<TextModel | null> {
  const useOpenRouter = await flag(env.FLAGS, env.OPENROUTER_ENABLED, FLAGS.openrouterEnabled);
```

Leave the body from `if (useOpenRouter) {` (current line 105) downward unchanged.

- [ ] **Step 6: Update the two lane resolvers**

Replace lines 140-158 (both `resolveMarketingModel` and `resolveSummarizeModel`) with:

```typescript
export function resolveMarketingModel(env: TextModelEnv): Promise<TextModel | null> {
  return resolveTextModel(env, {
    orModel: env.MARKETING_CLASSIFIER_MODEL,
    anthropicModel: ANTHROPIC_MARKETING_MODEL,
    generationName: "marketing-classifier",
  });
}

export function resolveSummarizeModel(env: TextModelEnv): Promise<TextModel | null> {
  return resolveTextModel(env, {
    orModel: env.SUMMARIZE_MODEL,
    anthropicModel: ANTHROPIC_SUMMARIZE_MODEL,
    generationName: "summarize-release",
  });
}
```

- [ ] **Step 7: Run the resolver tests**

Run: `cd workers/api && bun test src/lib/text-model.test.ts`
Expected: PASS (all cases, including "ignores a stray legacy per-lane flag").

- [ ] **Step 8: Run the flags tests**

Run: `bun test packages/lib/src/flags.test.ts`
Expected: PASS.

- [ ] **Step 9: Type-check both packages**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit)`
Expected: no errors. (Confirms no other reader referenced the removed flags/fields.)

- [ ] **Step 10: Commit**

```bash
git add packages/lib/src/flags.ts packages/lib/src/flags.test.ts workers/api/src/lib/text-model.ts
git commit -m "refactor(ai): collapse OpenRouter lane flags to one openrouter-enabled switch"
```

---

## Task 3: Reword stale comments in worker/package source

Comment-only changes. Each says the OpenRouter behavior is gated by a per-lane flag and/or is "until the gateway's OpenRouter provider is confirmed" — both now stale.

**Files:**

- Modify: `workers/api/wrangler.jsonc` (prod ~107-118, secret ~464-466, staging ~570-575)
- Modify: `workers/api/src/cron/poll-fetch.ts:1028-1029`
- Modify: `workers/api/src/workflows/poll-and-fetch.ts:271-272`
- Modify: `packages/ai/src/release-content.ts:9-12` and `:523-527`
- Modify: `tests/evals/release-summary.eval.ts:78-80`

- [ ] **Step 1: `wrangler.jsonc` prod block (lines 107-118)**

Replace the two comment blocks above `MARKETING_CLASSIFIER_MODEL` and `SUMMARIZE_MODEL` with:

```jsonc
    // OpenRouter cheap-call model for the marketing classifier. Consulted only
    // when the `openrouter-enabled` flag is on; otherwise the classifier stays on
    // Anthropic Haiku. OpenRouter is called directly (not fronted by the CF AI
    // Gateway — no double-hop, per docs/architecture/ai-gateway.md Layer 1).
    "MARKETING_CLASSIFIER_MODEL": "google/gemini-2.5-flash-lite",
    // OpenRouter cheap-call model for the *live* poll-fetch summarizer. Consulted
    // only when `openrouter-enabled` is on; empty → the summarizer stays on
    // Anthropic Haiku (fail-open). Intentionally UNSET until the release-content
    // eval (`bun run eval:summary`) picks a candidate that shows no quality
    // regression vs. Haiku — summaries are user-facing. The daily batch path is
    // unaffected (always Anthropic).
    "SUMMARIZE_MODEL": "",
```

- [ ] **Step 2: `wrangler.jsonc` OpenRouter secret comment (lines 464-466)**

Replace:

```jsonc
// OpenRouter cheap-call lane (marketing classifier). Inert until the
// `marketing-classifier-openrouter` flag is on AND MARKETING_CLASSIFIER_MODEL
// is set — flag-off (default) keeps the classifier on Anthropic Haiku.
```

with:

```jsonc
// OpenRouter cheap-call lanes. Inert until `openrouter-enabled` is on AND a
// lane model var (e.g. MARKETING_CLASSIFIER_MODEL) is set — switch-off
// (default) keeps every lane on Anthropic Haiku.
```

- [ ] **Step 3: `wrangler.jsonc` staging block (lines 570-575)**

Replace:

```jsonc
        // OpenRouter cheap-call model (marketing classifier); gated by the
        // `marketing-classifier-openrouter` flag. Mirrors prod.
        "MARKETING_CLASSIFIER_MODEL": "google/gemini-2.5-flash-lite",
        // OpenRouter cheap-call model for the live summarizer; gated by the
        // `summarize-openrouter` flag. UNSET until the eval picks a candidate;
        // empty → stays on Anthropic Haiku (fail-open). Mirrors prod.
        "SUMMARIZE_MODEL": "",
```

with:

```jsonc
        // OpenRouter cheap-call model (marketing classifier); gated by the
        // `openrouter-enabled` flag. Mirrors prod.
        "MARKETING_CLASSIFIER_MODEL": "google/gemini-2.5-flash-lite",
        // OpenRouter cheap-call model for the live summarizer; gated by the
        // `openrouter-enabled` flag. UNSET until the eval picks a candidate;
        // empty → stays on Anthropic Haiku (fail-open). Mirrors prod.
        "SUMMARIZE_MODEL": "",
```

- [ ] **Step 4: `poll-fetch.ts` (lines 1028-1029)**

Replace:

```typescript
// Provider/model decided here (Anthropic Haiku via gateway, or a cheap
// OpenRouter model when `marketing-classifier-openrouter` is on + configured).
```

with:

```typescript
// Provider/model decided here (Anthropic Haiku via gateway, or a cheap
// OpenRouter model when `openrouter-enabled` is on + a model is configured).
```

- [ ] **Step 5: `poll-and-fetch.ts` (lines 271-272)**

Replace:

```typescript
// Provider/model decided here: Anthropic Haiku via gateway by default, or a
// cheap OpenRouter model when `summarize-openrouter` is on + configured.
```

with:

```typescript
// Provider/model decided here: Anthropic Haiku via gateway by default, or a
// cheap OpenRouter model when `openrouter-enabled` is on + a model is configured.
```

- [ ] **Step 6: `release-content.ts` (lines 9-12)**

Replace:

```typescript
 * Worker-safe: no `fs`, no `node:*` imports, no logger. Caller constructs the
 * `TextModel` (so the worker can route through AI Gateway / a cheap OpenRouter
 * model behind the `summarize-openrouter` flag, and the script path can hit the
 * Anthropic API directly).
```

with:

```typescript
 * Worker-safe: no `fs`, no `node:*` imports, no logger. Caller constructs the
 * `TextModel` (so the worker can route through AI Gateway / a cheap OpenRouter
 * model when `openrouter-enabled` is on, and the script path can hit the
 * Anthropic API directly).
```

- [ ] **Step 7: `release-content.ts` (lines 523-527)**

Replace:

```typescript
 * Run a release body through the supplied `TextModel` to produce title / short
 * title / summary. The caller constructs the model (Anthropic Haiku via AI
 * Gateway, or a cheap OpenRouter model behind the `summarize-openrouter` flag),
 * so this helper stays provider-neutral. Returns all-null + `skipped: true`
```

with:

```typescript
 * Run a release body through the supplied `TextModel` to produce title / short
 * title / summary. The caller constructs the model (Anthropic Haiku via AI
 * Gateway, or a cheap OpenRouter model when `openrouter-enabled` is on), so this
 * helper stays provider-neutral. Returns all-null + `skipped: true`
```

- [ ] **Step 8: `release-summary.eval.ts` (lines 78-80)**

Replace:

```typescript
// The model under test. Defaults to Anthropic Haiku (the production baseline).
// To eval an OpenRouter candidate for the `summarize-openrouter` lane, set
// EVAL_OPENROUTER_MODEL (e.g. "google/gemini-3.1-flash-lite") + OPENROUTER_API_KEY.
```

with:

```typescript
// The model under test. Defaults to Anthropic Haiku (the production baseline).
// To eval an OpenRouter candidate for the summarizer lane, set
// EVAL_OPENROUTER_MODEL (e.g. "google/gemini-3.1-flash-lite") + OPENROUTER_API_KEY.
```

- [ ] **Step 9: Verify nothing references the old flag names**

Run: `grep -rn "marketing-classifier-openrouter\|summarize-openrouter\|elastic-lane-default-openrouter\|MARKETING_CLASSIFIER_OPENROUTER\|SUMMARIZE_OPENROUTER\|ELASTIC_LANE_DEFAULT_OPENROUTER\|elasticLaneDefaultOpenrouter\|marketingClassifierOpenrouter\|summarizeOpenrouter" --include="*.ts" --include="*.jsonc" . | grep -v node_modules | grep -v docs/superpowers`
Expected: no output (the `docs/superpowers` historical plan/spec from #1476 is intentionally excluded — it's a record, not living config).

- [ ] **Step 10: Commit**

```bash
git add workers/api/wrangler.jsonc workers/api/src/cron/poll-fetch.ts workers/api/src/workflows/poll-and-fetch.ts packages/ai/src/release-content.ts tests/evals/release-summary.eval.ts
git commit -m "docs(ai): reword stale per-lane-flag + 'until confirmed' comments"
```

---

## Task 4: Update `ai-gateway.md` (Layer 2 rename, batch-Anthropic note)

Layer 1 (lines 67-73) already documents OpenRouter-direct / no-double-hop correctly — leave it. Update Layer 2 to describe the single switch, rename the key in the Enabling section, and add the batch-Anthropic-only invariant for #1468.2.

**Files:**

- Modify: `docs/architecture/ai-gateway.md:75`, `:77`, `:79`

- [ ] **Step 1: Replace the Layer 2 paragraph (line 75)**

Replace the paragraph beginning `**Layer 2 — Provider selection (the switch).**` with:

```markdown
**Layer 2 — Provider selection (the switch).** A single Flagship flag, `openrouter-enabled`, governs every secondary lane on the `TextModel` seam (marketing classifier, live summarizer, …). ON moves each lane that ALSO has an OpenRouter model var configured (e.g. `MARKETING_CLASSIFIER_MODEL`) onto OpenRouter at runtime; OFF returns them all to Anthropic. A lane with an empty model var stays on Anthropic regardless (fail-open), so per-lane control is just "set the model var or leave it empty" — there are no per-lane flags. Implemented in `workers/api/src/lib/text-model.ts` (`resolveTextModel`).
```

- [ ] **Step 2: Append the batch invariant to the Unified-usage paragraph (line 77)**

At the end of the paragraph beginning `**Unified usage view.**` (after the Axiom query example), append:

```markdown
The daily batch summarize/overview workflows are **not** on this seam — they call the Anthropic Message Batches API directly and price via `estimateCost()`. That is correct because there is no OpenRouter Batches equivalent, so batch spend is always Anthropic; a future OpenRouter batch path is the one place this assumption would need revisiting.
```

- [ ] **Step 3: Rename the key in the Enabling paragraph (line 79)**

In the paragraph beginning `**Enabling the switch (Flagship, no deploy).**`, replace `Create the \`elastic-lane-default-openrouter\` key`with`Create the \`openrouter-enabled\` key`.

- [ ] **Step 4: Verify no stale flag name remains in the doc**

Run: `grep -n "elastic-lane-default-openrouter\|marketing-classifier-openrouter\|summarize-openrouter" docs/architecture/ai-gateway.md`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/ai-gateway.md
git commit -m "docs(ai-gateway): single openrouter-enabled switch + batch-Anthropic invariant"
```

---

## Task 5: Route standalone scripts through the AI Gateway (#1474a)

Adopt the `buildAnthropicClient()` gateway pattern (already used by `scripts/run-eval-task.ts:90-94`) in the two operational scripts; default to direct when env unset. Leave the provider-comparison eval direct, with a reason.

**Files:**

- Modify: `scripts/generate-release-content.ts:35`, `:427-430`
- Modify: `scripts/smoke-toolloop.ts:12`, `:47-48`
- Modify: `scripts/eval-release-content-providers.ts:297-299`

- [ ] **Step 1: `generate-release-content.ts` — swap the import (line 35)**

Replace:

```typescript
import Anthropic from "@anthropic-ai/sdk";
```

with:

```typescript
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
```

- [ ] **Step 2: `generate-release-content.ts` — build the client via the gateway (lines 427-430)**

Replace:

```typescript
const client = new Anthropic({ apiKey });
// The real-time path runs `summarizeRelease` through the TextModel seam; this
// script always uses Anthropic directly (the batch path stays on the Batches API).
const realtimeModel = anthropicTextModel(client, MODEL);
```

with:

```typescript
// Route through the CF AI Gateway when ANTHROPIC_BASE_URL is set (so this tool's
// spend is attributed alongside the worker paths); falls back to direct Anthropic
// when unset, so local runs are unchanged. Same pattern as scripts/run-eval-task.ts.
const client = buildAnthropicClient({
  apiKey,
  baseURL: process.env.ANTHROPIC_BASE_URL,
  gatewayToken: process.env.AI_GATEWAY_TOKEN,
});
// The real-time path runs `summarizeRelease` through the TextModel seam; the batch
// path stays on the Anthropic Batches API (no OpenRouter batch equivalent).
const realtimeModel = anthropicTextModel(client, MODEL);
```

- [ ] **Step 3: `smoke-toolloop.ts` — swap the import (line 12)**

Replace:

```typescript
import Anthropic from "@anthropic-ai/sdk";
```

with:

```typescript
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
```

- [ ] **Step 4: `smoke-toolloop.ts` — build the client via the gateway (line 48)**

Replace:

```typescript
  anthropicClient: new Anthropic({ apiKey }),
```

with:

```typescript
  // Route through the CF AI Gateway when ANTHROPIC_BASE_URL is set; direct when unset.
  anthropicClient: buildAnthropicClient({
    apiKey,
    baseURL: process.env.ANTHROPIC_BASE_URL,
    gatewayToken: process.env.AI_GATEWAY_TOKEN,
  }),
```

- [ ] **Step 5: `eval-release-content-providers.ts` — document why it stays direct (line 297-299)**

Replace:

```typescript
async function callAnthropic(cfg: ProviderConfig, userBlock: string): Promise<ProviderResult> {
  const start = Date.now();
  const client = new Anthropic({ apiKey: cfg.apiKey! });
```

with:

```typescript
async function callAnthropic(cfg: ProviderConfig, userBlock: string): Promise<ProviderResult> {
  const start = Date.now();
  // Intentionally direct (no AI Gateway): this eval measures raw per-provider
  // latency, so a proxy hop would skew the Anthropic baseline against the
  // OpenAI-compat providers it is being compared with. See #1474.
  const client = new Anthropic({ apiKey: cfg.apiKey! });
```

- [ ] **Step 6: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors (confirms the dropped `Anthropic` default import isn't referenced elsewhere in the two routed scripts, and `buildAnthropicClient`'s return type satisfies `anthropicTextModel` / `ExtractDeps.anthropicClient`).

- [ ] **Step 7: Smoke the unset-env path (no behavior change locally)**

Run: `ANTHROPIC_BASE_URL= bun scripts/smoke-toolloop.ts https://bun.sh/blog 2>&1 | tail -5`
Expected: prints the result JSON (direct path works; gateway env empty → falls back to direct). Requires `ANTHROPIC_API_KEY` in env. If no key locally, skip and note it.

- [ ] **Step 8: Commit**

```bash
git add scripts/generate-release-content.ts scripts/smoke-toolloop.ts scripts/eval-release-content-providers.ts
git commit -m "feat(scripts): route operational scripts through AI Gateway when configured (#1474)"
```

---

## Task 6: Full verification + Flagship migration checklist

- [ ] **Step 1: Full type-check (root + api worker)**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `bun test`
Expected: PASS (note: `packages/` mock-module leakage means a clean run may require `bun test` in subdirs; if root run shows unrelated cross-package failures, re-run `bun test packages/lib` and `cd workers/api && bun test` separately to confirm the touched suites are green).

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: PASS. (If `format:check` flags the edited files, run `bun run format` and re-commit.)

- [ ] **Step 4: Record the Flagship migration steps (manual, ops — do NOT skip before deploy)**

These are dashboard actions, sequenced so the renamed key exists before the code reads it. Capture them in the PR description so they are not lost:

1. **Pre-flight:** in BOTH Flagship apps (`releases-platform`, `releases-platform-staging`), check the current value of `marketing-classifier-openrouter` and `summarize-openrouter`. If either is explicitly set to `false` while `elastic-lane-default-openrouter` is `true`, that lane is currently pinned to Anthropic — decide intentionally before consolidating (removal would let it follow the global). Expected today: per-lane keys unset; marketing follows the global.
2. **Create** `openrouter-enabled` in BOTH apps, set to match the current `elastic-lane-default-openrouter` value (so behavior is preserved at deploy).
3. **Merge → deploy** (workers auto-deploy on merge to main). The deployed code now reads `openrouter-enabled`.
4. **Verify** post-deploy: marketing classifier still resolves to the expected provider (check an `ai_usage` event in Axiom: `["releases-cloudflare-logs"] | where ["event"] == "ai_usage" | where ["lane"] == "marketing-classifier"` — `provider` should be unchanged from before the deploy).
5. **Delete** the three orphaned keys from BOTH apps: `elastic-lane-default-openrouter`, `marketing-classifier-openrouter`, `summarize-openrouter`.

- [ ] **Step 5: Push the branch and open the PR**

```bash
git push -u origin consolidate-openrouter-lane-flags
```

PR body must: link #1468 and #1474; state which acceptance items are satisfied (1474a scripts; 1468.2 cost accounting confirmed already-correct + documented; 1468.1/1474b resolved as decided-against-by-#1476); and include the Flagship migration checklist from Step 4. Use `--body-file` (escaped backticks in a HEREDOC leak into rendered markdown).

---

## Self-Review Notes

- **Spec coverage:** Part 1 → Tasks 1-2; Part 2 (scripts) → Task 5; Part 3 (close-out + stale comments) → Tasks 3 (wrangler/flags comments) + 4 (ai-gateway.md Layer 1 already correct); Part 4 (cost audit) → Task 4 Step 2 (batch-Anthropic invariant) + the already-present line-77 per-provider note. Flagship migration ordering → Task 6 Step 4.
- **No new flags/vars:** net −2 flags, 1 rename; zero added.
- **Behavior-preserving:** marketing model var set + switch on → OpenRouter (unchanged); summarize model var empty → Anthropic (unchanged). Verified by Task 1 cases + Task 6 Step 4 post-deploy check.
