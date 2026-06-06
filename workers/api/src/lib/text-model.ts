/**
 * Pick the `TextModel` for the marketing classifier at call time.
 *
 * When the `marketing-classifier-openrouter` flag is ON *and* an
 * `OPENROUTER_API_KEY` + model id are configured, route to OpenRouter (fronted
 * by AI Gateway when `OPENROUTER_BASE_URL` is set); otherwise fall back to
 * Anthropic Haiku through the existing gateway path. Returns `null` only when no
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
import { buildAnthropicClient } from "@releases/lib/anthropic-client.js";
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
import { getSecret, type SecretBinding } from "@releases/lib/secrets";
import { getAnthropicKey, resolveGatewayOpts, type AnthropicEnv } from "./anthropic.js";

export interface TextModelEnv extends AnthropicEnv {
  FLAGS?: FlagshipBinding;
  MARKETING_CLASSIFIER_OPENROUTER?: string;
  OPENROUTER_API_KEY?: SecretBinding;
  OPENROUTER_BASE_URL?: string;
  MARKETING_CLASSIFIER_MODEL?: string;
}

export async function resolveMarketingModel(env: TextModelEnv): Promise<TextModel | null> {
  const useOpenRouter = await flag(
    env.FLAGS,
    env.MARKETING_CLASSIFIER_OPENROUTER,
    FLAGS.marketingClassifierOpenrouter,
  );
  if (useOpenRouter) {
    const orKey = await getSecret(env.OPENROUTER_API_KEY).catch(() => null);
    const model = env.MARKETING_CLASSIFIER_MODEL?.trim();
    if (orKey && model) {
      const baseURL = env.OPENROUTER_BASE_URL?.trim();
      return openRouterTextModel({
        apiKey: orKey,
        model,
        ...(baseURL ? { baseURL } : {}),
        referer: "https://releases.sh",
        title: "Releases marketing-classifier",
      });
    }
    // key/model not configured → fall through to Anthropic (fail open)
  }

  // Key + gateway opts are independent secret/var reads — resolve concurrently
  // (halves cold-isolate latency; both are WeakMap-cached on warm hits).
  const [apiKey, gatewayOpts] = await Promise.all([getAnthropicKey(env), resolveGatewayOpts(env)]);
  if (!apiKey) return null;
  const client = buildAnthropicClient({ apiKey, ...gatewayOpts });
  return anthropicTextModel(client, ANTHROPIC_MARKETING_MODEL);
}
