/**
 * Resolve the AI-SDK extraction model for the large-body tool-loop (issue #1536).
 * OpenRouter when the `openrouter-enabled` flag + `EXTRACT_MODEL` + key are set;
 * otherwise Anthropic via `buildLaneAnthropicModel` so `extractFromBody` always
 * routes the tool-loop through `extractWithToolsAiSdk`.
 */
import { resolveToolLoopAiSdkModel } from "@releases/adapters/extract";
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { getSecret, type SecretBinding } from "@releases/lib/secrets";
import { getAnthropicKey, resolveGatewayOpts, type AnthropicEnv } from "./anthropic.js";

export interface ExtractModelEnv extends AnthropicEnv {
  FLAGS?: FlagshipBinding;
  OPENROUTER_ENABLED?: string;
  OPENROUTER_API_KEY?: SecretBinding;
  OPENROUTER_BASE_URL?: string;
  EXTRACT_MODEL?: string;
}

/** @returns `{ model, label }` for the tool-loop, or `undefined` when no key is usable. */
export async function resolveExtractAiSdkModel(
  env: ExtractModelEnv,
  anthropicModel: string,
): Promise<{ model: unknown; label: string } | undefined> {
  let openrouterEnabled = false;
  let openRouterApiKey: string | null = null;
  try {
    openrouterEnabled = await flag(env.FLAGS, env.OPENROUTER_ENABLED, FLAGS.openrouterEnabled);
    if (openrouterEnabled) {
      openRouterApiKey = await getSecret(env.OPENROUTER_API_KEY).catch(() => null);
    }
  } catch (err) {
    logEvent("warn", {
      component: "extract-model",
      event: "openrouter-resolve-failed",
      err: err instanceof Error ? err : String(err),
    });
  }

  const [anthropicApiKey, gatewayOpts] = await Promise.all([
    getAnthropicKey(env),
    resolveGatewayOpts(env),
  ]);
  return resolveToolLoopAiSdkModel({
    openrouterEnabled,
    extractModel: env.EXTRACT_MODEL,
    openRouterApiKey,
    openRouterBaseURL: env.OPENROUTER_BASE_URL,
    anthropicApiKey: anthropicApiKey ?? undefined,
    anthropicModel,
    anthropicBaseURL: gatewayOpts.baseURL,
    aiGatewayToken: gatewayOpts.gatewayToken,
    logComponent: "extract-model",
  });
}
