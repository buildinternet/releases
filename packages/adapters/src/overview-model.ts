/**
 * Build an AI-SDK `LanguageModel` for the org-overview structured-output lane
 * (#1928). The overview is generated via `generateText` + `Output.object`, so the
 * citation list comes back as a typed field instead of a fenced JSON block scraped
 * out of prose. Two providers mirror the existing `resolveOverviewModel` fail-open:
 * OpenRouter in prod, Anthropic Haiku when OpenRouter is off/misconfigured.
 *
 * Sibling of `openrouter-model.ts` (the extract lane); kept separate because the
 * overview lane carries OpenRouter ranking headers + provider-routing prefs and
 * has its own sticky-routing session id.
 */

import { createOpenRouter, type OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

export interface OverviewOpenRouterModelOpts {
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Sticky-routing + Broadcast grouping key for this lane (e.g. "org-overview"). */
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
   * snake_case, mirroring the `openRouterChat` transport, so this lane is grouped
   * and environment-separated (prod vs. eval) alongside the other OpenRouter lanes.
   */
  trace?: { generationName?: string; environment?: string };
}

/** Serialize Broadcast trace tags to the snake_case shape OpenRouter expects. */
function serializeTrace(
  trace: OverviewOpenRouterModelOpts["trace"],
): Record<string, string> | undefined {
  if (!trace) return undefined;
  const out: Record<string, string> = {};
  if (trace.generationName) out.generation_name = trace.generationName;
  if (trace.environment) out.environment = trace.environment;
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build the OpenRouter overview model with REASONING DISABLED (an overview is a
 * summarization task; reasoning-on burns the budget thinking — same rationale as
 * the summarize lanes). Ranking headers + a stable `session_id` (header and body,
 * mirroring the hand-rolled `openRouterChat` transport) steer prompt-cache reuse
 * for the shared system prompt.
 */
export function buildOverviewOpenRouterModel(opts: OverviewOpenRouterModelOpts): LanguageModel {
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
      ...(serializeTrace(opts.trace) ? { trace: serializeTrace(opts.trace) } : {}),
    },
  });
  // `reasoning.enabled: false` is a disable-only shape; the settings type models
  // `reasoning` as a union expecting `max_tokens`/`effort` when enabled, so narrow-cast.
  return provider(opts.model, { reasoning: { enabled: false } } as OpenRouterChatSettings);
}

export interface OverviewAnthropicModelOpts {
  apiKey: string;
  model: string;
  /** CF AI Gateway base URL, when the gateway passthrough is configured. */
  baseURL?: string;
  /** CF AI Gateway token → `cf-aig-authorization` header (mirrors `buildAnthropicClient`). */
  gatewayToken?: string;
}

/** Build the Anthropic fail-open overview model, preserving the CF AI Gateway routing when configured. */
export function buildOverviewAnthropicModel(opts: OverviewAnthropicModelOpts): LanguageModel {
  const provider = createAnthropic({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    ...(opts.gatewayToken
      ? { headers: { "cf-aig-authorization": `Bearer ${opts.gatewayToken}` } }
      : {}),
  });
  return provider(opts.model);
}
