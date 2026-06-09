/**
 * Build an AI-SDK `LanguageModel` for the large-body extraction tool-loop via
 * OpenRouter (DeepSeek). The worker resolves this only when the
 * `openrouter-enabled` flag is on AND `EXTRACT_MODEL` + an OpenRouter key are
 * configured; otherwise the Anthropic SDK loop runs unchanged (fail open).
 */

import { createOpenRouter, type OpenRouterChatSettings } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

export interface OpenRouterExtractModelOpts {
  apiKey: string;
  model: string;
  baseURL?: string;
}

/**
 * Build an AI-SDK LanguageModel for extraction via OpenRouter, with REASONING
 * DISABLED — extraction is mechanical enumeration; reasoning-on causes DeepSeek
 * to under-extract (issue #1536).
 */
export function buildOpenRouterExtractModel(opts: OpenRouterExtractModelOpts): LanguageModel {
  const provider = createOpenRouter({
    apiKey: opts.apiKey,
    ...(opts.baseURL ? { baseURL: opts.baseURL } : {}),
  });
  // `reasoning.enabled: false` turns off chain-of-thought; the provider's
  // settings type models `reasoning` as a discriminated union that also expects
  // `max_tokens`/`effort` when enabled, so narrow-cast the disable-only shape.
  return provider(opts.model, {
    reasoning: { enabled: false },
  } as OpenRouterChatSettings);
}
