/**
 * Build an AI-SDK `LanguageModel` for the large-body extraction tool-loop via
 * OpenRouter (DeepSeek). The worker resolves this only when the
 * `openrouter-enabled` flag is on AND `EXTRACT_MODEL` + an OpenRouter key are
 * configured; otherwise the Anthropic SDK loop runs unchanged (fail open).
 */

import { createOpenRouter, type OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/**
 * Stable session id baked into every extraction request. OpenRouter uses it for
 * provider sticky routing — subsequent requests carrying the same id are steered
 * to the same upstream endpoint, where any prompt cache lives. The tool-loop is
 * the textbook beneficiary: a single fetch fires many rounds that share the
 * ~50K-token static prefix, and that prefix is byte-identical across *every*
 * source, so pinning to one endpoint lets DeepSeek's automatic prefix cache be
 * read instead of re-paid both within a loop and across fetches.
 *
 * A constant (not per-fetch) value is deliberate: it maximizes cross-fetch
 * prefix reuse and needs no plumbing through the deps layer (the model is built
 * once per worker invocation with no source id in scope). Sticky routing is
 * best-effort affinity, not a hard pin — `allow_fallbacks` still lets load spill
 * to other endpoints — so this steers cache hits without bottlenecking. Callers
 * may override per-fetch (e.g. to keep Broadcast traces separable once Broadcast
 * is enabled); today Broadcast is inert so the constant has no tracing cost.
 */
export const EXTRACT_SESSION_ID = "extract";

export interface OpenRouterExtractModelOpts {
  apiKey: string;
  model: string;
  baseURL?: string;
  /** Override the sticky-routing session id. Defaults to `EXTRACT_SESSION_ID`. */
  sessionId?: string;
}

/**
 * Build an AI-SDK LanguageModel for extraction via OpenRouter, with REASONING
 * DISABLED — extraction is mechanical enumeration; reasoning-on causes DeepSeek
 * to under-extract (issue #1536). A sticky-routing `session_id` is attached at
 * the provider level (body + header, mirroring the `openRouterChat` transport)
 * so the shared prefix cache is reused — see `EXTRACT_SESSION_ID`.
 */
export function buildOpenRouterExtractModel(opts: OpenRouterExtractModelOpts): LanguageModel {
  const sessionId = opts.sessionId ?? EXTRACT_SESSION_ID;
  const provider = createOpenRouter({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
    // Belt-and-suspenders: OpenRouter accepts the sticky-routing session id via
    // either the `x-session-id` header or a top-level `session_id` body field.
    headers: { "x-session-id": sessionId },
    extraBody: { session_id: sessionId },
  });
  // `reasoning.enabled: false` turns off chain-of-thought; the provider's
  // settings type models `reasoning` as a discriminated union that also expects
  // `max_tokens`/`effort` when enabled, so narrow-cast the disable-only shape.
  return provider(opts.model, {
    reasoning: { enabled: false },
  } as OpenRouterChatSettings);
}
