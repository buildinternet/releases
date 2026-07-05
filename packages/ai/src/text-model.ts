/**
 * Provider-agnostic text-completion seam. A `TextModel` takes a system prompt,
 * a single user message, and a token cap, and returns text + token/cost usage.
 * Two adapters: Anthropic (wraps the SDK `messages.create`, keeps prompt
 * caching) and OpenRouter (wraps the OpenAI-compatible transport). Env-agnostic:
 * the caller constructs the concrete model so workers can route through a
 * gateway and pick a provider per flag.
 *
 * This is the seam that lets cheap, high-volume calls (the marketing classifier
 * today) run on a sub-Haiku model without rewriting prompts or parse logic.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { openRouterChat, type OpenRouterOptions } from "./openrouter-client";

export interface TextModelUsage {
  input: number;
  output: number;
  cacheCreate: number;
  cacheRead: number;
  /** Provider-reported cost (OpenRouter). Undefined for Anthropic — derive via anthropic-pricing. */
  costUsd?: number;
}

export interface TextModelRequest {
  system: string;
  user: string;
  maxTokens: number;
  /**
   * Advisory: cache the static system prompt when the provider supports it
   * (Anthropic ephemeral block). Silently ignored by the OpenRouter adapter.
   */
  cacheSystem?: boolean;
}

export interface TextModelResult {
  text: string;
  usage: TextModelUsage;
  /**
   * True when the provider stopped because it hit `maxTokens` (Anthropic
   * `stop_reason: "max_tokens"`, OpenRouter `finish_reason: "length"`) rather
   * than finishing naturally — i.e. the output is cut off. Consumers that parse
   * a trailing structured section (e.g. the overview citation list) must treat a
   * truncated result as unreliable. Undefined when the provider reports nothing.
   */
  truncated?: boolean;
}

export interface TextModel {
  /** `<provider>:<model>` — used for telemetry / log attribution. */
  readonly id: string;
  complete(req: TextModelRequest): Promise<TextModelResult>;
}

/** Wrap an Anthropic SDK client as a `TextModel`. Honors `cacheSystem` via an ephemeral cache block. */
export function anthropicTextModel(client: Anthropic, model: string): TextModel {
  return {
    id: `anthropic:${model}`,
    async complete({ system, user, maxTokens, cacheSystem }) {
      const res = await client.messages.create({
        model,
        max_tokens: maxTokens,
        system: cacheSystem
          ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
          : system,
        messages: [{ role: "user", content: user }],
      });
      const text = res.content
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("");
      return {
        text,
        truncated: res.stop_reason === "max_tokens",
        usage: {
          input: res.usage.input_tokens,
          output: res.usage.output_tokens,
          cacheCreate: res.usage.cache_creation_input_tokens ?? 0,
          cacheRead: res.usage.cache_read_input_tokens ?? 0,
        },
      };
    },
  };
}

/**
 * Wrap OpenRouter as a `TextModel`. `transport` is injectable for tests; it
 * defaults to the real `openRouterChat`. `cacheSystem` is ignored — OpenRouter
 * prompt caching is model-specific and not requested by this lane.
 */
export function openRouterTextModel(
  opts: OpenRouterOptions,
  transport: typeof openRouterChat = openRouterChat,
): TextModel {
  return {
    id: `openrouter:${opts.model}`,
    // `OpenRouterResult` is structurally `TextModelResult`, so the transport
    // result is returned directly.
    complete: ({ system, user, maxTokens }) => transport(opts, { system, user, maxTokens }),
  };
}

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
  /**
   * Total prompt tokens for this call, NORMALIZED so a cache-hit rate is
   * comparable across providers (see `cacheMetrics`). Raw `input` is NOT
   * comparable: Anthropic's `input_tokens` excludes the cached portion while
   * OpenRouter's `prompt_tokens` includes it.
   */
  promptTokens: number;
  /** `cacheRead / promptTokens`, clamped to [0,1] (0 when promptTokens is 0). */
  cacheHitRate: number;
  /** USD cost: provider-reported for OpenRouter, derived for Anthropic, undefined if unknown. */
  costUsd?: number;
}

export type UsageSink = (record: UsageRecord) => void;

/** Split a `<provider>:<model>` TextModel id on the first ":". */
export function splitModelId(id: string): { provider: string; model: string } {
  const i = id.indexOf(":");
  return i === -1
    ? { provider: "unknown", model: id }
    : { provider: id.slice(0, i), model: id.slice(i + 1) };
}

/**
 * Derive a provider-comparable prompt-token total and cache-hit rate from raw
 * usage. The two providers report the prompt differently:
 *   - Anthropic: `input` (`input_tokens`) EXCLUDES cache reads/writes, which are
 *     reported separately → total prompt = input + cacheRead + cacheCreate.
 *   - OpenRouter (OpenAI shape): `input` (`prompt_tokens`) already INCLUDES the
 *     cached portion (`cached_tokens`), and no cache-write count is surfaced
 *     (`cacheCreate` is 0) → total prompt = input.
 * Normalizing here lets a dashboard compute `sum(cacheRead)/sum(promptTokens)`
 * per lane and compare Anthropic vs. OpenRouter on the same axis.
 */
function cacheMetrics(
  provider: string,
  usage: TextModelUsage,
): { promptTokens: number; cacheHitRate: number } {
  const promptTokens =
    provider === "openrouter" ? usage.input : usage.input + usage.cacheRead + usage.cacheCreate;
  const cacheHitRate =
    promptTokens > 0 ? Math.min(1, Math.max(0, usage.cacheRead / promptTokens)) : 0;
  return { promptTokens, cacheHitRate };
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
        const { promptTokens, cacheHitRate } = cacheMetrics(provider, result.usage);
        opts.sink({
          provider,
          model,
          lane: opts.lane,
          environment: opts.environment,
          input: result.usage.input,
          output: result.usage.output,
          cacheCreate: result.usage.cacheCreate,
          cacheRead: result.usage.cacheRead,
          promptTokens,
          cacheHitRate,
          costUsd,
        });
      } catch {
        // best-effort observability — never break the AI call path
      }
      return result;
    },
  };
}
