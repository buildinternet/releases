/**
 * Shared AI-SDK `LanguageModel` builders for secondary cheap-call lanes and
 * structured-output lanes (org overview, marketing classifier, summarizer, …).
 * OpenRouter carries ranking headers, sticky `session_id`, Broadcast trace tags,
 * and optional provider-routing prefs; Anthropic preserves CF AI Gateway routing.
 */

import { createOpenRouter, type OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export interface LaneOpenRouterModelOpts {
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Sticky-routing + Broadcast grouping key for this lane (e.g. "marketing-classifier"). */
  sessionId: string;
  /** OpenRouter app-ranking header (`HTTP-Referer`). */
  referer: string;
  /** OpenRouter display title (`X-Title`). */
  title: string;
  /** Provider-routing preferences merged into the request body (e.g. `{ ignore: ["gmicloud"] }`). */
  providerPrefs?: Record<string, unknown>;
  /**
   * Broadcast observability tags (inert until Broadcast is enabled in the
   * OpenRouter dashboard). Serialized into the top-level `trace` body field in
   * snake_case, mirroring the legacy `openRouterChat` transport.
   */
  trace?: { generationName?: string; environment?: string };
  /**
   * OpenRouter unified `reasoning` control. Summarize lanes pass `{ enabled: false }`
   * so reasoning models do not burn the small output budget on chain-of-thought.
   */
  reasoning?: { enabled?: boolean; effort?: "low" | "medium" | "high"; max_tokens?: number };
}

export interface LaneAnthropicModelOpts {
  apiKey: string;
  model: string;
  /** CF AI Gateway base URL, when the gateway passthrough is configured. */
  baseURL?: string;
  /** CF AI Gateway token → `cf-aig-authorization` header (mirrors `buildAnthropicClient`). */
  gatewayToken?: string;
}

/** Serialize Broadcast trace tags to the snake_case shape OpenRouter expects. */
function serializeTrace(
  trace: LaneOpenRouterModelOpts["trace"],
): Record<string, string> | undefined {
  if (!trace) return undefined;
  const out: Record<string, string> = {};
  if (trace.generationName) out.generation_name = trace.generationName;
  if (trace.environment) out.environment = trace.environment;
  return Object.keys(out).length > 0 ? out : undefined;
}

/** Build an OpenRouter lane model (reasoning disabled by default when `reasoning` is set). */
export function buildLaneOpenRouterModel(opts: LaneOpenRouterModelOpts): LanguageModel {
  const trace = serializeTrace(opts.trace);
  const provider = createOpenRouter({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    headers: {
      "HTTP-Referer": opts.referer,
      "X-Title": opts.title,
      "x-session-id": opts.sessionId,
    },
    extraBody: {
      session_id: opts.sessionId,
      ...(opts.providerPrefs ? { provider: opts.providerPrefs } : {}),
      ...(trace ? { trace } : {}),
    },
  });
  const settings = opts.reasoning
    ? ({ reasoning: opts.reasoning } as OpenRouterChatSettings)
    : undefined;
  return provider(opts.model, settings);
}

/** Build the Anthropic fail-open lane model, preserving CF AI Gateway routing when configured. */
export function buildLaneAnthropicModel(opts: LaneAnthropicModelOpts): LanguageModel {
  const provider = createAnthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.gatewayToken
      ? { headers: { "cf-aig-authorization": `Bearer ${opts.gatewayToken}` } }
      : {}),
  });
  return provider(opts.model);
}
