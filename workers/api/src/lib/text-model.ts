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
          referer: "https://releases.sh",
          title: APP_TITLE,
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
 * Org-overview generation lane. Reuses the SUMMARIZE_MODEL OpenRouter lane (same
 * task family — no per-feature model var) with a distinct generationName so its
 * usage/cost is attributable, and the same Haiku fail-open as the summary lanes.
 */
export function resolveOverviewModel(env: TextModelEnv): Promise<TextModel | null> {
  return resolveTextModel(env, {
    orModel: env.SUMMARIZE_MODEL,
    anthropicModel: ANTHROPIC_SUMMARIZE_MODEL,
    generationName: "org-overview",
    reasoning: SUMMARIZE_REASONING,
    provider: SUMMARIZE_PROVIDER,
  });
}
