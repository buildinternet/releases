/**
 * Embedding provider abstraction. Supports voyage, openai, and workers-ai
 * behind a single `embedBatch` function. Selects provider via
 * EMBEDDING_PROVIDER env var (or explicit config). Pure: no filesystem or
 * database access — safe to call from Workers or Node/Bun.
 *
 * Call sites should batch inputs themselves; this module only guarantees
 * that a single call stays within the provider's max batch size by
 * splitting internally and concatenating the results.
 */

export type EmbeddingProvider = "voyage" | "openai" | "workers-ai";

export interface EmbeddingConfig {
  provider: EmbeddingProvider;
  /** Model name. Defaults chosen per provider if omitted. */
  model?: string;
  /** API key. Required for voyage + openai; unused for workers-ai. */
  apiKey?: string;
  /** Workers AI binding — required only when provider is "workers-ai". */
  workersAi?: WorkersAiBinding;
  /** Override the fetch implementation (tests). */
  fetchImpl?: typeof fetch;
  /** Max inputs per underlying API call. Defaults are provider-appropriate. */
  maxBatchSize?: number;
  /** Max retries on 429/5xx. Defaults to 3. */
  maxRetries?: number;
  /** Per-request timeout in milliseconds. Defaults to 30_000. */
  timeoutMs?: number;
}

/** Minimal shape of a Cloudflare Workers AI binding used for embeddings. */
export interface WorkersAiBinding {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
}

export interface EmbeddingResult {
  vectors: number[][];
  dims: number;
  model: string;
  provider: EmbeddingProvider;
  inputTokens?: number;
}

export const DEFAULT_MODELS: Record<EmbeddingProvider, string> = {
  voyage: "voyage-4-lite",
  openai: "text-embedding-3-small",
  "workers-ai": "@cf/baai/bge-base-en-v1.5",
};

// Our Vectorize indexes are provisioned at 512 dims. voyage-4-* default to
// 1024 but support Matryoshka-style `output_dimension` to return a shorter
// vector, so we request 512 explicitly to match the indexes.
export const VOYAGE_OUTPUT_DIMENSION = 512;

const DEFAULT_BATCH_SIZES: Record<EmbeddingProvider, number> = {
  voyage: 128,
  openai: 128,
  "workers-ai": 100,
};

/** Max input characters per text before truncation. Rough 4-char-per-token heuristic. */
const MAX_INPUT_CHARS = 32_000;

export function resolveConfig(overrides: Partial<EmbeddingConfig> = {}): EmbeddingConfig {
  const provider = (overrides.provider ??
    (process.env.EMBEDDING_PROVIDER as EmbeddingProvider | undefined) ??
    "voyage") as EmbeddingProvider;
  if (!["voyage", "openai", "workers-ai"].includes(provider)) {
    throw new Error(`Unknown EMBEDDING_PROVIDER: ${provider}`);
  }
  if (overrides.maxBatchSize !== undefined && overrides.maxBatchSize <= 0) {
    throw new Error(
      `Invalid maxBatchSize: ${overrides.maxBatchSize}. The maxBatchSize field must be a positive integer (omit it to use the provider default).`,
    );
  }
  const apiKey =
    overrides.apiKey ??
    (provider === "voyage"
      ? process.env.VOYAGE_API_KEY
      : provider === "openai"
        ? process.env.OPENAI_API_KEY
        : undefined);
  return {
    provider,
    model: overrides.model ?? DEFAULT_MODELS[provider],
    apiKey,
    workersAi: overrides.workersAi,
    fetchImpl: overrides.fetchImpl,
    maxBatchSize: overrides.maxBatchSize ?? DEFAULT_BATCH_SIZES[provider],
    maxRetries: overrides.maxRetries ?? 3,
    timeoutMs: overrides.timeoutMs ?? 30_000,
  };
}

function truncate(text: string): string {
  return text.length > MAX_INPUT_CHARS ? text.slice(0, MAX_INPUT_CHARS) : text;
}

async function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Embed a batch of texts. Splits the input into provider-appropriate chunks,
 * calls the provider, retries on 429/5xx with exponential backoff, and
 * returns the concatenated result.
 */
export async function embedBatch(
  texts: string[],
  overrides: Partial<EmbeddingConfig> = {},
): Promise<EmbeddingResult> {
  const cfg = resolveConfig(overrides);
  if (texts.length === 0) {
    return {
      vectors: [],
      dims: 0,
      model: cfg.model ?? DEFAULT_MODELS[cfg.provider],
      provider: cfg.provider,
    };
  }
  const cleaned = texts.map(truncate);
  const chunks = splitIntoChunks(cleaned, cfg.maxBatchSize ?? 128);

  const all: number[][] = [];
  let totalInputTokens = 0;
  for (const chunk of chunks) {
    const result = await callWithRetry(chunk, cfg);
    all.push(...result.vectors);
    totalInputTokens += result.inputTokens ?? 0;
  }
  return {
    vectors: all,
    dims: all[0]?.length ?? 0,
    model: cfg.model ?? DEFAULT_MODELS[cfg.provider],
    provider: cfg.provider,
    inputTokens: totalInputTokens || undefined,
  };
}

function splitIntoChunks<T>(items: T[], size: number): T[][] {
  if (size <= 0 || items.length <= size) return [items];
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function callWithRetry(
  chunk: string[],
  cfg: EmbeddingConfig,
): Promise<EmbeddingResult> {
  const maxRetries = cfg.maxRetries ?? 3;
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await dispatchProvider(chunk, cfg);
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === maxRetries) break;
      const delayMs = 500 * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(delayMs);
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

class EmbeddingApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = "EmbeddingApiError";
  }
}

function isRetryable(err: unknown): boolean {
  if (err instanceof EmbeddingApiError) return err.retryable;
  // Only retry errors that look like network transport failures. Programmer
  // errors (TypeError, JSON parse failures, missing API key) should surface
  // immediately rather than stall behind exponential backoff.
  if (err instanceof TypeError) return true; // fetch throws TypeError on network failure
  return false;
}

async function dispatchProvider(
  chunk: string[],
  cfg: EmbeddingConfig,
): Promise<EmbeddingResult> {
  switch (cfg.provider) {
    case "voyage":
      return callOpenAiCompatible(chunk, cfg, {
        provider: "voyage",
        url: "https://api.voyageai.com/v1/embeddings",
        envVar: "VOYAGE_API_KEY",
        body: (model) => ({
          input: chunk,
          model,
          input_type: "document",
          output_dimension: VOYAGE_OUTPUT_DIMENSION,
        }),
      });
    case "openai":
      return callOpenAiCompatible(chunk, cfg, {
        provider: "openai",
        url: "https://api.openai.com/v1/embeddings",
        envVar: "OPENAI_API_KEY",
        body: (model) => ({ input: chunk, model }),
      });
    case "workers-ai":
      return callWorkersAi(chunk, cfg);
  }
}

async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (
      (err instanceof Error && err.name === "AbortError") ||
      controller.signal.aborted
    ) {
      throw new EmbeddingApiError(
        `embedding request timed out after ${timeoutMs}ms`,
        0,
        true,
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Voyage and OpenAI both speak the same /v1/embeddings shape: same headers,
 * same `{ data: [{ embedding, index }], usage }` response. The only
 * differences are the URL, the missing API key error message, and Voyage's
 * additional `input_type` field. Keeping a single helper here means both
 * providers share their retry, parsing, and ordering logic.
 */
interface OpenAiCompatibleSpec {
  provider: Extract<EmbeddingProvider, "voyage" | "openai">;
  url: string;
  envVar: string;
  body: (model: string) => Record<string, unknown>;
}

async function callOpenAiCompatible(
  chunk: string[],
  cfg: EmbeddingConfig,
  spec: OpenAiCompatibleSpec,
): Promise<EmbeddingResult> {
  if (!cfg.apiKey) {
    throw new Error(`${spec.envVar} is required for ${spec.provider} provider`);
  }
  const fetchImpl = cfg.fetchImpl ?? fetch;
  const model = cfg.model ?? DEFAULT_MODELS[spec.provider];
  const res = await fetchWithTimeout(
    fetchImpl,
    spec.url,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(spec.body(model)),
    },
    cfg.timeoutMs ?? 30_000,
  );
  if (!res.ok) {
    throw new EmbeddingApiError(
      `${spec.provider} embeddings failed: ${res.status} ${await res.text()}`,
      res.status,
      res.status === 429 || res.status >= 500,
    );
  }
  const body = (await res.json()) as {
    data: Array<{ embedding: number[]; index: number }>;
    usage?: { total_tokens?: number };
  };
  const sorted = [...body.data].toSorted((a, b) => a.index - b.index);
  return {
    vectors: sorted.map((d) => d.embedding),
    dims: sorted[0]?.embedding.length ?? 0,
    model,
    provider: spec.provider,
    inputTokens: body.usage?.total_tokens,
  };
}

async function callWorkersAi(
  chunk: string[],
  cfg: EmbeddingConfig,
): Promise<EmbeddingResult> {
  if (!cfg.workersAi) {
    throw new Error("workersAi binding is required for workers-ai provider");
  }
  const model = cfg.model ?? DEFAULT_MODELS["workers-ai"];
  const result = await cfg.workersAi.run(model, { text: chunk });
  return {
    vectors: result.data,
    dims: result.data[0]?.length ?? 0,
    model,
    provider: "workers-ai",
  };
}
