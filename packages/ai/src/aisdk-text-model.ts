/**
 * AI SDK v7 `TextModel` adapter — routes cheap-call lanes through `generateText`
 * instead of direct Anthropic `messages.create` or the hand-rolled OpenRouter fetch.
 */

import { generateText, type LanguageModel } from "ai";
import type { TextModel, TextModelRequest, TextModelResult } from "./text-model";

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

function providerCostUsd(meta: Record<string, unknown> | undefined): number | undefined {
  const openrouter = meta?.openrouter as { usage?: { cost?: unknown } } | undefined;
  const cost = openrouter?.usage?.cost;
  return typeof cost === "number" ? cost : undefined;
}

function usageFromGenerateText(
  res: Awaited<ReturnType<typeof generateText>>,
): TextModelResult["usage"] {
  const u = res.usage;
  return {
    // Anthropic `input_tokens` excludes cache; AI SDK surfaces that as noCacheTokens.
    input: u.inputTokenDetails?.noCacheTokens ?? u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    cacheCreate: u.inputTokenDetails?.cacheWriteTokens ?? 0,
    cacheRead: u.inputTokenDetails?.cacheReadTokens ?? 0,
    costUsd: providerCostUsd(res.finalStep?.providerMetadata),
  };
}

export interface AisdkTextModelOpts {
  /** Per-call timeout (ms) passed to `AbortSignal.timeout`. */
  timeoutMs?: number;
}

/** Wrap a ready `LanguageModel` as a `TextModel` for the cheap-call lane helpers. */
export function aisdkTextModel(
  model: LanguageModel,
  id: string,
  opts?: AisdkTextModelOpts,
): TextModel {
  return {
    id,
    async complete(req: TextModelRequest): Promise<TextModelResult> {
      const res = await generateText({
        model,
        instructions: req.cacheSystem
          ? [{ role: "system", content: req.system, providerOptions: EPHEMERAL }]
          : req.system,
        prompt: req.user,
        maxOutputTokens: req.maxTokens,
        // Callers (poll-fetch, marketing classifier, …) own per-item retry/fail-open;
        // internal SDK retries would amplify cost and stall workflow tests.
        maxRetries: 0,
        ...(opts?.timeoutMs ? { abortSignal: AbortSignal.timeout(opts.timeoutMs) } : {}),
      });
      return { text: res.text, usage: usageFromGenerateText(res) };
    },
  };
}
