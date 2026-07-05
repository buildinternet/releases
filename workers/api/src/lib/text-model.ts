/**
 * Pick the `TextModel` for the secondary cheap-call AI lanes (marketing
 * classifier and live release summarizer) at call time.
 *
 * A single `openrouter-enabled` Flagship switch governs all these lanes. When it
 * is ON *and* an `OPENROUTER_API_KEY` + that lane's model id are configured, route
 * to OpenRouter (called directly — not fronted by the CF AI Gateway; see
 * docs/architecture/ai-gateway.md); otherwise fall back to the lane's Anthropic
 * Haiku model through the existing gateway path. Per-lane control is the model
 * var: an empty model id keeps that lane on Anthropic regardless. Returns `null`
 * only when no provider is usable (no Anthropic key) so the caller can fail open
 * by skipping.
 *
 * Fail-open is layered: a missing/empty OpenRouter secret or model var quietly
 * falls through to Anthropic here; a runtime OpenRouter throw is caught by the
 * caller's per-item try/catch (poll-fetch), which inserts the item visibly.
 */
import {
  anthropicTextModel,
  openRouterTextModel,
  withUsageLogging,
  type TextModel,
  type TextModelUsage,
} from "@releases/ai-internal/text-model";
import type { OverviewCallUsage } from "@releases/ai-internal/overview-content";
import {
  buildOverviewOpenRouterModel,
  buildOverviewAnthropicModel,
} from "@releases/adapters/overview-model";
import type { LanguageModel } from "ai";
import type {
  OpenRouterProviderPrefs,
  OpenRouterReasoning,
} from "@releases/ai-internal/openrouter-client";
import { MODEL as ANTHROPIC_MARKETING_MODEL } from "@releases/ai-internal/marketing-classifier";
import { MODEL as ANTHROPIC_SUMMARIZE_MODEL } from "@releases/ai-internal/release-content";
import { MODEL as ANTHROPIC_ARTICLE_MODEL } from "@releases/ai-internal/article-extract";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { estimateCost } from "@releases/lib/anthropic-pricing";
import { getSecret, type SecretBinding } from "@releases/lib/secrets";
import { getAnthropicKey, resolveGatewayOpts, type AnthropicEnv } from "./anthropic.js";

export interface TextModelEnv extends AnthropicEnv {
  /** "production" | "staging" — tags OpenRouter Broadcast traces by environment. */
  ENVIRONMENT?: string;
  FLAGS?: FlagshipBinding;
  OPENROUTER_API_KEY?: SecretBinding;
  OPENROUTER_BASE_URL?: string;
  MARKETING_CLASSIFIER_MODEL?: string;
  /** OpenRouter model for the summarization lanes (release summaries AND collection
   *  daily summaries — both are "summarize this content cheaply"); empty → stay on
   *  Anthropic Haiku. Read by `resolveSummarizeModel` + `resolveCollectionSummaryModel`. */
  SUMMARIZE_MODEL?: string;
  /** OpenRouter model for the feed-enrichment single-article extractor; empty →
   *  the lane stays on Anthropic Haiku. Read by `resolveArticleExtractModel`. */
  FEED_ENRICH_MODEL?: string;
  /** OpenRouter model for the large-body extraction tool-loop (issue #1536); empty
   *  → extraction stays on Anthropic. Read by `resolveExtractAiSdkModel`, not here. */
  EXTRACT_MODEL?: string;
  /** Single switch for the secondary AI lanes. Flagship-driven; var optional. */
  OPENROUTER_ENABLED?: string;
}

/**
 * Single, stable OpenRouter app name across every lane. App *identity* (rankings,
 * the app page) is keyed on `HTTP-Referer`, and the title is display-only — so a
 * lane-varying title would just flap the app's shown name without segmenting
 * anything. Per-lane breakdown lives in the Broadcast `generation_name` tag.
 */
const APP_TITLE = "Releases";

/**
 * Reasoning control for the summarize lanes (release + collection daily). These
 * lanes cap output at a few hundred tokens, so a reasoning model would spend the
 * whole budget thinking and return empty content (#1633). Disable reasoning
 * unconditionally — inert on non-reasoning models like gemini-flash-lite, correct
 * on DeepSeek V4. Only applies on the OpenRouter path; the Anthropic Haiku
 * fallback is non-reasoning and ignores it.
 */
const SUMMARIZE_REASONING: OpenRouterReasoning = { enabled: false };

/**
 * Provider-routing preference for the summarize lanes: never route to GMICloud,
 * whose latency for DeepSeek is an outlier vs. other providers (#1633). This
 * composes with (does not replace) any account-level "Ignored Providers" set in
 * the OpenRouter dashboard — the union is excluded — so the exclusion can also be
 * managed dashboard-side without removing this line.
 */
const SUMMARIZE_PROVIDER: OpenRouterProviderPrefs = { ignore: ["gmicloud"] };

/** Anthropic reports no cost; derive a list-price estimate. OpenRouter reports its own via usage.costUsd. */
function laneCost(provider: string, model: string, usage: TextModelUsage): number | undefined {
  if (provider !== "anthropic") return undefined;
  return estimateCost(
    {
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheWriteTokens: usage.cacheCreate,
      cacheReadTokens: usage.cacheRead,
    },
    model,
  )?.totalUsd;
}

/** Wrap a resolved model so each call emits an `ai_usage` event into the worker log stream. */
function withLaneUsageLogging(model: TextModel, lane: string, env: TextModelEnv): TextModel {
  return withUsageLogging(model, {
    lane,
    environment: env.ENVIRONMENT,
    deriveCost: laneCost,
    sink: (r) => logEvent("info", { component: "ai", event: "ai_usage", ...r }),
  });
}

/**
 * Shared resolver for the secondary cheap-call lanes. A single Flagship switch
 * (`openrouter-enabled`) picks the provider; `orModel` is the lane's OpenRouter
 * model id (empty → stay on Anthropic); `anthropicModel` is the Haiku fallback.
 * `generationName` tags the request for Broadcast trace grouping (inert until
 * Broadcast is configured) and is the axis that breaks usage/cost out per lane.
 */
async function resolveTextModel(
  env: TextModelEnv,
  opts: {
    orModel: string | undefined;
    anthropicModel: string;
    generationName: string;
    /** OpenRouter reasoning control for this lane (OpenRouter path only). */
    reasoning?: OpenRouterReasoning;
    /** OpenRouter provider-routing preferences for this lane (OpenRouter path only). */
    provider?: OpenRouterProviderPrefs;
    /**
     * Per-lane OpenRouter request timeout (ms). Omit to keep the transport
     * default (30s). Bumped only for lanes whose generation is genuinely larger
     * than a one-shot summary (e.g. org overviews read many release bodies).
     */
    timeoutMs?: number;
  },
): Promise<TextModel | null> {
  const useOpenRouter = await flag(env.FLAGS, env.OPENROUTER_ENABLED, FLAGS.openrouterEnabled);

  if (useOpenRouter) {
    const orKey = await getSecret(env.OPENROUTER_API_KEY).catch(() => null);
    const model = opts.orModel?.trim();
    if (orKey && model) {
      const baseURL = env.OPENROUTER_BASE_URL?.trim();
      return withLaneUsageLogging(
        openRouterTextModel({
          apiKey: orKey,
          model,
          ...(baseURL ? { baseURL } : {}),
          ...(opts.reasoning ? { reasoning: opts.reasoning } : {}),
          ...(opts.provider ? { provider: opts.provider } : {}),
          ...(opts.timeoutMs ? { timeoutMs: opts.timeoutMs } : {}),
          referer: "https://releases.sh",
          title: APP_TITLE,
          // Stable per-lane sticky-routing key: every call in a lane shares the
          // same static system prompt, so pinning the lane to one OpenRouter
          // upstream lets that prefix be read from the provider's cache instead
          // of re-billed. The generationName is the lane's natural stable id; it
          // doubles as the Broadcast grouping id (inert until Broadcast is on),
          // which intentionally collapses a lane's traffic into one trace group.
          sessionId: opts.generationName,
          trace: {
            generationName: opts.generationName,
            ...(env.ENVIRONMENT ? { environment: env.ENVIRONMENT } : {}),
          },
        }),
        opts.generationName,
        env,
      );
    }
    if (model && !orKey) {
      // Lane is configured (model var set) but OPENROUTER_API_KEY didn't resolve —
      // warn so this silent fail-open to Anthropic is diagnosable, mirroring
      // resolveExtractAiSdkModel's `openrouter-misconfigured`. An EMPTY model var
      // is the intentional per-lane off switch and stays quiet (falls through
      // without a warn). This is the only signal a misconfigured api-worker lane
      // leaves — the marketing/summarize path otherwise swallows the failure.
      logEvent("warn", {
        component: "text-model",
        event: "openrouter-misconfigured",
        lane: opts.generationName,
        reason: "OPENROUTER_API_KEY unresolved",
      });
    }
    // key/model not usable → fall through to Anthropic (fail open)
  }

  // Key + gateway opts are independent secret/var reads — resolve concurrently.
  const [apiKey, gatewayOpts] = await Promise.all([getAnthropicKey(env), resolveGatewayOpts(env)]);
  if (!apiKey) return null;
  const client = buildAnthropicClient({ apiKey, ...gatewayOpts });
  return withLaneUsageLogging(
    anthropicTextModel(client, opts.anthropicModel),
    opts.generationName,
    env,
  );
}

export function resolveMarketingModel(env: TextModelEnv): Promise<TextModel | null> {
  return resolveTextModel(env, {
    orModel: env.MARKETING_CLASSIFIER_MODEL,
    anthropicModel: ANTHROPIC_MARKETING_MODEL,
    generationName: "marketing-classifier",
  });
}

export function resolveSummarizeModel(env: TextModelEnv): Promise<TextModel | null> {
  return resolveTextModel(env, {
    orModel: env.SUMMARIZE_MODEL,
    anthropicModel: ANTHROPIC_SUMMARIZE_MODEL,
    generationName: "summarize-release",
    reasoning: SUMMARIZE_REASONING,
    provider: SUMMARIZE_PROVIDER,
  });
}

export function resolveArticleExtractModel(env: TextModelEnv): Promise<TextModel | null> {
  return resolveTextModel(env, {
    orModel: env.FEED_ENRICH_MODEL,
    anthropicModel: ANTHROPIC_ARTICLE_MODEL,
    generationName: "feed-enrich",
  });
}

// Reuses the shared SUMMARIZE_MODEL lane var (and its Anthropic Haiku fallback) —
// a collection daily summary is the same "summarize content cheaply" task as a
// release summary, so it rides the same model config rather than defining its own.
// Only the generationName differs, to keep the two lanes separable in usage/cost.
export function resolveCollectionSummaryModel(env: TextModelEnv): Promise<TextModel | null> {
  return resolveTextModel(env, {
    orModel: env.SUMMARIZE_MODEL,
    anthropicModel: ANTHROPIC_SUMMARIZE_MODEL,
    generationName: "collection-daily-summary",
    reasoning: SUMMARIZE_REASONING,
    provider: SUMMARIZE_PROVIDER,
  });
}

/**
 * Org-overview generation lane. UNLIKE the other secondary lanes, this one runs
 * through the AI SDK structured-output path (`generateText` + `Output.object`) so
 * citations come back as a typed field, never a fenced JSON block scraped out of
 * the body (#1928). It therefore returns a `LanguageModel` (not a `TextModel`) and
 * cannot share `resolveTextModel`, but it reuses the SAME config: the
 * `openrouter-enabled` flag, `SUMMARIZE_MODEL` (same task family — no per-feature
 * var), the gmicloud provider-exclusion, and the Anthropic Haiku fail-open.
 *
 * Unlike the one-shot summary lanes, an overview reads many release bodies and
 * emits a longer completion, so a 30s ceiling sits right on the edge of the normal
 * latency band (issue #1793); give it a wider timeout, applied per model call in
 * `generateOverview`. The per-org retry in the regen loop covers the rarer stall.
 */
const OVERVIEW_TIMEOUT_MS = 60_000;
const OVERVIEW_LANE = "org-overview";

export interface ResolvedOverviewModel {
  model: LanguageModel;
  /** Per model-call usage logger — emits an `ai_usage` event, matching `withLaneUsageLogging`. */
  onUsage: (usage: OverviewCallUsage) => void;
  /** Per-call timeout (ms) the caller passes to `generateOverview`. */
  timeoutMs: number;
}

/** Build the overview lane's `ai_usage` sink, normalizing tokens/cost the same way `withLaneUsageLogging` does. */
function overviewUsageSink(
  provider: string,
  model: string,
  env: TextModelEnv,
): (usage: OverviewCallUsage) => void {
  return (u) => {
    // Mirror `cacheMetrics`: OpenRouter's input already includes cached tokens;
    // Anthropic reports them separately, so add them back for a comparable total.
    const promptTokens =
      provider === "openrouter"
        ? u.inputTokens
        : u.inputTokens + u.cacheReadTokens + u.cacheWriteTokens;
    const cacheHitRate =
      promptTokens > 0 ? Math.min(1, Math.max(0, u.cacheReadTokens / promptTokens)) : 0;
    // OpenRouter reports its own cost; Anthropic reports none, so derive a list-price estimate.
    const costUsd =
      u.costUsd ??
      (provider === "anthropic"
        ? estimateCost(
            {
              inputTokens: u.inputTokens,
              outputTokens: u.outputTokens,
              cacheWriteTokens: u.cacheWriteTokens,
              cacheReadTokens: u.cacheReadTokens,
            },
            model,
          )?.totalUsd
        : undefined);
    logEvent("info", {
      component: "ai",
      event: "ai_usage",
      provider,
      model,
      lane: OVERVIEW_LANE,
      environment: env.ENVIRONMENT,
      input: u.inputTokens,
      output: u.outputTokens,
      cacheCreate: u.cacheWriteTokens,
      cacheRead: u.cacheReadTokens,
      promptTokens,
      cacheHitRate,
      costUsd,
    });
  };
}

export async function resolveOverviewModel(
  env: TextModelEnv,
): Promise<ResolvedOverviewModel | null> {
  const useOpenRouter = await flag(env.FLAGS, env.OPENROUTER_ENABLED, FLAGS.openrouterEnabled);

  if (useOpenRouter) {
    const orKey = await getSecret(env.OPENROUTER_API_KEY).catch(() => null);
    const model = env.SUMMARIZE_MODEL?.trim();
    if (orKey && model) {
      const baseURL = env.OPENROUTER_BASE_URL?.trim();
      return {
        model: buildOverviewOpenRouterModel({
          apiKey: orKey,
          model,
          ...(baseURL ? { baseURL } : {}),
          sessionId: OVERVIEW_LANE,
          referer: "https://releases.sh",
          title: APP_TITLE,
          providerPrefs: SUMMARIZE_PROVIDER as Record<string, unknown>,
        }),
        onUsage: overviewUsageSink("openrouter", model, env),
        timeoutMs: OVERVIEW_TIMEOUT_MS,
      };
    }
    if (model && !orKey) {
      logEvent("warn", {
        component: "text-model",
        event: "openrouter-misconfigured",
        lane: OVERVIEW_LANE,
        reason: "OPENROUTER_API_KEY unresolved",
      });
    }
    // key/model not usable → fall through to Anthropic (fail open)
  }

  const [apiKey, gatewayOpts] = await Promise.all([getAnthropicKey(env), resolveGatewayOpts(env)]);
  if (!apiKey) return null;
  return {
    model: buildOverviewAnthropicModel({
      apiKey,
      model: ANTHROPIC_SUMMARIZE_MODEL,
      ...(gatewayOpts.baseURL ? { baseURL: gatewayOpts.baseURL } : {}),
      ...(gatewayOpts.gatewayToken ? { gatewayToken: gatewayOpts.gatewayToken } : {}),
    }),
    onUsage: overviewUsageSink("anthropic", ANTHROPIC_SUMMARIZE_MODEL, env),
    timeoutMs: OVERVIEW_TIMEOUT_MS,
  };
}
