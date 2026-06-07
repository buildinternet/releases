# AI Gateway Routing + Elastic-Lane Provider Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a single runtime switch that moves the elastic cheap-call AI lanes between Anthropic and OpenRouter, plus a unified per-call usage log, without changing the fixed transport rule.

**Architecture:** Two layers. **Transport** is a fixed rule (protocol picks the proxy — Anthropic→CF AI Gateway, OpenRouter→direct), not a flag. **Provider selection** for the seam lanes gains a global `elastic-lane-default-openrouter` flag that per-lane flags inherit (three-state: explicit lane setting wins, else global). A logging decorator wraps every resolved `TextModel` and emits one `ai_usage` event (tokens + cost) into the existing Axiom worker-log dataset.

**Tech Stack:** TypeScript (strict), Bun test, Cloudflare Workers, Cloudflare Flagship (feature flags), `@releases/lib` (flags, secrets, log-event, anthropic-pricing), `@releases/ai-internal` (TextModel seam).

---

## Background the implementer needs

- The `TextModel` seam (`packages/ai/src/text-model.ts`) is `{system, user, maxTokens} → {text, usage}`. Two adapters exist: `anthropicTextModel(client, model)` (id `anthropic:<model>`) and `openRouterTextModel(opts)` (id `openrouter:<model>`). `TextModelUsage` = `{ input, output, cacheCreate, cacheRead, costUsd? }` — `costUsd` is set by OpenRouter only.
- `workers/api/src/lib/text-model.ts` has `resolveTextModel(env, opts)` (private) and two public lane resolvers: `resolveMarketingModel(env)` and `resolveSummarizeModel(env)`. Each returns `TextModel | null` (null = no usable provider → caller skips). Today it picks OpenRouter when the lane flag is on AND a key+model are configured, else Anthropic Haiku (fail-open).
- Flags: `@releases/lib/flags` exposes `FLAGS` (registry), `flag(binding, varValue, def)` (Flagship → var → default, never throws), `FlagDef`, `FlagshipBinding` (`getBooleanValue(key, default)`). Flagship returns the passed default when a key is absent — there is no separate "missing" signal.
- The two existing lane flags are `marketingClassifierOpenrouter` (`marketing-classifier-openrouter`) and `summarizeOpenrouter` (`summarize-openrouter`), both `default: false`. Neither toggle has a wrangler var set — they are Flagship-driven, with the FlagDef default as the floor.
- Cost: `@releases/lib/anthropic-pricing` exports `estimateCost(usage: TokenUsage, model, options?) → CostEstimate | null`, where `TokenUsage = { inputTokens?, cacheWriteTokens?, cacheReadTokens?, outputTokens? }` and `CostEstimate.totalUsd` is the number we want. Returns `null` for unknown models.
- Logging: `@releases/lib/log-event` exports `logEvent(level, payload)` where `payload` MUST have `{ component, event, ... }`. It writes a JSON `console.*` line that CF ships into the existing `releases-cloudflare-logs` Axiom dataset. **Do not create a new Axiom dataset.**
- Secrets: `getSecret(binding)` (`@releases/lib/secrets`) resolves a `{ get(): Promise<string|null> }` binding; returns `null` for an undefined binding.

**Deviation from the spec (intentional, flag for reviewer):** the spec's components table mentions registering an `ELASTIC_LANE_DEFAULT_OPENROUTER` wrangler var. We instead follow the **sibling-flag convention** (Flagship-only, no wrangler var): the `FlagDef.default: false` is the floor and Flagship drives runtime. The only code-level env touch is an **optional** `ELASTIC_LANE_DEFAULT_OPENROUTER?: string` field on `TextModelEnv` so a var override remains possible without a deploy-time requirement.

---

## File structure

| File                                     | Responsibility                                                                                  | Action |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------- | ------ |
| `packages/lib/src/flags.ts`              | Flag registry + evaluation. Add `FlagState`, `flagState()`, `elasticLaneDefaultOpenrouter` def. | Modify |
| `packages/lib/src/flags.test.ts`         | Flag tests. Add `flagState()` matrix.                                                           | Modify |
| `packages/ai/src/text-model.ts`          | Seam + adapters. Add `withUsageLogging` decorator + `UsageRecord`/`UsageSink` types.            | Modify |
| `packages/ai/src/text-model.test.ts`     | Seam tests. Add decorator tests.                                                                | Modify |
| `workers/api/src/lib/text-model.ts`      | Lane resolver. Add global-default inheritance + wrap with usage logging.                        | Modify |
| `workers/api/src/lib/text-model.test.ts` | Resolver inheritance + wrapping tests.                                                          | Create |
| `docs/architecture/ai-gateway.md`        | Document the transport rule, the switch, the `ai_usage` event.                                  | Modify |

---

## Task 1: Three-state `flagState()` helper + global flag definition

**Files:**

- Modify: `packages/lib/src/flags.ts`
- Modify: `packages/lib/src/flags.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/lib/src/flags.test.ts` (after the existing `describe("flag()", ...)` block). Note the imports at the top of the file must gain `flagState` and `type FlagState`:

```ts
// At top of file, extend the existing import:
// import { FLAGS, flag, flagState, type FlagshipBinding } from "./flags.js";

/** Stub binding that echoes the passed default — simulates an ABSENT Flagship key. */
const echoingBinding: FlagshipBinding = {
  getBooleanValue: async (_key, defaultValue) => defaultValue,
};

describe("flagState()", () => {
  it("reads on/off from the var when the binding is absent", async () => {
    expect(await flagState(undefined, "true", FLAGS.pollFetchUseWorkflow)).toBe("on");
    expect(await flagState(undefined, "false", FLAGS.pollFetchUseWorkflow)).toBe("off");
  });

  it("returns unset when neither binding nor var supplies a value", async () => {
    expect(await flagState(undefined, undefined, FLAGS.pollFetchUseWorkflow)).toBe("unset");
  });

  it("reads an explicit Flagship value (present key wins over the probe defaults)", async () => {
    expect(await flagState(bindingReturning(true), undefined, FLAGS.pollFetchUseWorkflow)).toBe(
      "on",
    );
    expect(await flagState(bindingReturning(false), undefined, FLAGS.pollFetchUseWorkflow)).toBe(
      "off",
    );
  });

  it("returns unset when the Flagship key is absent (probe defaults differ)", async () => {
    expect(await flagState(echoingBinding, undefined, FLAGS.pollFetchUseWorkflow)).toBe("unset");
  });

  it("falls back to the var when the Flagship key is absent", async () => {
    expect(await flagState(echoingBinding, "true", FLAGS.pollFetchUseWorkflow)).toBe("on");
    expect(await flagState(echoingBinding, "false", FLAGS.pollFetchUseWorkflow)).toBe("off");
  });

  it("lets Flagship win over the var when the key is present", async () => {
    expect(await flagState(bindingReturning(true), "false", FLAGS.pollFetchUseWorkflow)).toBe("on");
  });

  it("collapses an eval error to the var, else unset", async () => {
    expect(await flagState(throwingBinding, "true", FLAGS.pollFetchUseWorkflow)).toBe("on");
    expect(await flagState(throwingBinding, undefined, FLAGS.pollFetchUseWorkflow)).toBe("unset");
  });
});

describe("elasticLaneDefaultOpenrouter flag", () => {
  it("is registered with the expected key/env and defaults off", () => {
    expect(FLAGS.elasticLaneDefaultOpenrouter).toEqual({
      key: "elastic-lane-default-openrouter",
      env: "ELASTIC_LANE_DEFAULT_OPENROUTER",
      default: false,
    });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/lib/src/flags.test.ts`
Expected: FAIL — `flagState` is not exported / `FLAGS.elasticLaneDefaultOpenrouter` is undefined.

- [ ] **Step 3: Add the global flag definition**

In `packages/lib/src/flags.ts`, inside the `FLAGS` object, immediately after the `summarizeOpenrouter` entry (keep it adjacent to the sibling OpenRouter flags):

```ts
  // Global default for the elastic cheap-call lanes (marketing classifier, live
  // summarizer, …). OFF → a lane that doesn't set its own flag stays on Anthropic.
  // Flip ON in Flagship to move EVERY elastic lane that has an OpenRouter model
  // configured onto OpenRouter at runtime; a per-lane flag still overrides this.
  // Inheritance lives in workers/api/src/lib/text-model.ts (resolveTextModel).
  elasticLaneDefaultOpenrouter: {
    key: "elastic-lane-default-openrouter",
    env: "ELASTIC_LANE_DEFAULT_OPENROUTER",
    default: false,
  },
```

- [ ] **Step 4: Add the `FlagState` type and `flagState()` function**

In `packages/lib/src/flags.ts`, immediately after the `flag()` function (end of file):

```ts
export type FlagState = "on" | "off" | "unset";

/**
 * Three-state flag evaluation for inheritance. Distinguishes an explicit on/off
 * from "unset" (neither Flagship nor the var supplies a value), so a caller can
 * fall back to a different base (e.g. a global default flag) instead of the
 * FlagDef's hardcoded `default`. Precedence matches `flag()`: Flagship → var →
 * unset. Never throws.
 *
 * Flagship's getBooleanValue returns the passed default when a key is absent and
 * gives no separate "missing" signal, so we probe it twice with opposite
 * defaults: equal results ⇒ the key is present (explicit value); differing
 * results ⇒ the key is absent (the calls only echoed our two defaults).
 */
export async function flagState(
  binding: FlagshipBinding | undefined,
  varValue: string | undefined,
  def: FlagDef,
): Promise<FlagState> {
  if (binding) {
    try {
      const [asFalse, asTrue] = await Promise.all([
        binding.getBooleanValue(def.key, false),
        binding.getBooleanValue(def.key, true),
      ]);
      if (asFalse === asTrue) return asFalse ? "on" : "off";
    } catch {
      // fall through to the var / unset path
    }
  }
  if (varValue !== undefined) return varValue === "true" ? "on" : "off";
  return "unset";
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/lib/src/flags.test.ts`
Expected: PASS (all flagState + registry tests green; existing flag() tests still green).

- [ ] **Step 6: Commit**

```bash
git add packages/lib/src/flags.ts packages/lib/src/flags.test.ts
git commit -m "$(cat <<'EOF'
feat(flags): three-state flagState() + elastic-lane-default-openrouter

flagState distinguishes explicit on/off from unset (Flagship key absent AND no
var) by probing Flagship twice with opposite defaults, so callers can inherit a
different base. Adds the global elastic-lane default flag (off).

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `withUsageLogging` decorator on the TextModel seam

**Files:**

- Modify: `packages/ai/src/text-model.ts`
- Modify: `packages/ai/src/text-model.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `packages/ai/src/text-model.test.ts` (extend the top import to include `withUsageLogging, type UsageRecord`):

```ts
function fakeModel(id: string, usage: import("./text-model").TextModelUsage) {
  return { id, complete: async () => ({ text: "OUT", usage }) };
}
const ZERO = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 };

describe("withUsageLogging", () => {
  it("preserves id and returns the inner result unchanged", async () => {
    const inner = fakeModel("anthropic:claude-haiku-4-5", { ...ZERO, input: 5, output: 2 });
    const wrapped = withUsageLogging(inner, { lane: "x", sink: () => {} });
    expect(wrapped.id).toBe("anthropic:claude-haiku-4-5");
    const res = await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(res).toEqual({ text: "OUT", usage: { ...ZERO, input: 5, output: 2 } });
  });

  it("emits a record with provider/model split from the id, lane, env, and tokens", async () => {
    let rec: UsageRecord | undefined;
    const inner = fakeModel("openrouter:google/gemini-2.5-flash-lite", {
      input: 10,
      output: 3,
      cacheCreate: 1,
      cacheRead: 4,
      costUsd: 0.0002,
    });
    const wrapped = withUsageLogging(inner, {
      lane: "marketing-classifier",
      environment: "production",
      sink: (r) => {
        rec = r;
      },
    });
    await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(rec).toEqual({
      provider: "openrouter",
      model: "google/gemini-2.5-flash-lite",
      lane: "marketing-classifier",
      environment: "production",
      input: 10,
      output: 3,
      cacheCreate: 1,
      cacheRead: 4,
      costUsd: 0.0002,
    });
  });

  it("derives cost via deriveCost when the provider reports none", async () => {
    let rec: UsageRecord | undefined;
    const inner = fakeModel("anthropic:claude-haiku-4-5", { ...ZERO, input: 100, output: 20 });
    const wrapped = withUsageLogging(inner, {
      lane: "summarize-release",
      sink: (r) => {
        rec = r;
      },
      deriveCost: (provider, model) => (provider === "anthropic" ? 0.005 : undefined),
    });
    await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(rec?.costUsd).toBe(0.005);
  });

  it("does not break the call when the sink throws", async () => {
    const inner = fakeModel("anthropic:m", { ...ZERO });
    const wrapped = withUsageLogging(inner, {
      lane: "x",
      sink: () => {
        throw new Error("axiom down");
      },
    });
    const res = await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(res.text).toBe("OUT");
  });

  it("does not break the call when deriveCost throws", async () => {
    const inner = fakeModel("anthropic:m", { ...ZERO });
    const wrapped = withUsageLogging(inner, {
      lane: "x",
      sink: () => {},
      deriveCost: () => {
        throw new Error("pricing boom");
      },
    });
    const res = await wrapped.complete({ system: "s", user: "u", maxTokens: 1 });
    expect(res.text).toBe("OUT");
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test packages/ai/src/text-model.test.ts`
Expected: FAIL — `withUsageLogging` / `UsageRecord` are not exported.

- [ ] **Step 3: Implement the decorator**

In `packages/ai/src/text-model.ts`, append at the end of the file:

```ts
/** One usage record emitted per seam call. Provider-agnostic; the sink decides where it goes. */
export interface UsageRecord {
  provider: string;
  model: string;
  lane: string;
  environment?: string;
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  /** USD cost: provider-reported for OpenRouter, derived for Anthropic, undefined if unknown. */
  costUsd?: number;
}

export type UsageSink = (record: UsageRecord) => void;

/** Split a `<provider>:<model>` TextModel id on the first ":". */
function splitModelId(id: string): { provider: string; model: string } {
  const i = id.indexOf(":");
  return i === -1
    ? { provider: "unknown", model: id }
    : { provider: id.slice(0, i), model: id.slice(i + 1) };
}

/**
 * Wrap a TextModel so every `complete()` emits one usage record. Cost comes from
 * the provider (`usage.costUsd`) when present, else from `deriveCost` (used for
 * Anthropic, which reports no cost). Best-effort: a throwing sink or deriveCost
 * never breaks the underlying AI call. Dependencies are injected so this package
 * stays free of `@releases/lib`.
 */
export function withUsageLogging(
  inner: TextModel,
  opts: {
    lane: string;
    environment?: string;
    sink: UsageSink;
    deriveCost?: (provider: string, model: string, usage: TextModelUsage) => number | undefined;
  },
): TextModel {
  const { provider, model } = splitModelId(inner.id);
  return {
    id: inner.id,
    async complete(req) {
      const result = await inner.complete(req);
      try {
        const costUsd = result.usage.costUsd ?? opts.deriveCost?.(provider, model, result.usage);
        opts.sink({
          provider,
          model,
          lane: opts.lane,
          environment: opts.environment,
          input: result.usage.input,
          output: result.usage.output,
          cacheCreate: result.usage.cacheCreate,
          cacheRead: result.usage.cacheRead,
          costUsd,
        });
      } catch {
        // best-effort observability — never break the AI call path
      }
      return result;
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/ai/src/text-model.test.ts`
Expected: PASS (decorator tests green; existing adapter tests still green).

- [ ] **Step 5: Commit**

```bash
git add packages/ai/src/text-model.ts packages/ai/src/text-model.test.ts
git commit -m "$(cat <<'EOF'
feat(ai): withUsageLogging decorator for the TextModel seam

Wraps any TextModel so each complete() emits one usage record (provider/model
from the id, lane, tokens, cost). Cost is provider-reported (OpenRouter) or
injected deriveCost (Anthropic). Best-effort: sink/deriveCost throws never break
the call. Deps injected to keep @releases/ai-internal free of @releases/lib.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire inheritance + usage logging into the worker resolver

**Files:**

- Modify: `workers/api/src/lib/text-model.ts`
- Create: `workers/api/src/lib/text-model.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `workers/api/src/lib/text-model.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { resolveMarketingModel, type TextModelEnv } from "./text-model.js";
import type { FlagshipBinding } from "@releases/lib/flags";

/** Flagship stub: `true`/`false` = present key with that value; absent key echoes the default. */
function flagsBinding(values: Record<string, boolean>): FlagshipBinding {
  return {
    getBooleanValue: async (key, defaultValue) => (key in values ? values[key]! : defaultValue),
  };
}

const secret = (v: string | null) => ({ get: async () => v });

/** Base env with a usable Anthropic key + an OpenRouter key & model configured. */
function baseEnv(overrides: Partial<TextModelEnv> = {}): TextModelEnv {
  return {
    ANTHROPIC_API_KEY: secret("anthropic-key"),
    OPENROUTER_API_KEY: secret("or-key"),
    MARKETING_CLASSIFIER_MODEL: "google/gemini-2.5-flash-lite",
    ENVIRONMENT: "test",
    ...overrides,
  } as TextModelEnv;
}

describe("resolveMarketingModel inheritance", () => {
  it("lane unset + global ON → OpenRouter", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({ "elastic-lane-default-openrouter": true }) });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("openrouter:")).toBe(true);
  });

  it("lane unset + global OFF → Anthropic", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({}) });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("lane explicitly ON overrides global OFF → OpenRouter", async () => {
    const env = baseEnv({ FLAGS: flagsBinding({ "marketing-classifier-openrouter": true }) });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("openrouter:")).toBe(true);
  });

  it("lane explicitly OFF overrides global ON → Anthropic", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({
        "marketing-classifier-openrouter": false,
        "elastic-lane-default-openrouter": true,
      }),
    });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("OpenRouter selected but no model configured → falls back to Anthropic", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "elastic-lane-default-openrouter": true }),
      MARKETING_CLASSIFIER_MODEL: "",
    });
    const model = await resolveMarketingModel(env);
    expect(model?.id.startsWith("anthropic:")).toBe(true);
  });

  it("OpenRouter selected but no OpenRouter key → falls back to Anthropic", async () => {
    const env = baseEnv({
      FLAGS: flagsBinding({ "elastic-lane-default-openrouter": true }),
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

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test workers/api/src/lib/text-model.test.ts`
Expected: FAIL — current `resolveTextModel` uses two-state `flag()` (no global inheritance), so "lane unset + global ON → OpenRouter" fails (it would pick Anthropic).

- [ ] **Step 3: Update imports and `TextModelEnv`**

In `workers/api/src/lib/text-model.ts`, update the imports:

```ts
import {
  anthropicTextModel,
  openRouterTextModel,
  withUsageLogging,
  type TextModel,
  type TextModelUsage,
} from "@releases/ai-internal/text-model";
import { MODEL as ANTHROPIC_MARKETING_MODEL } from "@releases/ai-internal/marketing-classifier";
import { MODEL as ANTHROPIC_SUMMARIZE_MODEL } from "@releases/ai-internal/release-content";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { flag, flagState, FLAGS, type FlagDef, type FlagshipBinding } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { estimateCost } from "@releases/lib/anthropic-pricing";
import { getSecret, type SecretBinding } from "@releases/lib/secrets";
import { getAnthropicKey, resolveGatewayOpts, type AnthropicEnv } from "./anthropic.js";
```

In the `TextModelEnv` interface, add the optional global-default var field (next to the existing `SUMMARIZE_MODEL`):

```ts
  /** Global default for the elastic lanes; per-lane flags override it. Flagship-driven; var optional. */
  ELASTIC_LANE_DEFAULT_OPENROUTER?: string;
```

- [ ] **Step 4: Add the cost + logging-wrap helpers**

In `workers/api/src/lib/text-model.ts`, add above `resolveTextModel`:

```ts
/** Anthropic reports no cost; derive a list-price estimate. OpenRouter reports its own via usage.costUsd. */
function laneCost(provider: string, model: string, usage: TextModelUsage): number | undefined {
  if (provider !== "anthropic") return undefined;
  return (
    estimateCost(
      {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheWriteTokens: usage.cacheCreate,
        cacheReadTokens: usage.cacheRead,
      },
      model,
    )?.totalUsd ?? undefined
  );
}

/** Wrap a resolved model so each call emits an `ai_usage` event into the worker log stream. */
function withLaneUsageLogging(model: TextModel, lane: string, env: TextModelEnv): TextModel {
  return withUsageLogging(model, {
    lane,
    environment: env.ENVIRONMENT,
    deriveCost: laneCost,
    sink: (r) => logEvent("info", { component: "ai", event: "ai_usage", ...r }),
  });
}
```

- [ ] **Step 5: Rewrite the body of `resolveTextModel`**

Replace the current body of `resolveTextModel` (from `const useOpenRouter = ...` through the final `return anthropicTextModel(...)`) with:

```ts
const laneState = await flagState(env.FLAGS, opts.varValue, opts.flagDef);
const useOpenRouter =
  laneState === "unset"
    ? await flag(env.FLAGS, env.ELASTIC_LANE_DEFAULT_OPENROUTER, FLAGS.elasticLaneDefaultOpenrouter)
    : laneState === "on";

if (useOpenRouter) {
  const orKey = await getSecret(env.OPENROUTER_API_KEY).catch(() => null);
  const model = opts.orModel?.trim();
  if (orKey && model) {
    const baseURL = env.OPENROUTER_BASE_URL?.trim();
    return withLaneUsageLogging(
      openRouterTextModel({
        apiKey: orKey,
        model,
        ...(baseURL ? { baseURL } : {}),
        referer: "https://releases.sh",
        title: opts.title,
        trace: {
          generationName: opts.generationName,
          ...(env.ENVIRONMENT ? { environment: env.ENVIRONMENT } : {}),
        },
      }),
      opts.generationName,
      env,
    );
  }
  // key/model not configured → fall through to Anthropic (fail open)
}

// Key + gateway opts are independent secret/var reads — resolve concurrently.
const [apiKey, gatewayOpts] = await Promise.all([getAnthropicKey(env), resolveGatewayOpts(env)]);
if (!apiKey) return null;
const client = buildAnthropicClient({ apiKey, ...gatewayOpts });
return withLaneUsageLogging(
  anthropicTextModel(client, opts.anthropicModel),
  opts.generationName,
  env,
);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test workers/api/src/lib/text-model.test.ts`
Expected: PASS (all 7 inheritance/fallback cases green).

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/lib/text-model.ts workers/api/src/lib/text-model.test.ts
git commit -m "$(cat <<'EOF'
feat(api): elastic-lane global provider default + ai_usage logging

resolveTextModel now inherits the global elastic-lane-default-openrouter flag
when a lane is unset (per-lane flag still overrides), and wraps every resolved
model in withUsageLogging → one ai_usage logEvent per call (tokens + cost;
Anthropic cost derived via anthropic-pricing) into the existing Axiom dataset.

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Documentation + full verification + Flagship note

**Files:**

- Modify: `docs/architecture/ai-gateway.md`

- [ ] **Step 1: Document the two-layer model and the `ai_usage` event**

In `docs/architecture/ai-gateway.md`, add a new section after the existing `## OpenRouter Broadcast observability` section:

```markdown
## Routing policy + the elastic-lane provider switch

**Layer 1 — Transport (fixed rule, not a flag).** Every non-managed-agent call traverses exactly one proxy, chosen by protocol — never two in series:

- Anthropic-protocol calls → CF AI Gateway (base-URL passthrough; preserves prompt caching).
- OpenRouter calls → OpenRouter directly.
- Managed-agents session/memory surface → direct to Anthropic (see "Not covered" above).

There is deliberately **no transport-selector flag**: the protocol decides the proxy, so a call is never double-hopped, and CF-AI-Gateway-fronting-OpenRouter is not adopted.

**Layer 2 — Provider selection (the switch).** For the elastic lanes on the `TextModel` seam, the `elastic-lane-default-openrouter` Flagship flag is the global default; each per-lane flag (`marketing-classifier-openrouter`, `summarize-openrouter`, …) inherits it when unset and overrides it when set. Flip the global ON to move every elastic lane that has an OpenRouter model configured onto OpenRouter at runtime; OFF returns them to Anthropic. A lane with the toggle on but no OpenRouter model stays on Anthropic (fail-open). Model ids stay per-lane. Inheritance is implemented in `workers/api/src/lib/text-model.ts` via `flagState()`.

**Unified usage view.** `resolveTextModel` wraps every resolved model in `withUsageLogging`, emitting one `ai_usage` `logEvent` per call: `provider`, `model`, `lane`, `environment`, token counts, and `costUsd` (provider-reported for OpenRouter; derived via `@releases/lib/anthropic-pricing` for Anthropic). These ride in the existing `releases-cloudflare-logs` Axiom dataset as the `ai_usage` event — **no new dataset**. Query example: `["releases-cloudflare-logs"] | where ["event"] == "ai_usage" | summarize sum(toreal(costUsd)) by ["lane"], ["provider"]`.

**Enabling the switch (Flagship, no deploy).** Create the `elastic-lane-default-openrouter` key in BOTH Flagship apps (`releases-platform` and `releases-platform-staging`) per the feature-flag convention; default OFF. There is no wrangler var for this flag — Flagship drives it, with the registry default (`false`) as the floor. Rollback is a Flagship toggle.
```

- [ ] **Step 2: Run the full type-check, tests, lint, and format**

Run each and confirm clean:

```bash
npx tsc --noEmit
npx tsc --noEmit -p workers/api/tsconfig.json
bun test packages/lib/src/flags.test.ts packages/ai/src/text-model.test.ts workers/api/src/lib/text-model.test.ts
bun run lint
bun run format:check
```

Expected: type-check clean (root + api worker); the three targeted test files PASS; lint clean; format clean. If `format:check` flags the new files, run `bun run format` and re-stage.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/ai-gateway.md
git commit -m "$(cat <<'EOF'
docs(ai-gateway): transport rule, elastic-lane switch, ai_usage event

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 4: Manual deploy step (record, do not automate)**

Before relying on the switch in any environment: create the Flagship key `elastic-lane-default-openrouter` in `releases-platform` and `releases-platform-staging` (default OFF). Then follow the spec's rollout: enable OpenRouter Broadcast → R2 in the OpenRouter dashboard, flip the flag in staging, confirm the `ai_usage` view in Axiom, then flip in prod. This step is operational — leave the checkbox for the human operator.

---

## Self-review notes

- **Spec coverage:** Layer-1 transport rule → Task 4 doc; Layer-2 global flag + inheritance → Tasks 1 + 3; per-lane override preserved → Task 3 tests; model ids stay per-lane → unchanged resolver (`opts.orModel`/`opts.anthropicModel`); three-state resolution → Task 1; usage-logging decorator + Anthropic cost derivation + no new dataset → Tasks 2 + 3 + 4; fail-open preserved → Task 3 tests; testing + rollout → Task 4. Wrangler-var line from the spec intentionally narrowed to an optional `TextModelEnv` field (documented deviation above).
- **Type consistency:** `flagState`/`FlagState` (Task 1) consumed in Task 3; `withUsageLogging`/`UsageRecord`/`UsageSink` (Task 2) consumed in Task 3; `TextModelUsage` fields (`input`/`output`/`cacheCreate`/`cacheRead`/`costUsd`) mapped to `TokenUsage` (`inputTokens`/`outputTokens`/`cacheWriteTokens`/`cacheReadTokens`) in `laneCost`; `SecretBinding` shape `{ get(): Promise<string|null> }` matches the test `secret()` stub.
- **No placeholders:** every code step shows complete code; every run step shows the command + expected result.
