/**
 * Build an EmbeddingConfig override from the MCP Worker Env. Mirrors
 * `workers/api/src/lib/embed-config.ts` — the MCP worker only does
 * read-side embedding for query vectors, so this just resolves the
 * provider + API key and never wires a workers-ai binding.
 */
import { logEvent } from "@releases/lib/log-event";

// Types inlined from `@releases/search/embeddings.js`. That module reads
// `process.env` at import time, which would force the MCP worker's
// tsconfig to pull in node/bun types. The real `embedBatch` is
// dynamic-imported from `search-hybrid.ts` at runtime.
type EmbeddingProvider = "voyage" | "openai" | "workers-ai";
interface EmbeddingConfig {
  provider: EmbeddingProvider;
  model?: string;
  apiKey?: string;
}

/** Kept in sync with DEFAULT_MODELS in packages/search/src/embeddings.ts. */
const DEFAULT_MODELS: Record<EmbeddingProvider, string> = {
  voyage: "voyage-4-lite",
  openai: "text-embedding-3-small",
  "workers-ai": "@cf/baai/bge-base-en-v1.5",
};

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

export async function buildEmbedConfig(env: EmbedEnv): Promise<ResolvedEmbedConfig | null> {
  const rawProvider = (env.EMBEDDING_PROVIDER ?? "voyage").toLowerCase();
  if (rawProvider !== "voyage" && rawProvider !== "openai" && rawProvider !== "workers-ai") {
    logEvent("warn", {
      component: "embed-config",
      event: "unknown-provider",
      provider: rawProvider,
    });
    return null;
  }
  const provider = rawProvider as EmbeddingProvider;

  if (provider === "workers-ai") {
    logEvent("warn", { component: "embed-config", event: "workers-ai-no-binding" });
    return null;
  }

  const keyBinding = provider === "voyage" ? env.VOYAGE_API_KEY : env.OPENAI_API_KEY;
  if (!keyBinding) {
    logEvent("warn", {
      component: "embed-config",
      event: "api-key-binding-missing",
      binding: provider === "voyage" ? "VOYAGE_API_KEY" : "OPENAI_API_KEY",
    });
    return null;
  }

  let apiKey: string;
  try {
    apiKey = await keyBinding.get();
  } catch (err) {
    logEvent("warn", { component: "embed-config", event: "api-key-read-failed", err });
    return null;
  }
  if (!apiKey) {
    logEvent("warn", { component: "embed-config", event: "api-key-empty" });
    return null;
  }

  return { provider, model: DEFAULT_MODELS[provider], apiKey };
}
