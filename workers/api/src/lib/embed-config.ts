/**
 * Build an EmbeddingConfig override from the Worker Env for use by the
 * shared embed helpers under @releases/search/embed-*.
 *
 * Workers don't have process.env, so we pass config explicitly. This helper:
 *   - Resolves the secret binding (VOYAGE_API_KEY or OPENAI_API_KEY)
 *   - Picks the provider string (defaults to voyage — same default as
 *     the CLI side)
 *   - Returns null when the relevant API key binding is missing so
 *     callers can log-and-skip rather than crash.
 *
 * The MCP worker is read-only and never calls this path.
 */

import {
  DEFAULT_MODELS,
  type EmbeddingConfig,
  type EmbeddingProvider,
} from "@releases/search/embeddings.js";

/** Shape returned by {@link buildEmbedConfig} — `provider` and `model` are always resolved. */
export type ResolvedEmbedConfig = EmbeddingConfig & {
  provider: EmbeddingProvider;
  model: string;
};

type SecretBinding = { get(): Promise<string> };

interface EmbedEnv {
  EMBEDDING_PROVIDER?: string;
  VOYAGE_API_KEY?: SecretBinding;
  OPENAI_API_KEY?: SecretBinding;
}

/**
 * Returns a Partial<EmbeddingConfig> ready to hand to embedBatch, or null
 * if the configured provider has no API key bound.
 */
export async function buildEmbedConfig(env: EmbedEnv): Promise<ResolvedEmbedConfig | null> {
  const rawProvider = (env.EMBEDDING_PROVIDER ?? "voyage").toLowerCase();
  if (rawProvider !== "voyage" && rawProvider !== "openai" && rawProvider !== "workers-ai") {
    console.warn(`[embed-config] unknown EMBEDDING_PROVIDER: ${rawProvider}`);
    return null;
  }
  const provider = rawProvider as EmbeddingProvider;

  // workers-ai uses a binding, not an API key. We don't currently bind it
  // in the API worker (embedding is farmed out to voyage by default), so
  // fail fast with a clear log if someone flips the flag.
  if (provider === "workers-ai") {
    console.warn(
      "[embed-config] workers-ai provider requested but no AI binding is wired to the API worker",
    );
    return null;
  }

  const keyBinding = provider === "voyage" ? env.VOYAGE_API_KEY : env.OPENAI_API_KEY;
  if (!keyBinding) {
    console.warn(
      `[embed-config] ${provider === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY"} binding missing — embedding will be skipped`,
    );
    return null;
  }

  let apiKey: string;
  try {
    apiKey = await keyBinding.get();
  } catch (err) {
    console.warn(
      `[embed-config] failed to read API key secret: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return null;
  }
  if (!apiKey) {
    console.warn("[embed-config] API key secret resolved to empty string");
    return null;
  }

  return { provider, model: DEFAULT_MODELS[provider], apiKey };
}
