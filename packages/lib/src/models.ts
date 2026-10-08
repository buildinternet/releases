/**
 * LLM model registry — the only place a production model id is chosen.
 *
 * Call sites ask for a role (`modelId("extraction")`). Env-aware resolution
 * lives in `./resolve-model.ts` (`resolveModel`), which reads the same role
 * pins. Request builders spread `samplingParams` and `thinkingParams` /
 * `thinkingProviderOptions`, which come from `modelCapabilities`, instead of
 * matching id substrings at the call site.
 *
 * Bump a model:
 *   1. Change the id string on the pin below (`HAIKU` or `SONNET`, or an
 *      OpenRouter entry). Roles that share a pin move together; give a role
 *      its own pin when it should move alone.
 *   2. If the new id is an Anthropic model, add a row to `ANTHROPIC_PRICING`
 *      in `anthropic-pricing.ts`. Keep historical rows.
 *   3. Set `capabilities` on the pin when the new model does not already
 *      match a family fragment below. Exact pin ids win over fragments.
 *
 * Wrangler vars (`SUMMARIZE_MODEL`, `EXTRACT_MODEL`, `FEED_ENRICH_MODEL`,
 * `MARKETING_CLASSIFIER_MODEL`) and `/admin/models` still replace the
 * OpenRouter lane at runtime. `OPENROUTER_MODELS` is what code uses when
 * those are unset. Lane-wide OpenRouter `reasoning: { enabled: false }` stays
 * on the lane (it must apply to whatever id an operator overlays), not on a
 * single catalog row.
 */

export interface ModelCapabilities {
  /** Non-default `temperature` is accepted. False → omit it (the API 400s). */
  temperature: boolean;
  /** Non-default `top_p` is accepted. False → omit it. */
  topP: boolean;
  /** Any `top_k` is accepted. False → omit it. */
  topK: boolean;
  /**
   * Adaptive thinking is on by default and those tokens count against
   * `max_tokens`. True → send `thinking: { type: "disabled" }`. Sonnet 5.5
   * does not use this shape (it turns up-front thinking off with
   * `between_tools`, which we never set).
   */
  disableThinking: boolean;
}

export interface ModelPin {
  id: string;
  /** Key in `ANTHROPIC_PRICING`, or null for a non-Anthropic pin. */
  pricingId: string | null;
  capabilities: ModelCapabilities;
}

/** Sampling parameters rejected; thinking left at the provider default. */
const NO_SAMPLING: ModelCapabilities = {
  temperature: false,
  topP: false,
  topK: false,
  disableThinking: false,
};

/** Sampling rejected, and adaptive thinking must be turned off. */
const NO_SAMPLING_NO_THINKING: ModelCapabilities = {
  ...NO_SAMPLING,
  disableThinking: true,
};

/** Unknown ids: honor temperature (extraction's determinism knob) and do not send Anthropic thinking options. */
const DEFAULT_CAPABILITIES: ModelCapabilities = {
  temperature: true,
  topP: true,
  topK: true,
  disableThinking: false,
};

function anthropicPin(id: string, capabilities: ModelCapabilities): ModelPin {
  return { id, pricingId: id, capabilities };
}

function unpricedPin(id: string, capabilities: ModelCapabilities): ModelPin {
  return { id, pricingId: null, capabilities };
}

/**
 * Shared pins. Several Anthropic roles point at `HAIKU` so a cheap-lane bump
 * is this one id. Split a role onto its own `anthropicPin(...)` when it
 * should move independently.
 */
const HAIKU = anthropicPin("claude-haiku-5-5", NO_SAMPLING_NO_THINKING);
const SONNET = anthropicPin("claude-sonnet-5-5", NO_SAMPLING);

export const MODEL_ROLES = {
  /** Release summaries, collection summaries, org overviews. Anthropic fallback. */
  summarize: HAIKU,
  /** Marketing classifier. Anthropic fallback when the lane is not on JEV. */
  marketing: HAIKU,
  /** Single-article feed enrichment. Anthropic fallback (Batches stay here). */
  articleExtract: HAIKU,
  /** One-shot, incremental, Firecrawl, backfill, and refetch extraction. */
  extraction: HAIKU,
  /** web_fetch agent loop and the large-body tool loop. */
  extractionAgent: SONNET,
  /** Eval-harness judge. `JUDGE_MODEL` overrides this in `tests/evals/judge-model.ts`. */
  evalJudge: unpricedPin("google/gemini-2.5-flash", DEFAULT_CAPABILITIES),
} as const satisfies Record<string, ModelPin>;

export type ModelRole = keyof typeof MODEL_ROLES;

/**
 * Process-env overrides for Anthropic roles. Canonical name, then the legacy
 * `RELEASED_*` name. Read by `resolveModel` and by `config`'s accessors.
 * OpenRouter lanes are not here — those are wrangler vars plus `/admin/models`.
 */
export const MODEL_ROLE_ENV = {
  summarize: ["RELEASES_SUMMARY_MODEL", "RELEASED_SUMMARY_MODEL"],
  extraction: ["RELEASES_INGEST_MODEL", "RELEASED_INGEST_MODEL"],
  extractionAgent: ["RELEASES_AGENT_MODEL", "RELEASED_AGENT_MODEL"],
} as const satisfies Partial<Record<ModelRole, readonly [string, string]>>;

/**
 * OpenRouter ids used when the lane's wrangler var and admin overlay are
 * absent. Production sets the same ids in `apps/api/wrangler.jsonc`; that
 * file is the deployed override, not a second code default.
 */
export const OPENROUTER_MODELS = {
  summarize: "deepseek/deepseek-v4.1-flash",
  extract: "deepseek/deepseek-v4.1-flash",
  feedEnrich: "deepseek/deepseek-v4.1-flash",
  marketing: "typesafe/jev-1.13",
} as const;

export function modelId(role: ModelRole): string {
  return MODEL_ROLES[role].id;
}

/**
 * Families whose capabilities are known even when they are not the current
 * pin (older Sonnet 5, Opus 4.7/4.8, Fable, Mythos, a dated or
 * provider-prefixed Haiku 5 id). Exact pin ids are matched first.
 */
const CAPABILITY_FAMILIES: readonly { fragment: string; capabilities: ModelCapabilities }[] = [
  { fragment: "haiku-5", capabilities: NO_SAMPLING_NO_THINKING },
  { fragment: "sonnet-5", capabilities: NO_SAMPLING },
  { fragment: "opus-4-7", capabilities: NO_SAMPLING },
  { fragment: "opus-4-8", capabilities: NO_SAMPLING },
  { fragment: "fable-5", capabilities: NO_SAMPLING },
  { fragment: "mythos-", capabilities: NO_SAMPLING },
];

const CAPABILITY_BY_ID = new Map<string, ModelCapabilities>();
for (const pin of Object.values(MODEL_ROLES)) {
  CAPABILITY_BY_ID.set(pin.id, pin.capabilities);
}

/**
 * Strip a provider prefix (`anthropic:`) and a trailing `-YYYYMMDD` snapshot
 * so capability lookup matches the id we send and the id the API echoes.
 * Pricing keeps its own date-only normalizer — do not route that through
 * here; prefixed ids are not pricing keys today.
 */
export function canonicalModelId(model: string): string {
  const trimmed = model.trim();
  const colon = trimmed.lastIndexOf(":");
  const bare = colon === -1 ? trimmed : trimmed.slice(colon + 1);
  return bare.replace(/-\d{8}$/, "");
}

export function modelCapabilities(model: string): ModelCapabilities {
  const canonical = canonicalModelId(model);
  const exact = CAPABILITY_BY_ID.get(canonical);
  if (exact) return exact;
  for (const family of CAPABILITY_FAMILIES) {
    if (model.includes(family.fragment) || canonical.includes(family.fragment)) {
      return family.capabilities;
    }
  }
  return DEFAULT_CAPABILITIES;
}

export function modelAcceptsTemperature(model: string): boolean {
  return modelCapabilities(model).temperature;
}

export function modelRequiresThinkingDisabled(model: string): boolean {
  return modelCapabilities(model).disableThinking;
}

/** Sampling fields safe to spread onto a Messages or AI SDK request. Omitted keys are the ones the model rejects. */
export function samplingParams(
  model: string,
  requested: { temperature?: number; topP?: number; topK?: number },
): { temperature?: number; top_p?: number; top_k?: number } {
  const caps = modelCapabilities(model);
  const out: { temperature?: number; top_p?: number; top_k?: number } = {};
  if (requested.temperature !== undefined && caps.temperature) {
    out.temperature = requested.temperature;
  }
  if (requested.topP !== undefined && caps.topP) out.top_p = requested.topP;
  if (requested.topK !== undefined && caps.topK) out.top_k = requested.topK;
  return out;
}

/** Spread onto a Messages API `create` / `stream` / batch `params` object. */
export function thinkingParams(
  model: string,
): { thinking: { type: "disabled" } } | Record<string, never> {
  return modelRequiresThinkingDisabled(model) ? { thinking: { type: "disabled" } } : {};
}

/**
 * AI SDK `providerOptions` for `generateText`. `@ai-sdk/anthropic` forwards
 * `thinking.type: "disabled"` onto the request body. Undefined for every
 * other model so OpenRouter and Sonnet calls are left alone.
 */
export function thinkingProviderOptions(
  model: string,
): { anthropic: { thinking: { type: "disabled" } } } | undefined {
  if (!modelRequiresThinkingDisabled(model)) return undefined;
  return { anthropic: { thinking: { type: "disabled" } } };
}
