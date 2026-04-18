/**
 * The AI extraction step shared by the direct-fetch and Cloudflare-rendered
 * paths: hand a body (JSON/HTML/markdown) to Claude with a tool-use constraint,
 * and let it emit structured release entries. Applies a token-aware guardrail
 * for large bodies so the output budget doesn't get exhausted mid-response.
 */

import type Anthropic from "@anthropic-ai/sdk";
import { countTokensSafe } from "@releases/core/tokens";
import type { ExtractDeps, ExtractedEntry } from "./types.js";
import {
  extractReleasesToolFull,
  buildBodyGuardrail,
  withGuidance,
  LARGE_BODY_TOKEN_THRESHOLD,
  HUGE_BODY_TOKEN_THRESHOLD,
  DEFAULT_MAX_OUTPUT_TOKENS,
  HUGE_BODY_MAX_OUTPUT_TOKENS,
  type ExtractionGuidance,
} from "./shared.js";

export interface ExtractFromBodyOpts {
  body: string;
  systemPrompt: string;
  /** Will be appended with `\n\n${truncated body}` — no trailing newline needed. */
  userMessage: string;
  guidance?: ExtractionGuidance;
}

export interface ExtractFromBodyResult {
  entries: ExtractedEntry[];
  totalInput: number;
  totalOutput: number;
  /** True when the model stopped because output budget was exhausted — caller
   *  should NOT persist the content hash so a retry can run on the same body. */
  hitMaxTokens: boolean;
}

const MAX_BODY_CHARS = 400_000;

export async function extractFromBody(
  opts: ExtractFromBodyOpts,
  deps: ExtractDeps,
): Promise<ExtractFromBodyResult> {
  const { anthropicClient, agentModel, logger } = deps;

  const content = opts.body.length > MAX_BODY_CHARS
    ? opts.body.slice(0, MAX_BODY_CHARS) + "\n\n[Content truncated]"
    : opts.body;

  const approxTokens = countTokensSafe(content);
  const isHuge = approxTokens >= HUGE_BODY_TOKEN_THRESHOLD;
  const isLarge = approxTokens >= LARGE_BODY_TOKEN_THRESHOLD;
  if (isLarge) {
    logger.info(`Body is ~${approxTokens.toLocaleString()} tokens — applying ${isHuge ? "huge" : "large"}-body guardrails`);
  }

  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: withGuidance(opts.systemPrompt, opts.guidance),
      cache_control: { type: "ephemeral" },
    },
  ];
  if (isLarge) {
    // Uncached: body size is per-fetch, doesn't benefit from caching.
    systemBlocks.push({ type: "text", text: buildBodyGuardrail(approxTokens) });
  }

  const response = await anthropicClient.messages.create({
    model: agentModel,
    max_tokens: isHuge ? HUGE_BODY_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS,
    system: systemBlocks,
    tools: [extractReleasesToolFull],
    tool_choice: { type: "tool", name: "extract_releases" },
    messages: [
      { role: "user", content: `${opts.userMessage}\n\n${content}` },
    ],
  });

  const totalInput = response.usage.input_tokens;
  const totalOutput = response.usage.output_tokens;
  const hitMaxTokens = response.stop_reason === "max_tokens";

  if (hitMaxTokens) {
    logger.warn("AI extraction hit max_tokens — some entries may be lost; content hash will not be persisted so retry can run on the same body");
  }

  const toolBlock = response.content.find((b) => b.type === "tool_use");
  if (!toolBlock || toolBlock.type !== "tool_use") {
    return { entries: [], totalInput, totalOutput, hitMaxTokens };
  }

  const input = toolBlock.input as Record<string, unknown>;
  if (!input || !Array.isArray(input.releases)) {
    return { entries: [], totalInput, totalOutput, hitMaxTokens };
  }

  return { entries: input.releases as ExtractedEntry[], totalInput, totalOutput, hitMaxTokens };
}
