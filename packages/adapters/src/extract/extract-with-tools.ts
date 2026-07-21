import type Anthropic from "@anthropic-ai/sdk";
import type { UsageExtractionMode, UsageFallbackReason } from "@buildinternet/releases-core/schema";
import { buildPreview } from "./preview-builder.js";
import {
  extractReleasesToolFull,
  getSliceTool,
  queryJsonTool,
  withGuidance,
  TOOLLOOP_SYSTEM_PROMPT,
  MAX_ROUNDS,
  MAX_TOTAL_TOOL_CHARS,
  EXTRACTION_TEMPERATURE,
  modelAcceptsTemperature,
  type ExtractionGuidance,
} from "./shared.js";
import { handleGetSlice, handleQueryJson } from "./tool-handlers.js";
import { formatRejectionMessage, validateRecords } from "./record-validate.js";
import type { ExtractDeps, ExtractedEntry, ExtractLogger } from "./types.js";

/**
 * Per-run cap on in-band validation retry rounds (#1874). Without a cap, a
 * model stuck emitting the same bad record forever would burn the entire
 * MAX_ROUNDS budget on retries with no progress. One retry round is enough to
 * let the model self-correct; a second miss falls through to acceptance so
 * post-hoc validation (the existing backstop) handles it instead of stalling
 * the loop.
 */
const MAX_VALIDATION_RETRIES = 2;

/** Anthropic beta: compare consecutive Messages requests for prompt-cache divergence. */
const CACHE_DIAGNOSIS_BETA = "cache-diagnosis-2026-04-07" as const;

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

/**
 * Warn on actionable cache misses (`*_changed`). Non-actionable reasons
 * (`previous_message_not_found`, `unavailable`) omit `cache_missed_input_tokens`
 * and are ignored. Fail-open — never throws.
 */
function logCacheMiss(
  logger: ExtractLogger,
  diagnostics:
    | { cache_miss_reason: { type: string; cache_missed_input_tokens?: number } | null }
    | null
    | undefined,
  round: number,
): void {
  const reason = diagnostics?.cache_miss_reason;
  if (!reason || typeof reason.cache_missed_input_tokens !== "number") return;
  logger.warn(
    `cache diagnostics: type=${reason.type} missedTokens=${reason.cache_missed_input_tokens} round=${round}`,
  );
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
  /** Base system prompt only — do NOT pre-fold guidance in (pass it via `guidance`). */
  systemPrompt: string;
  /**
   * Per-source / per-org guidance. Emitted as a trailing system block AFTER the
   * cache breakpoint so the static base+TOOLLOOP prefix stays shareable across
   * sources; still delivered to the model. Omit when there's no guidance.
   */
  guidance?: ExtractionGuidance;
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

  // Static prompt first, breakpoint on it; volatile per-source/org guidance goes
  // in a trailing block AFTER the breakpoint — so the base+TOOLLOOP text (and the
  // tool schemas that render before it) stay byte-identical and cacheable across
  // sources, instead of guidance being wedged mid-prefix. Guidance still reaches
  // the model; it's just downstream of the cache read point.
  const systemBlocks: Anthropic.TextBlockParam[] = [
    {
      type: "text",
      text: `${opts.systemPrompt}\n\n${TOOLLOOP_SYSTEM_PROMPT}`,
      cache_control: { type: "ephemeral" },
    },
  ];
  const guidanceText = opts.guidance ? withGuidance("", opts.guidance) : "";
  if (guidanceText) {
    systemBlocks.push({ type: "text", text: guidanceText });
  }

  let totalInput = 0;
  let totalOutput = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let toolRounds = 0;
  let toolChars = 0;
  let validationRetries = 0;
  /** Prior response id for cache diagnostics; null on the first stream call. */
  let previousMessageId: string | null = null;
  let streamRound = 0;

  const makePartial = (): LoopPartialUsage => ({
    totalInput,
    totalOutput,
    cacheReadTokens,
    cacheWriteTokens,
    toolRounds,
    toolChars,
  });

  /** One beta Messages round: thread diagnostics id, accumulate usage, log misses. */
  async function runRound() {
    streamRound++;
    const stream = deps.anthropicClient.beta.messages.stream({
      model: deps.agentModel,
      max_tokens: 16_384,
      // Deterministic parse on models that still accept it; omitted on Sonnet 5 /
      // Opus 4.7+ / Fable, which 400 on a non-default temperature. See
      // EXTRACTION_TEMPERATURE / modelAcceptsTemperature.
      ...(modelAcceptsTemperature(deps.agentModel)
        ? // oxlint-disable-next-line no-deprecated -- gated to models that accept it; see note
          { temperature: EXTRACTION_TEMPERATURE }
        : {}),
      system: systemBlocks,
      tools,
      messages,
      diagnostics: { previous_message_id: previousMessageId },
      betas: [CACHE_DIAGNOSIS_BETA],
    });
    const response = await stream.finalMessage();
    previousMessageId = response.id;
    totalInput += response.usage.input_tokens;
    totalOutput += response.usage.output_tokens;
    cacheReadTokens += response.usage.cache_read_input_tokens ?? 0;
    cacheWriteTokens += response.usage.cache_creation_input_tokens ?? 0;
    logCacheMiss(deps.logger, response.diagnostics, streamRound);
    return response;
  }

  while (toolRounds < MAX_ROUNDS && toolChars < MAX_TOTAL_TOOL_CHARS) {
    // eslint-disable-next-line no-await-in-loop -- each round's response informs the next
    const response = await runRound();

    if (response.stop_reason === "max_tokens") {
      throw new LoopFallbackError("max_tokens", makePartial());
    }

    const toolUses = response.content.filter(
      (b): b is Anthropic.Messages.ToolUseBlock => b.type === "tool_use",
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

      const entries = input.releases as ExtractedEntry[];

      // In-band validation (#1874): give the model a chance to self-correct
      // before treating this as terminal. Bounded by MAX_VALIDATION_RETRIES so
      // a model that keeps re-submitting the same bad record can't consume the
      // whole round budget — after the retry cap, accept as-is and let the
      // existing post-hoc validation (the backstop) handle any stragglers.
      const rejections =
        validationRetries < MAX_VALIDATION_RETRIES
          ? validateRecords(entries, { sourceUrl: opts.sourceUrl })
          : [];

      if (rejections.length === 0) {
        return {
          entries,
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

      // Reject in-band: respond to the extract_releases tool_use with an
      // actionable message instead of ending the loop, so the model can
      // resubmit corrected entries on the next round. Every OTHER tool_use in
      // this same turn (there shouldn't normally be any alongside a terminal
      // call, but the API allows multiple blocks) still needs a tool_result.
      validationRetries++;
      messages.push({
        role: "assistant",
        content: response.content as Anthropic.ContentBlock[],
      });

      const toolResults: Anthropic.ToolResultBlockParam[] = toolUses.map((tu) => {
        if (tu.id === terminal.id) {
          let message = formatRejectionMessage(rejections, entries.length);
          // Same truncation pattern as the sibling tool-result branch below —
          // an oversized rejection message (e.g. many rejected entries with
          // long reasons) must not blow past MAX_TOTAL_TOOL_CHARS and force
          // an early exit before the model gets a chance to retry.
          const remaining = MAX_TOTAL_TOOL_CHARS - toolChars;
          if (message.length > remaining) {
            const suffix = "\n[truncated — tool-result budget exhausted]";
            message =
              remaining > suffix.length
                ? message.slice(0, remaining - suffix.length) + suffix
                : message.slice(0, Math.max(0, remaining));
          }
          toolChars += message.length;
          return { type: "tool_result", tool_use_id: tu.id, content: message };
        }
        return {
          type: "tool_result",
          tool_use_id: tu.id,
          content: "[skipped — extract_releases in this turn was rejected, see its result]",
        };
      });

      stripCacheControlFromPrior(messages);
      toolResults[toolResults.length - 1]!.cache_control = { type: "ephemeral" };
      messages.push({ role: "user", content: toolResults });
      toolRounds++;
      continue;
    }

    if (toolUses.length === 0) {
      throw new LoopFallbackError("no_terminal_call", makePartial());
    }

    // Append the assistant turn and the tool_result blocks.
    messages.push({
      role: "assistant",
      content: response.content as Anthropic.ContentBlock[],
    });

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

  const forceResp = await runRound();

  const forceTerminal = forceResp.content.find(
    (b): b is Anthropic.Messages.ToolUseBlock =>
      b.type === "tool_use" && b.name === "extract_releases",
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
