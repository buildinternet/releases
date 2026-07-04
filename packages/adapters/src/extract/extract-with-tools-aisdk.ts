/**
 * The OpenRouter / Vercel-AI-SDK extraction path — a provider-agnostic port of
 * `extract-with-tools.ts` (the Anthropic-SDK large-body tool-loop). The worker
 * resolves an OpenRouter `LanguageModel` (DeepSeek) when the `openrouter-enabled`
 * flag is on + an `EXTRACT_MODEL` + key are configured, and routes the tool-loop
 * here instead of the Anthropic SDK loop; off, the Anthropic path is unchanged.
 *
 * Driving the loop through a provider-agnostic SDK makes DeepSeek-via-OpenRouter
 * a model swap, not a rewrite — WITHOUT losing the two things that make the lane
 * cheap and reliable on Anthropic today:
 *
 *   1. The STATIC system-prefix cache breakpoint (the ~50K-token base+TOOLLOOP
 *      prompt + tool schemas, shared byte-for-byte across sources).
 *   2. The SLIDING cache breakpoint on the most-recent tool_result each round
 *      (so the growing conversation re-reads cache instead of re-billing).
 *
 * Both are replicated here via `providerOptions.anthropic.cacheControl` + a
 * `prepareStep` hook that re-asserts the static breakpoint and rotates the
 * sliding one — the AI SDK owns the loop, but `prepareStep` lets us mutate the
 * exact message array sent each step, which is where the breakpoints live.
 *
 * The caller injects a ready `LanguageModel` (OpenRouter in prod;
 * `anthropicSpikeModel(...)` in the parity test). The loop contract
 * (opts/result/LoopFallbackError) is reused verbatim from the Anthropic
 * implementation so the switch is a call-site change, not a type change.
 */

import { createAnthropic } from "@ai-sdk/anthropic";
import {
  generateText,
  hasToolCall,
  isStepCount,
  jsonSchema,
  tool,
  type JSONSchema7,
  type LanguageModel,
  type ModelMessage,
  type ToolResultPart,
} from "ai";
import { buildPreview } from "./preview-builder.js";
import {
  EXTRACTION_TEMPERATURE,
  extractReleasesToolFull,
  getSliceTool,
  MAX_ROUNDS,
  MAX_TOTAL_TOOL_CHARS,
  queryJsonTool,
  TOOLLOOP_SYSTEM_PROMPT,
  withGuidance,
} from "./shared.js";
import { handleGetSlice, handleQueryJson } from "./tool-handlers.js";
import {
  LoopFallbackError,
  type ExtractWithToolsOpts,
  type ExtractWithToolsResult,
  type LoopPartialUsage,
} from "./extract-with-tools.js";
import type { ExtractedEntry, ExtractLogger } from "./types.js";

/** Deps: a ready AI-SDK model + a logger. The worker builds `model` via
 *  `buildOpenRouterExtractModel` (OpenRouter/DeepSeek) when the flag + key +
 *  `EXTRACT_MODEL` are configured; the parity test injects `anthropicSpikeModel`. */
export interface AiSdkExtractDeps {
  model: LanguageModel;
  logger: ExtractLogger;
}

const EPHEMERAL = { anthropic: { cacheControl: { type: "ephemeral" } } } as const;

/** Strip our ephemeral cacheControl from every tool-result part (the sliding
 *  breakpoint is re-placed on exactly one part per step; system stays cached). */
function clearSlidingBreakpoints(messages: ModelMessage[]): void {
  for (const msg of messages) {
    if (msg.role !== "tool" || !Array.isArray(msg.content)) continue;
    for (const part of msg.content as ToolResultPart[]) {
      if (part.providerOptions?.anthropic?.cacheControl) {
        delete (part.providerOptions as { anthropic?: unknown }).anthropic;
      }
    }
  }
}

/** Place the sliding breakpoint on the final part of the most-recent tool turn —
 *  the AI-SDK analogue of `applySlidingCacheBreakpoint` in shared.ts. */
function setSlidingBreakpoint(messages: ModelMessage[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role === "tool" && Array.isArray(msg.content) && msg.content.length > 0) {
      const last = msg.content[msg.content.length - 1] as ToolResultPart;
      last.providerOptions = { ...last.providerOptions, ...EPHEMERAL };
      return;
    }
  }
}

export async function extractWithToolsAiSdk(
  opts: ExtractWithToolsOpts,
  deps: AiSdkExtractDeps,
): Promise<ExtractWithToolsResult> {
  const preview = buildPreview({
    body: opts.body,
    sourceUrl: opts.sourceUrl,
    fetchUrl: opts.fetchUrl,
    approxTokens: opts.approxTokens,
  });

  // ── Budget tracking (mirrors the hand-rolled loop's MAX_TOTAL_TOOL_CHARS). ──
  let toolChars = 0;
  let toolRounds = 0;
  let handlerErr: string | null = null;
  // Real usage totals, filled from the SDK result once it's available. The
  // fallback partials (LoopPartialUsage) carry these so extractFromBody
  // attributes the loop's pre-fallback spend instead of undercounting to zero.
  // The handler-error path throws before any result, so it legitimately reports
  // zeros (the SDK emitted no usage).
  let usedInput = 0;
  let usedOutput = 0;
  let usedCacheRead = 0;
  let usedCacheWrite = 0;
  const makePartial = (): LoopPartialUsage => ({
    totalInput: usedInput,
    totalOutput: usedOutput,
    cacheReadTokens: usedCacheRead,
    cacheWriteTokens: usedCacheWrite,
    toolRounds,
    toolChars,
  });

  /** Apply the same truncation + budget-exhaustion marker the Anthropic loop uses. */
  function budgeted(text: string): string {
    const remaining = MAX_TOTAL_TOOL_CHARS - toolChars;
    if (remaining <= 0) return "[budget exhausted — call extract_releases on the next turn]";
    let out = text;
    if (out.length > remaining) {
      const suffix = "\n[truncated — tool-result budget exhausted]";
      out =
        remaining > suffix.length
          ? out.slice(0, remaining - suffix.length) + suffix
          : out.slice(0, remaining);
    }
    toolChars += out.length;
    return out;
  }

  // Run a slice/query handler as one tool round, applying the budget. A throw is
  // recorded in `handlerErr` and re-raised so the SDK aborts the loop — caught
  // below and mapped to the same LoopFallbackError the Anthropic loop raises.
  function runHandler(handle: () => string): string {
    toolRounds++;
    try {
      return budgeted(handle());
    } catch (err) {
      handlerErr = err instanceof Error ? err.message : String(err);
      throw err;
    }
  }

  // ── Tools. get_slice/query_json auto-execute (SDK continues the loop);
  //    extract_releases has NO execute → it's the terminal: the step ends and
  //    the call surfaces in `steps`, which `hasToolCall` also uses to stop. ──
  const tools = {
    get_slice: tool({
      description: getSliceTool.description!,
      inputSchema: jsonSchema<{ start: number; length: number }>(
        getSliceTool.input_schema as JSONSchema7,
      ),
      execute: async ({ start, length }) =>
        runHandler(() => handleGetSlice(opts.body, { start, length })),
    }),
    extract_releases: tool({
      description: extractReleasesToolFull.description!,
      inputSchema: jsonSchema<{ releases: ExtractedEntry[] }>(
        extractReleasesToolFull.input_schema as JSONSchema7,
      ),
    }),
    ...(preview.queryJsonAvailable
      ? {
          query_json: tool({
            description: queryJsonTool.description!,
            inputSchema: jsonSchema<{ path: string }>(queryJsonTool.input_schema as JSONSchema7),
            execute: async ({ path }) => runHandler(() => handleQueryJson(opts.body, { path })),
          }),
        }
      : {}),
  };

  // ── Messages. Static prefix carries the cache breakpoint; volatile per-source
  //    guidance goes in a SEPARATE, uncached system message so the cacheable
  //    prefix stays byte-identical across sources (same split as the SDK-free
  //    implementation's systemBlocks). ──
  const staticSystem = `${opts.systemPrompt}\n\n${TOOLLOOP_SYSTEM_PROMPT}`;
  const guidanceText = opts.guidance ? withGuidance("", opts.guidance) : "";
  // Instructions go in the dedicated `instructions` param (not messages) — avoids
  // the SDK's prompt-injection warning and keeps the cacheable prefix out of the
  // per-step message rewrite. The static block carries the breakpoint; volatile
  // guidance is a second, uncached system message so the prefix stays shareable.
  const instructions: ModelMessage[] = [
    { role: "system", content: staticSystem, providerOptions: EPHEMERAL },
    ...(guidanceText ? [{ role: "system", content: guidanceText } as ModelMessage] : []),
  ];
  const baseMessages: ModelMessage[] = [
    { role: "user", content: `${opts.userMessage}\n\n${preview.message}` },
  ];

  // Thunk so the result type is inferred from the concrete tool set (a bare
  // `Awaited<ReturnType<typeof generateText>>` annotation collapses to the
  // generic `ToolSet` and won't accept the typed call's return).
  const run = () =>
    generateText({
      model: deps.model,
      instructions: instructions as Parameters<typeof generateText>[0]["instructions"],
      messages: baseMessages,
      tools,
      temperature: EXTRACTION_TEMPERATURE,
      maxOutputTokens: 16_384,
      // Stop on the terminal tool call OR when the round budget is spent. The
      // +1 leaves room for the "force extract_releases now" final turn the
      // hand-rolled loop allows after exhausting rounds.
      stopWhen: [hasToolCall("extract_releases"), isStepCount(MAX_ROUNDS + 1)],
      prepareStep: ({ messages, stepNumber }) => {
        // System (with its static breakpoint) is the separate `system` param and
        // is constant across steps; here we only rotate the sliding breakpoint
        // onto the most-recent tool turn (clearing any prior placement).
        clearSlidingBreakpoints(messages);
        setSlidingBreakpoint(messages);
        // On the final allowed step, FORCE the terminal — the AI-SDK analogue of
        // the hand-rolled loop's "you've used max rounds, call extract_releases
        // now" turn. Without this, reasoning-first models (DeepSeek) loop to
        // max_rounds without ever committing the terminal call.
        if (stepNumber >= MAX_ROUNDS) {
          return { messages, toolChoice: { type: "tool", toolName: "extract_releases" } };
        }
        return { messages };
      },
    });

  let result: Awaited<ReturnType<typeof run>>;
  try {
    result = await run();
  } catch (err) {
    // A tool handler threw (malformed JSONPath, etc.) — same disposition as the
    // Anthropic loop: abort to the one-shot fallback rather than commit empty.
    if (handlerErr) {
      deps.logger.warn(`aisdk tool handler failed: ${handlerErr} — falling back to one-shot`);
      throw new LoopFallbackError("tool_error", makePartial());
    }
    throw err;
  }

  // ── Usage. v7 `usage` is cumulative across all steps (sum of step usages).
  //    Cache read/write live in inputTokenDetails; reasoning in outputTokenDetails. ──
  const usage = result.usage;
  // `inputTokens` is the FULL prompt count (incl. cache read + write); the
  // hand-rolled loop logged the non-cached portion (Anthropic `input_tokens`),
  // which is `inputTokenDetails.noCacheTokens` here. Keep that semantics.
  const totalInput = usage.inputTokenDetails?.noCacheTokens ?? usage.inputTokens ?? 0;
  const totalOutput = usage.outputTokens ?? 0;
  // reasoningTokens lives in outputTokenDetails — directly useful for the
  // DeepSeek lane, where reasoning bills as output (see #1536).
  const cacheReadTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  // Mirror the real totals into the fallback-partial accumulators so any
  // post-result LoopFallbackError below attributes the spend it already incurred.
  usedInput = totalInput;
  usedOutput = totalOutput;
  usedCacheRead = cacheReadTokens;
  usedCacheWrite = cacheWriteTokens;

  // ── Terminal: find the extract_releases call across all steps. ──
  const terminal = result.steps
    .flatMap((s) => s.toolCalls)
    .find((c) => c?.toolName === "extract_releases");

  if (terminal) {
    const input = terminal.input as { releases?: unknown };
    if (!Array.isArray(input?.releases)) {
      deps.logger.warn(
        `aisdk extract_releases terminal had malformed input (releases not an array) — falling back to one-shot`,
      );
      throw new LoopFallbackError("tool_error", makePartial());
    }
    return {
      entries: input.releases as ExtractedEntry[],
      totalInput,
      totalOutput,
      cacheReadTokens,
      cacheWriteTokens,
      toolRounds,
      toolChars,
      mode: preview.mode,
      hitMaxTokens: result.finishReason === "length",
    };
  }

  // No terminal — map the stop reason onto the existing fallback taxonomy.
  if (result.finishReason === "length") {
    throw new LoopFallbackError("max_tokens", makePartial());
  }
  if (result.steps.length >= MAX_ROUNDS + 1) {
    throw new LoopFallbackError("max_rounds", makePartial());
  }
  throw new LoopFallbackError("no_terminal_call", makePartial());
}

/** Test-only: build an Anthropic AI-SDK model that captures wire requests via an
 *  injected `fetch` (used by the parity test). The production sibling is
 *  `buildOpenRouterExtractModel` — both return the same `LanguageModel`. */
export function anthropicSpikeModel(opts: {
  apiKey: string;
  model: string;
  fetch?: typeof globalThis.fetch;
}): LanguageModel {
  return createAnthropic({ apiKey: opts.apiKey, fetch: opts.fetch })(opts.model);
}
