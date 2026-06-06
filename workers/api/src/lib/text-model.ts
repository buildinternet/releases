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
  type TextModel,
} from "@releases/ai-internal/text-model";
import { MODEL as ANTHROPIC_MARKETING_MODEL } from "@releases/ai-internal/marketing-classifier";
import { MODEL as ANTHROPIC_SUMMARIZE_MODEL } from "@releases/ai-internal/release-content";
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { flag, FLAGS, type FlagDef, type FlagshipBinding } from "@releases/lib/flags";
import { getSecret, type SecretBinding } from "@releases/lib/secrets";
import { getAnthropicKey, resolveGatewayOpts, type AnthropicEnv } from "./anthropic.js";

export interface TextModelEnv extends AnthropicEnv {
  FLAGS?: FlagshipBinding;
  OPENROUTER_API_KEY?: SecretBinding;
  OPENROUTER_BASE_URL?: string;
  MARKETING_CLASSIFIER_OPENROUTER?: string;
  MARKETING_CLASSIFIER_MODEL?: string;
  SUMMARIZE_OPENROUTER?: string;
  SUMMARIZE_MODEL?: string;
}

/**
 * Shared resolver for both cheap-call lanes. `flagDef` + `varValue` pick the
 * OpenRouter toggle; `orModel` is the lane's OpenRouter model id (empty → stay
 * on Anthropic); `anthropicModel` is the Haiku fallback. `title` tags the
 * OpenRouter request for cost attribution.
 */
async function resolveTextModel(
  env: TextModelEnv,
  opts: {
    flagDef: FlagDef;
    varValue: string | undefined;
    orModel: string | undefined;
    anthropicModel: string;
    title: string;
  },
): Promise<TextModel | null> {
  const useOpenRouter = await flag(env.FLAGS, opts.varValue, opts.flagDef);
  if (useOpenRouter) {
    const orKey = await getSecret(env.OPENROUTER_API_KEY).catch(() => null);
    const model = opts.orModel?.trim();
    if (orKey && model) {
      const baseURL = env.OPENROUTER_BASE_URL?.trim();
      return openRouterTextModel({
        apiKey: orKey,
        model,
        ...(baseURL ? { baseURL } : {}),
        referer: "https://releases.sh",
        title: opts.title,
      });
    }
    // key/model not configured → fall through to Anthropic (fail open)
  }

  // Key + gateway opts are independent secret/var reads — resolve concurrently
  // (halves cold-isolate latency; both are WeakMap-cached on warm hits).
  const [apiKey, gatewayOpts] = await Promise.all([getAnthropicKey(env), resolveGatewayOpts(env)]);
  if (!apiKey) return null;
  const client = buildAnthropicClient({ apiKey, ...gatewayOpts });
  return anthropicTextModel(client, opts.anthropicModel);
}

export function resolveMarketingModel(env: TextModelEnv): Promise<TextModel | null> {
  return resolveTextModel(env, {
    flagDef: FLAGS.marketingClassifierOpenrouter,
    varValue: env.MARKETING_CLASSIFIER_OPENROUTER,
    orModel: env.MARKETING_CLASSIFIER_MODEL,
    anthropicModel: ANTHROPIC_MARKETING_MODEL,
    title: "Releases marketing-classifier",
  });
}

export function resolveSummarizeModel(env: TextModelEnv): Promise<TextModel | null> {
  return resolveTextModel(env, {
    flagDef: FLAGS.summarizeOpenrouter,
    varValue: env.SUMMARIZE_OPENROUTER,
    orModel: env.SUMMARIZE_MODEL,
    anthropicModel: ANTHROPIC_SUMMARIZE_MODEL,
    title: "Releases summarize",
  });
}
