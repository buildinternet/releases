import type Anthropic from "@anthropic-ai/sdk";
import type { UsageExtractionMode, UsageFallbackReason } from "@buildinternet/releases-core/schema";
import { buildPreview } from "./preview-builder.js";
import {
  extractReleasesToolFull,
  getSliceTool,
  queryJsonTool,
  TOOLLOOP_SYSTEM_PROMPT,
  MAX_ROUNDS,
  MAX_TOTAL_TOOL_CHARS,
  EXTRACTION_TEMPERATURE,
} from "./shared.js";
import { handleGetSlice, handleQueryJson } from "./tool-handlers.js";
import type { ExtractDeps, ExtractedEntry } from "./types.js";

function stripCacheControlFromPrior(msgs: Anthropic.MessageParam[]): void {
  for (const msg of msgs) {
    if (typeof msg.content === "string") continue;
    for (const block of msg.content) {
      if ("cache_control" in block) {
        delete (block as { cache_control?: unknown }).cache_control;
      }
    }
  }
}

export interface LoopPartialUsage {
  totalInput: number;
  totalOutput: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolRounds: number;
  toolChars: number;
}

export class LoopFallbackError extends Error {
  constructor(
    public readonly reason: UsageFallbackReason,
    public readonly partial?: LoopPartialUsage,
  ) {
    super(`loop fallback: ${reason}`);
    this.name = "LoopFallbackError";
  }
}

export interface ExtractWithToolsOpts {
  body: string;
  systemPrompt: string;
  userMessage: string;
  sourceUrl: string;
  fetchUrl: string;
  approxTokens?: number;
}

export interface ExtractWithToolsResult {
  entries: ExtractedEntry[];
  totalInput: number;
  totalOutput: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  toolRounds: number;
  toolChars: number;
  mode: UsageExtractionMode;
  hitMaxTokens: boolean;
  fallbackReason?: UsageFallbackReason;
}

export async function extractWithTools(
  opts: ExtractWithToolsOpts,
  deps: ExtractDeps,
): Promise<ExtractWithToolsResult> {
  const preview = buildPreview({
    body: opts.body,
    sourceUrl: opts.sourceUrl,
    fetchUrl: opts.fetchUrl,
    approxTokens: opts.approxTokens,
  });

  const tools: Anthropic.Tool[] = [extractReleasesToolFull, getSliceTool];
  if (preview.queryJsonAvailable) tools.push(queryJsonTool);

  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `${opts.userMessage}\n\n${preview.message}` },
  ];

  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: `${opts.systemPrompt}\n\n${TOOLLOOP_SYSTEM_PROMPT}`,
      cache_control: { type: "ephemeral" },
    },
  ];

  let totalInput = 0;
  let totalOutput = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let toolRounds = 0;
  let toolChars = 0;

  const makePartial = (): LoopPartialUsage => ({
    totalInput,
    totalOutput,
    cacheReadTokens,
    cacheWriteTokens,
    toolRounds,
    toolChars,
  });

  while (toolRounds < MAX_ROUNDS && toolChars < MAX_TOTAL_TOOL_CHARS) {
    const stream = deps.anthropicClient.messages.stream({
      model: deps.agentModel,
      max_tokens: 16_384,
      // Deterministic parse — see EXTRACTION_TEMPERATURE (why 0; why short-lived).
      // oxlint-disable-next-line no-deprecated -- supported on current extract models; see note
      temperature: EXTRACTION_TEMPERATURE,
      system: systemBlocks,
      tools,
      messages,
    });
    // eslint-disable-next-line no-await-in-loop -- each round's response informs the next
    const response = await stream.finalMessage();

    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;
    cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;

    if (response.stop_reason === "max_tokens") {
      throw new LoopFallbackError("max_tokens", makePartial());
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    const terminal = toolUses.find((t) => t.name === "extract_releases");
    if (terminal) {
      const input = terminal.input as { releases?: unknown };
      if (!Array.isArray(input?.releases)) {
        // Malformed terminal is a contract failure, not "no releases found" —
        // returning empty here would commit the content hash and block retries.
        // Throw so extract-from-body.ts can run the one-shot fallback.
        deps.logger.warn(
          `extract_releases terminal call had malformed input (releases not an array) — falling back to one-shot`,
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
        hitMaxTokens: false,
      };
    }

    if (toolUses.length === 0) {
      throw new LoopFallbackError("no_terminal_call", makePartial());
    }

    // Append the assistant turn and the tool_result blocks.
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      // Anthropic requires a tool_result for every tool_use in the prior assistant
      // turn, so even when the budget is exhausted we still push a (short) marker
      // result — skipping it would make the next request invalid.
      const remaining = MAX_TOTAL_TOOL_CHARS - toolChars;
      if (remaining <= 0) {
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: "[budget exhausted — call extract_releases on the next turn]",
        });
        continue;
      }

      let resultText: string;
      try {
        if (tu.name === "get_slice") {
          resultText = handleGetSlice(opts.body, tu.input as { start: number; length: number });
        } else if (tu.name === "query_json") {
          resultText = handleQueryJson(opts.body, tu.input as { path: string });
        } else {
          throw new Error(`unknown tool: ${tu.name}`);
        }
      } catch (err) {
        deps.logger.warn(
          `tool handler failed: tool=${tu.name} err=${err instanceof Error ? err.message : String(err)}`,
        );
        throw new LoopFallbackError("tool_error", makePartial());
      }

      if (resultText.length > remaining) {
        const suffix = "\n[truncated — tool-result budget exhausted]";
        // Reserve room for the suffix inside `remaining` so toolChars doesn't
        // overshoot MAX_TOTAL_TOOL_CHARS on truncation. If remaining is so
        // small that suffix alone would exceed it, skip the suffix entirely.
        resultText =
          remaining > suffix.length
            ? resultText.slice(0, remaining - suffix.length) + suffix
            : resultText.slice(0, remaining);
      }
      toolChars += resultText.length;
      toolResults.push({ type: "tool_result", tool_use_id: tu.id, content: resultText });
    }

    stripCacheControlFromPrior(messages);
    if (toolResults.length > 0) {
      toolResults[toolResults.length - 1]!.cache_control = { type: "ephemeral" };
    }
    messages.push({ role: "user", content: toolResults });
    toolRounds++;
  }

  // Budget exhausted. Push a blunt instruction and allow ONE more round.
  messages.push({
    role: "user",
    content:
      "You have used the maximum number of tool rounds. Do not call get_slice or query_json again. " +
      "Call extract_releases now with all the entries you have found.",
  });

  const forceStream = deps.anthropicClient.messages.stream({
    model: deps.agentModel,
    max_tokens: 16_384,
    // Deterministic parse — see EXTRACTION_TEMPERATURE (why 0; why short-lived).
    // oxlint-disable-next-line no-deprecated -- supported on current extract models; see note
    temperature: EXTRACTION_TEMPERATURE,
    system: systemBlocks,
    tools,
    messages,
  });
  const forceResp = await forceStream.finalMessage();
  totalInput += forceResp.usage.input_tokens;
  totalOutput += forceResp.usage.output_tokens;
  cacheReadTokens += forceResp.usage.cache_read_input_tokens ?? 0;
  cacheWriteTokens += forceResp.usage.cache_creation_input_tokens ?? 0;

  const forceTerminal = forceResp.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use" && b.name === "extract_releases",
  );
  if (forceTerminal) {
    const input = forceTerminal.input as { releases?: unknown };
    if (!Array.isArray(input?.releases)) {
      // Same reasoning as the main-loop terminal: a malformed force-emit is a
      // contract failure, so fall back to one-shot rather than silently returning
      // empty entries and committing the content hash.
      deps.logger.warn(
        `force-emit extract_releases had malformed input (releases not an array) — falling back to one-shot`,
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
      hitMaxTokens: forceResp.stop_reason === "max_tokens",
    };
  }

  // No terminal on force-emit. If the model ran out of output tokens, surface
  // that as the specific reason — otherwise attribute it to round-budget.
  if (forceResp.stop_reason === "max_tokens") {
    throw new LoopFallbackError("max_tokens", makePartial());
  }
  throw new LoopFallbackError("max_rounds", makePartial());
}
