/**
 * Resolve the OpenRouter (DeepSeek) extraction model for the large-body
 * tool-loop (issue #1536). Mirrors the provider-selection precedent in
 * `text-model.ts` (`resolveTextModel`): the single `openrouter-enabled` Flagship
 * switch governs the lane, and per-lane control is the model var (`EXTRACT_MODEL`,
 * empty → stay on Anthropic). Returns `undefined` to keep the Anthropic SDK loop.
 *
 * Fail-open at every step: flag off, empty `EXTRACT_MODEL`, an unresolvable
 * `OPENROUTER_API_KEY`, or any throw → `undefined`, so the caller's `extractDeps`
 * carries no `aiSdkModel` and `extractFromBody` runs the unchanged Anthropic loop.
 */
import { buildOpenRouterExtractModel } from "@releases/adapters/extract";
import { flag, FLAGS, type FlagshipBinding } from "@releases/lib/flags";
import { getSecret, type SecretBinding } from "@releases/lib/secrets";

export interface ExtractModelEnv {
  FLAGS?: FlagshipBinding;
  OPENROUTER_ENABLED?: string;
  OPENROUTER_API_KEY?: SecretBinding;
  OPENROUTER_BASE_URL?: string;
  EXTRACT_MODEL?: string;
}

/**
 * @returns `{ model, label }` when the OpenRouter extraction lane is fully
 *   configured + enabled, else `undefined` (Anthropic path). `model` is an
 *   AI-SDK `LanguageModel` typed `unknown` here to keep the `ai` types off this
 *   surface; `label` is the model id, reported as `modelUsed`.
 */
export async function resolveExtractAiSdkModel(
  env: ExtractModelEnv,
): Promise<{ model: unknown; label: string } | undefined> {
  try {
    const useOpenRouter = await flag(env.FLAGS, env.OPENROUTER_ENABLED, FLAGS.openrouterEnabled);
    if (!useOpenRouter) return undefined;
    const model = env.EXTRACT_MODEL?.trim();
    if (!model) return undefined;
    const apiKey = await getSecret(env.OPENROUTER_API_KEY).catch(() => null);
    if (!apiKey) return undefined;
    const baseURL = env.OPENROUTER_BASE_URL?.trim();
    return {
      model: buildOpenRouterExtractModel({ apiKey, model, ...(baseURL ? { baseURL } : {}) }),
      label: model,
    };
  } catch {
    return undefined;
  }
}
