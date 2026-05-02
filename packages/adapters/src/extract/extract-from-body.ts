/**
 * The AI extraction step shared by the direct-fetch and Cloudflare-rendered
 * paths: hand a body (JSON/HTML/markdown) to Claude with a tool-use constraint,
 * and let it emit structured release entries. Applies a token-aware guardrail
 * for large bodies so the output budget doesn't get exhausted mid-response.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { countTokensSafe } from "@buildinternet/releases-core/tokens";
import type { UsageExtractionMode, UsageFallbackReason } from "@buildinternet/releases-core/schema";
import type { ExtractDeps, ExtractedEntry } from "./types.js";
import {
  extractReleasesToolFull,
  buildBodyGuardrail,
  withGuidance,
  LARGE_BODY_TOKEN_THRESHOLD,
  HUGE_BODY_TOKEN_THRESHOLD,
  DEFAULT_MAX_OUTPUT_TOKENS,
  HUGE_BODY_MAX_OUTPUT_TOKENS,
  MAX_BODY_CHARS_TOOLLOOP,
  type ExtractionGuidance,
} from "./shared.js";
import { extractWithTools, LoopFallbackError } from "./extract-with-tools.js";

export interface ExtractFromBodyOpts {
  body: string;
  systemPrompt: string;
  /** Will be appended with `\n\n${truncated body}` — no trailing newline needed. */
  userMessage: string;
  guidance?: ExtractionGuidance;
  sourceUrl: string;
  fetchUrl: string;
  useToolLoop?: boolean;
}

export interface ExtractFromBodyResult {
  entries: ExtractedEntry[];
  totalInput: number;
  totalOutput: number;
  /** True when the model stopped because output budget was exhausted — caller
   *  should NOT persist the content hash so a retry can run on the same body. */
  hitMaxTokens: boolean;
  mode: UsageExtractionMode;
  toolRounds: number | null;
  toolChars: number | null;
  fallbackReason: UsageFallbackReason | null;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const MAX_BODY_CHARS = 400_000;

async function runOneShot(
  opts: ExtractFromBodyOpts,
  deps: ExtractDeps,
  approxTokens: number,
): Promise<{
  entries: ExtractedEntry[];
  totalInput: number;
  totalOutput: number;
  hitMaxTokens: boolean;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}> {
  const { anthropicClient, agentModel, logger } = deps;

  const content =
    opts.body.length > MAX_BODY_CHARS
      ? opts.body.slice(0, MAX_BODY_CHARS) + "\n\n[Content truncated]"
      : opts.body;

  const isHuge = approxTokens >= HUGE_BODY_TOKEN_THRESHOLD;
  const isLarge = approxTokens >= LARGE_BODY_TOKEN_THRESHOLD;
  if (isLarge) {
    logger.info(
      `Body is ~${approxTokens.toLocaleString()} tokens — applying ${isHuge ? "huge" : "large"}-body guardrails`,
    );
  }

  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: withGuidance(opts.systemPrompt, opts.guidance),
      cache_control: { type: "ephemeral" },
    },
  ];
  if (isLarge) {
    systemBlocks.push({ type: "text", text: buildBodyGuardrail(approxTokens) });
  }

  const stream = anthropicClient.messages.stream({
    model: agentModel,
    max_tokens: isHuge ? HUGE_BODY_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS,
    system: systemBlocks,
    tools: [extractReleasesToolFull],
    tool_choice: { type: "tool", name: "extract_releases" },
    messages: [{ role: "user", content: `${opts.userMessage}\n\n${content}` }],
  });
  const response = await stream.finalMessage();

  const totalInput = response.usage.input_tokens;
  const totalOutput = response.usage.output_tokens;
  const cacheReadTokens = response.usage.cache_read_input_tokens ?? 0;
  const cacheWriteTokens = response.usage.cache_creation_input_tokens ?? 0;
  const hitMaxTokens = response.stop_reason === "max_tokens";

  if (hitMaxTokens) {
    logger.warn(
      "AI extraction hit max_tokens — some entries may be lost; content hash will not be persisted so retry can run on the same body",
    );
  }

  const toolBlock = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  if (!toolBlock) {
    return {
      entries: [],
      totalInput,
      totalOutput,
      hitMaxTokens,
      cacheReadTokens,
      cacheWriteTokens,
    };
  }

  const input = toolBlock.input as Record<string, unknown>;
  if (!input || !Array.isArray(input.releases)) {
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

export async function extractFromBody(
  opts: ExtractFromBodyOpts,
  deps: ExtractDeps,
): Promise<ExtractFromBodyResult> {
  const { logger } = deps;
  const approxTokens = countTokensSafe(opts.body);

  // Tool-loop tier. Uses `>=` to match runOneShot's large-body guardrail check.
  if ((opts.useToolLoop ?? false) && approxTokens >= LARGE_BODY_TOKEN_THRESHOLD) {
    const bodyForLoop =
      opts.body.length > MAX_BODY_CHARS_TOOLLOOP
        ? opts.body.slice(0, MAX_BODY_CHARS_TOOLLOOP) + "\n\n[Content truncated]"
        : opts.body;

    try {
      const result = await extractWithTools(
        {
          body: bodyForLoop,
          // Bake guidance into the system prompt so per-source parseInstructions
          // and the org playbook reach the tool-loop model. Without this the
          // tool-loop path silently dropped guidance that runOneShot applies,
          // letting sources like posthog-changelog (which rely on parseInstructions
          // to point at the right slice of a 700+ item flat array) return zero.
          systemPrompt: withGuidance(opts.systemPrompt, opts.guidance),
          userMessage: opts.userMessage,
          sourceUrl: opts.sourceUrl,
          fetchUrl: opts.fetchUrl,
          approxTokens,
        },
        deps,
      );
      return {
        entries: result.entries,
        totalInput: result.totalInput,
        totalOutput: result.totalOutput,
        hitMaxTokens: result.hitMaxTokens,
        mode: result.mode,
        toolRounds: result.toolRounds,
        toolChars: result.toolChars,
        fallbackReason: null,
        cacheReadTokens: result.cacheReadTokens,
        cacheWriteTokens: result.cacheWriteTokens,
      };
    } catch (err) {
      const isLoopErr = err instanceof LoopFallbackError;
      const reason: UsageFallbackReason = isLoopErr ? err.reason : "sdk_error";
      const partial = isLoopErr ? err.partial : undefined;
      logger.warn(
        `tool-loop extraction fell back to one-shot: reason=${reason} sourceUrl=${opts.sourceUrl}`,
      );
      const oneshot = await runOneShot(opts, deps, approxTokens);
      // Preserve partial loop usage in the fallback result so observability
      // reflects the *full* cost of a failed tool-loop + retry (not just the
      // retry). toolRounds / toolChars stay populated even on fallback so
      // rollups can separate "fallback after N rounds" from "fallback before
      // any rounds".
      return {
        entries: oneshot.entries,
        totalInput: (partial?.totalInput ?? 0) + oneshot.totalInput,
        totalOutput: (partial?.totalOutput ?? 0) + oneshot.totalOutput,
        hitMaxTokens: oneshot.hitMaxTokens,
        cacheReadTokens: (partial?.cacheReadTokens ?? 0) + oneshot.cacheReadTokens,
        cacheWriteTokens: (partial?.cacheWriteTokens ?? 0) + oneshot.cacheWriteTokens,
        mode: "fallback_to_oneshot",
        toolRounds: partial?.toolRounds ?? null,
        toolChars: partial?.toolChars ?? null,
        fallbackReason: reason,
      };
    }
  }

  // One-shot tier.
  const oneshot = await runOneShot(opts, deps, approxTokens);
  return {
    ...oneshot,
    mode: "oneshot",
    toolRounds: null,
    toolChars: null,
    fallbackReason: null,
  };
}
