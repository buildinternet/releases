/**
 * The AI extraction step shared by the direct-fetch and Cloudflare-rendered
 * paths: hand a body (JSON/HTML/markdown) to Claude with a tool-use constraint,
 * and let it emit structured release entries. Applies a token-aware guardrail
 * for large bodies so the output budget doesn't get exhausted mid-response.
 */

import type Anthropic from "@anthropic-ai/sdk";
import type { LanguageModel } from "ai";
import { countTokensSafe } from "@buildinternet/releases-core/tokens";
import type { UsageExtractionMode, UsageFallbackReason } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { classifyProviderQuota } from "@releases/lib/provider-quota";
import type { ExtractDeps, ExtractedEntry } from "./types.js";
import {
  extractReleasesToolFull,
  extractReleasesToolCrawl,
  buildBodyGuardrail,
  withGuidance,
  LARGE_BODY_TOKEN_THRESHOLD,
  HUGE_BODY_TOKEN_THRESHOLD,
  DEFAULT_MAX_OUTPUT_TOKENS,
  HUGE_BODY_MAX_OUTPUT_TOKENS,
  MAX_BODY_CHARS_TOOLLOOP,
  EXTRACTION_TEMPERATURE,
  modelAcceptsTemperature,
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
  /**
   * Select the body-preserving `extract_releases` tool schema
   * (`extractReleasesToolCrawl`) instead of the default summarizing one. Set by
   * crawl-target callers whose system prompt demands verbatim per-post bodies,
   * so the tool's `content` description doesn't contradict the prompt. Applies
   * to the one-shot tier (the only tier crawl-target ingest uses). See #1343.
   */
  preserveBody?: boolean;
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
  /** The model that actually produced these entries — `oneShotModel` for the
   *  single-call path, `agentModel` for the tool-loop. Callers log this to
   *  `usage_log` so cost attribution reflects the real model, not a default. */
  modelUsed: string;
}

const MAX_BODY_CHARS = 400_000;

interface OneShotResult {
  entries: ExtractedEntry[];
  totalInput: number;
  totalOutput: number;
  hitMaxTokens: boolean;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  modelUsed: string;
}

async function runOneShot(
  opts: ExtractFromBodyOpts,
  deps: ExtractDeps,
  approxTokens: number,
): Promise<OneShotResult> {
  const { agentModel, logger } = deps;

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
  const maxOutputTokens = isHuge ? HUGE_BODY_MAX_OUTPUT_TOKENS : DEFAULT_MAX_OUTPUT_TOKENS;
  const staticSystem = withGuidance(opts.systemPrompt, opts.guidance);
  const guardrail = isLarge ? buildBodyGuardrail(approxTokens) : undefined;

  // AI-SDK lane (issue #2166): when the caller resolved an OpenRouter/Anthropic
  // AI-SDK model for the one-shot tier (`resolveToolLoopAiSdkModel` with the
  // Haiku-class fallback — see extract-deps-worker.ts), route through it
  // instead of calling `anthropicClient` directly. This is what lets
  // `EXTRACT_MODEL` govern the one-shot tier — the tier that handles the large
  // majority of extractions — not just the large-body tool-loop. Falls open to
  // the legacy direct-SDK call below when unset, which only happens when NO
  // Anthropic key resolved at all (resolveToolLoopAiSdkModel itself already
  // falls open OpenRouter → Anthropic before returning `undefined`).
  if (deps.oneShotAiSdkModel) {
    const label = deps.oneShotAiSdkModelLabel ?? deps.oneShotModel ?? agentModel;
    const provider = deps.oneShotAiSdkProvider ?? "anthropic";
    try {
      const { runOneShotAiSdk } = await import("./extract-oneshot-aisdk.js");
      const result = await runOneShotAiSdk(
        {
          body: content,
          systemPrompt: staticSystem,
          guardrail,
          userMessage: opts.userMessage,
          maxOutputTokens,
          preserveBody: opts.preserveBody,
        },
        { model: deps.oneShotAiSdkModel as LanguageModel, modelLabel: label, logger },
      );
      // Mirrors the other lanes' `ai_usage` event (workers/api/src/lib/text-model.ts's
      // `withLaneUsageLogging` and `overviewUsageSink`) so Axiom shows the one-shot
      // tier's routing — previously invisible since extract only logged to the
      // `usage_log` D1 table.
      //
      // `promptTokens` / `cacheHitRate` replicate `cacheMetrics` in
      // packages/ai/src/text-model.ts rather than importing it: packages/adapters
      // deliberately does not depend on @releases/ai-internal (see the note in
      // playbook-block.ts, which mirrors rather than imports for the same reason).
      // They are NOT decoration — raw `input` is not comparable across providers,
      // because OpenRouter's prompt count already includes the cached portion while
      // Anthropic's excludes it. Since the whole point of this lane's telemetry is
      // to compare Anthropic against OpenRouter routing, logging only raw `input`
      // would make exactly the comparison it exists for come out wrong.
      const promptTokens =
        provider === "openrouter"
          ? result.totalInput
          : result.totalInput + result.cacheReadTokens + result.cacheWriteTokens;
      logEvent("info", {
        component: "ai",
        event: "ai_usage",
        lane: "extract-oneshot",
        provider,
        model: label,
        input: result.totalInput,
        output: result.totalOutput,
        cacheCreate: result.cacheWriteTokens,
        cacheRead: result.cacheReadTokens,
        promptTokens,
        cacheHitRate:
          promptTokens > 0 ? Math.min(1, Math.max(0, result.cacheReadTokens / promptTokens)) : 0,
      });
      return { ...result, modelUsed: label };
    } catch (err) {
      // Degrade to the legacy direct-Anthropic call below rather than failing the
      // extraction. Without this, moving the one-shot tier onto OpenRouter would
      // TRADE one single-provider dependency for another: before #2166 this tier
      // always reached Anthropic, so an OpenRouter outage would now break the tier
      // that handles the large majority of extractions. `resolveToolLoopAiSdkModel`
      // only fails open at config-resolution time (missing key/model) — it cannot
      // help once the call itself is in flight.
      //
      // This also repairs the tool-loop's fallback: its catch retries via
      // runOneShot, which now routes to the AI SDK, so an OpenRouter outage would
      // otherwise have sent the "fallback" straight back to the provider that just
      // failed. Now that retry reaches Anthropic as intended.
      //
      // Loud, not silent: a quietly-degrading lane is precisely what hid the
      // three weeks of unintended Anthropic spend behind #2171.
      logEvent("warn", {
        component: "ai",
        event: "extract-oneshot-aisdk-failed",
        lane: "extract-oneshot",
        provider,
        model: label,
        fallback: "anthropic-direct",
        err: err instanceof Error ? err : String(err),
      });
    }
  }

  // Legacy path: direct Anthropic SDK call. Single forced-tool-call extraction
  // — Haiku-class is reliable and ~⅓ the cost here. Falls back to agentModel
  // when oneShotModel is unset.
  const model = deps.oneShotModel ?? agentModel;

  const systemBlocks: Anthropic.TextBlockParam[] = [
    { type: "text", text: staticSystem, cache_control: { type: "ephemeral" } },
  ];
  if (guardrail) {
    systemBlocks.push({ type: "text", text: guardrail });
  }

  // Both tools are named `extract_releases`, so tool_choice + response parsing
  // are identical; the crawl variant only swaps the `content` field to demand a
  // verbatim body, matching a body-preserving system prompt.
  const toolDef = opts.preserveBody ? extractReleasesToolCrawl : extractReleasesToolFull;
  const stream = deps.anthropicClient.messages.stream({
    model,
    max_tokens: maxOutputTokens,
    // Deterministic parse on models that still accept it (Haiku one-shot,
    // Sonnet 4.6); omitted on Sonnet 5 / Opus 4.7+ / Fable, which 400 on a
    // non-default temperature. See EXTRACTION_TEMPERATURE / modelAcceptsTemperature.
    ...(modelAcceptsTemperature(model)
      ? // oxlint-disable-next-line no-deprecated -- gated to models that accept it; see note
        { temperature: EXTRACTION_TEMPERATURE }
      : {}),
    system: systemBlocks,
    tools: [toolDef],
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
  const input = toolBlock?.input as Record<string, unknown> | undefined;
  const entries =
    input && Array.isArray(input.releases) ? (input.releases as ExtractedEntry[]) : [];

  return {
    entries,
    totalInput,
    totalOutput,
    hitMaxTokens,
    cacheReadTokens,
    cacheWriteTokens,
    modelUsed: model,
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

    // Pass the base prompt and guidance SEPARATELY so the loop can emit
    // per-source parseInstructions + the org playbook in a trailing system block,
    // after the cache breakpoint — keeping the static prefix shareable across
    // sources while still delivering guidance to the model. (Folding it into
    // systemPrompt here previously wedged it mid-prefix.) Sources like
    // posthog-changelog, which rely on parseInstructions to point at the right
    // slice of a 700+ item flat array, still get it.
    const loopOpts = {
      body: bodyForLoop,
      systemPrompt: opts.systemPrompt,
      guidance: opts.guidance,
      userMessage: opts.userMessage,
      sourceUrl: opts.sourceUrl,
      fetchUrl: opts.fetchUrl,
      approxTokens,
    };

    try {
      let result;
      if (deps.aiSdkModel) {
        // OpenRouter/AI-SDK lane (flag on + EXTRACT_MODEL + key resolved). Dynamic
        // import keeps `ai` out of the static graph for Anthropic-only callers.
        const { extractWithToolsAiSdk } = await import("./extract-with-tools-aisdk.js");
        result = await extractWithToolsAiSdk(loopOpts, {
          model: deps.aiSdkModel as Parameters<typeof extractWithToolsAiSdk>[1]["model"],
          logger: deps.logger,
        });
      } else {
        result = await extractWithTools(loopOpts, deps);
      }
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
        // Tool-loop runs on the agentic (Sonnet-class) model on the Anthropic
        // path; the AI-SDK lane reports its own `EXTRACT_MODEL` label when set.
        modelUsed: deps.aiSdkModel ? (deps.aiSdkModelLabel ?? deps.agentModel) : deps.agentModel,
      };
    } catch (err) {
      const isLoopErr = err instanceof LoopFallbackError;
      const reason: UsageFallbackReason = isLoopErr ? err.reason : "sdk_error";
      const partial = isLoopErr ? err.partial : undefined;
      // A provider quota/billing shutoff never gets wrapped in LoopFallbackError
      // — neither tool-loop implementation classifies errors, they just let the
      // raw SDK error propagate (reason="sdk_error"). Without this it reads as
      // an ordinary "fell back to one-shot" below and is invisible to an
      // operator — the same blind spot #2168 found in the Firecrawl path.
      // Fail-open is unchanged: this only adds a log, the one-shot retry below
      // still runs exactly as before.
      if (!isLoopErr) {
        const quota = classifyProviderQuota(err);
        if (quota) {
          logEvent("error", {
            component: "extract-tool-loop",
            event: "provider-quota-exhausted",
            lane: "extract-toolloop",
            provider: quota.provider,
            regainAccessAt: quota.regainAccessAt?.toISOString() ?? null,
            providerMessage: quota.message,
            sourceUrl: opts.sourceUrl,
          });
        }
      }
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
        // Entries came from the one-shot retry; report its model. Token totals
        // above still fold in the partial tool-loop spend (a Sonnet/Haiku mix),
        // but the `mode` flags this as a fallback so rollups can read it as such.
        modelUsed: oneshot.modelUsed,
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
