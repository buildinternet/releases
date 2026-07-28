/**
 * The AI-SDK one-shot extraction path — a provider-agnostic port of the legacy
 * Anthropic-SDK single-call extraction in `extract-from-body.ts` (`runOneShot`).
 * This is the tier that handles the large majority of extractions (everything
 * under `LARGE_BODY_TOKEN_THRESHOLD`), so routing it through the AI SDK is what
 * lets `EXTRACT_MODEL` (OpenRouter) govern the bulk of extraction spend instead
 * of only the rare large-body tool-loop (issue #2166).
 *
 * Mirrors `extract-with-tools-aisdk.ts`'s shape (a caller-supplied `LanguageModel`
 * + a single forced tool call), but simpler: one round, no `get_slice`/`query_json`
 * tools, no cache-breakpoint rotation across rounds — there's only one round.
 * The static system prompt still carries an Anthropic cache-control marker
 * (advisory; ignored by non-Anthropic providers) so repeated one-shot calls on
 * Anthropic keep benefiting from prompt caching the way the direct-SDK path did.
 */

import {
  generateText,
  jsonSchema,
  tool,
  type JSONSchema7,
  type LanguageModel,
  type ModelMessage,
} from "ai";
import {
  EXTRACTION_TEMPERATURE,
  extractReleasesToolCrawl,
  extractReleasesToolFull,
  modelAcceptsTemperature,
} from "./shared.js";
import type { ExtractedEntry, ExtractLogger } from "./types.js";

/** Same shape as `extract-with-tools-aisdk.ts`'s `EPHEMERAL` — duplicated locally
 *  rather than shared because it's a two-line literal and the two files are
 *  independently dynamic-imported (keeping them decoupled avoids pulling one
 *  tier's module into the other's import graph). */
const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

export interface OneShotAiSdkDeps {
  model: LanguageModel;
  /** Model id string for telemetry + the `modelAcceptsTemperature` gate — the
   *  `LanguageModel` object itself doesn't expose a plain id. */
  modelLabel: string;
  logger: ExtractLogger;
}

export interface OneShotAiSdkOpts {
  /** Already truncated to the caller's MAX_BODY_CHARS budget. */
  body: string;
  /** Fully composed system prompt (base prompt + guidance already folded in via `withGuidance`). */
  systemPrompt: string;
  /** Large-body guardrail text, appended as a second, uncached system block — omit when not applicable. */
  guardrail?: string;
  userMessage: string;
  maxOutputTokens: number;
  preserveBody?: boolean;
}

export interface OneShotAiSdkResult {
  entries: ExtractedEntry[];
  totalInput: number;
  totalOutput: number;
  hitMaxTokens: boolean;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export async function runOneShotAiSdk(
  opts: OneShotAiSdkOpts,
  deps: OneShotAiSdkDeps,
): Promise<OneShotAiSdkResult> {
  const toolDef = opts.preserveBody ? extractReleasesToolCrawl : extractReleasesToolFull;

  const instructions: ModelMessage[] = [
    { role: "system", content: opts.systemPrompt, providerOptions: EPHEMERAL },
    ...(opts.guardrail ? [{ role: "system", content: opts.guardrail } as ModelMessage] : []),
  ];

  const result = await generateText({
    model: deps.model,
    instructions: instructions as Parameters<typeof generateText>[0]["instructions"],
    messages: [{ role: "user", content: `${opts.userMessage}\n\n${opts.body}` }],
    tools: {
      extract_releases: tool({
        description: toolDef.description!,
        inputSchema: jsonSchema<{ releases: ExtractedEntry[] }>(
          toolDef.input_schema as JSONSchema7,
        ),
      }),
    },
    toolChoice: { type: "tool", toolName: "extract_releases" },
    // Deterministic parse on models that still accept a non-default temperature
    // (Haiku one-shot, Sonnet 4.6, most OpenRouter models); omitted on Sonnet 5 /
    // Opus 4.7+ / Fable, which 400 on it. Mirrors the legacy runOneShot gate.
    ...(modelAcceptsTemperature(deps.modelLabel) ? { temperature: EXTRACTION_TEMPERATURE } : {}),
    maxOutputTokens: opts.maxOutputTokens,
  });

  const usage = result.usage;
  // Mirrors extract-with-tools-aisdk.ts: `inputTokens` is the FULL prompt count
  // (incl. cache read/write); the legacy Anthropic-SDK path logged the
  // non-cached portion (`input_tokens`), which is `noCacheTokens` here.
  const totalInput = usage.inputTokenDetails?.noCacheTokens ?? usage.inputTokens ?? 0;
  const totalOutput = usage.outputTokens ?? 0;
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const hitMaxTokens = result.finishReason === "length";

  if (hitMaxTokens) {
    deps.logger.warn(
      "AI extraction hit max_tokens — some entries may be lost; content hash will not be persisted so retry can run on the same body",
    );
  }

  const terminal = result.toolCalls.find((c) => c.toolName === "extract_releases");
  if (!terminal) {
    return {
      entries: [],
      totalInput,
      totalOutput,
      hitMaxTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  const input = terminal.input as { releases?: unknown };
  if (!Array.isArray(input?.releases)) {
    return {
      entries: [],
      totalInput,
      totalOutput,
      hitMaxTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  return {
    entries: input.releases as ExtractedEntry[],
    totalInput,
    totalOutput,
    hitMaxTokens,
    cacheReadTokens,
    cacheWriteTokens,
  };
}
