/**
 * Pick the `TextModel` for the cheap-call AI lanes (marketing classifier and
 * live release summarizer) at call time.
 *
 * Each lane has its own flag + model var so they roll out independently. When a
 * lane's flag is ON *and* an `OPENROUTER_API_KEY` + that lane's model id are
 * configured, route to OpenRouter (fronted by AI Gateway when
 * `OPENROUTER_BASE_URL` is set); otherwise fall back to the lane's Anthropic
 * Haiku model through the existing gateway path. Returns `null` only when no
 * provider is usable (no Anthropic key) so the caller can fail open by skipping.
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
import { MODEL as ANTHROPIC_MARKETING_MODEL } from "@releases/ai-internal/marketing-classifier";
import { MODEL as ANTHROPIC_SUMMARIZE_MODEL } from "@releases/ai-internal/release-content";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { flag, flagState, FLAGS, type FlagDef, type FlagshipBinding } from "@releases/lib/flags";
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
  MARKETING_CLASSIFIER_OPENROUTER?: string;
  MARKETING_CLASSIFIER_MODEL?: string;
  SUMMARIZE_OPENROUTER?: string;
  SUMMARIZE_MODEL?: string;
  /** Global default for the elastic lanes; per-lane flags override it. Flagship-driven; var optional. */
  ELASTIC_LANE_DEFAULT_OPENROUTER?: string;
}

/**
 * Single, stable OpenRouter app name across every lane. App *identity* (rankings,
 * the app page) is keyed on `HTTP-Referer`, and the title is display-only — so a
 * lane-varying title would just flap the app's shown name without segmenting
 * anything. Per-lane breakdown lives in the Broadcast `generation_name` tag.
 */
const APP_TITLE = "Releases";

/** Anthropic reports no cost; derive a list-price estimate. OpenRouter reports its own via usage.costUsd. */
function laneCost(provider: string, model: string, usage: TextModelUsage): number | undefined {
  if (provider !== "anthropic") return undefined;
  return (
    estimateCost(
      {
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheWriteTokens: usage.cacheCreate,
        cacheReadTokens: usage.cacheRead,
      },
      model,
    )?.totalUsd ?? undefined
  );
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
 * Shared resolver for both cheap-call lanes. `flagDef` + `varValue` pick the
 * OpenRouter toggle; `orModel` is the lane's OpenRouter model id (empty → stay
 * on Anthropic); `anthropicModel` is the Haiku fallback. `generationName` tags
 * the request for Broadcast trace grouping (inert until Broadcast is configured)
 * and is the axis that breaks usage/cost out per lane.
 */
async function resolveTextModel(
  env: TextModelEnv,
  opts: {
    flagDef: FlagDef;
    varValue: string | undefined;
    orModel: string | undefined;
    anthropicModel: string;
    generationName: string;
  },
): Promise<TextModel | null> {
  const laneState = await flagState(env.FLAGS, opts.varValue, opts.flagDef);
  const useOpenRouter =
    laneState === "unset"
      ? await flag(
          env.FLAGS,
          env.ELASTIC_LANE_DEFAULT_OPENROUTER,
          FLAGS.elasticLaneDefaultOpenrouter,
        )
      : laneState === "on";

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
    // key/model not configured → fall through to Anthropic (fail open)
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
    flagDef: FLAGS.marketingClassifierOpenrouter,
    varValue: env.MARKETING_CLASSIFIER_OPENROUTER,
    orModel: env.MARKETING_CLASSIFIER_MODEL,
    anthropicModel: ANTHROPIC_MARKETING_MODEL,
    generationName: "marketing-classifier",
  });
}

export function resolveSummarizeModel(env: TextModelEnv): Promise<TextModel | null> {
  return resolveTextModel(env, {
    flagDef: FLAGS.summarizeOpenrouter,
    varValue: env.SUMMARIZE_OPENROUTER,
    orModel: env.SUMMARIZE_MODEL,
    anthropicModel: ANTHROPIC_SUMMARIZE_MODEL,
    generationName: "summarize-release",
  });
}
