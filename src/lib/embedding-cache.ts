/**
 * KV-backed cache for single-query embeddings.
 *
 * Wraps an `embed(text)` closure and returns one that checks KV first,
 * calls through on miss, and writes the result back. Keys include the
 * provider, model, and vector dimensionality so configuration changes
 * invalidate the keyspace automatically — there is no manual purge.
 *
 * Only the search query path should use this. Ingest paths embed fresh
 * release or entity content that is unlikely to repeat, so caching
 * would just bloat KV with one-shot entries.
 */

/**
 * Minimal shape we rely on — matches `KVNamespace` but re-declared here
 * so tests can pass a plain object without pulling workers-types.
 */
export interface EmbedCacheBinding {
  get(key: string, type: "json"): Promise<unknown>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number },
  ): Promise<void>;
}

import type { EmbeddingProvider } from "./embeddings.js";

export interface EmbedCacheKeyParts {
  provider: EmbeddingProvider;
  model: string;
  dim: number;
}

/** 7 days. Provider / model / dim are already in the key, so aging is pure cost control. */
export const EMBED_CACHE_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * Skip caching for queries beyond this length. Keeps the keyspace tight
 * — almost every real search query is well under this — and avoids
 * paying for KV writes on outlier inputs (full documents pasted in by
 * mistake, for example).
 */
export const EMBED_CACHE_MAX_QUERY_CHARS = 512;

/** Stable key prefix — bump the `v1` segment if the stored shape changes. */
const KEY_PREFIX = "embed:v1";

/**
 * Wrap `embed` with a KV cache keyed on `(provider, model, dim, sha256(normalizedQuery))`.
 *
 * If `kv` is undefined the wrapper is the identity: callers can always
 * pass `env.EMBED_CACHE` without branching on whether the binding exists.
 *
 * `waitUntil`, when provided, is used to fire-and-forget KV writes so
 * cache misses don't pay for the write round-trip. When absent, writes
 * are awaited — fine for code paths without an ExecutionContext, and
 * still cheaper than a Voyage call.
 */
export function withEmbedCache(
  embed: (text: string) => Promise<number[]>,
  kv: EmbedCacheBinding | undefined,
  keyParts: EmbedCacheKeyParts,
  waitUntil?: (p: Promise<unknown>) => void,
): (text: string) => Promise<number[]> {
  if (!kv) return embed;
  return async (raw: string) => {
    const normalized = raw.trim().toLowerCase();
    if (!normalized || normalized.length > EMBED_CACHE_MAX_QUERY_CHARS) {
      return embed(raw);
    }

    const key = await buildKey(keyParts, normalized);

    const cached = await kv.get(key, "json").catch(() => null);
    if (isVector(cached, keyParts.dim)) return cached;

    const vec = await embed(raw);
    const write = kv
      .put(key, JSON.stringify(vec), { expirationTtl: EMBED_CACHE_TTL_SECONDS })
      .catch(() => {
        // A failed write shouldn't turn into a failed search — the
        // request already has its vector, and the next call will just
        // miss again.
      });
    if (waitUntil) waitUntil(write);
    else await write;
    return vec;
  };
}

async function buildKey(
  parts: EmbedCacheKeyParts,
  normalizedQuery: string,
): Promise<string> {
  const hash = await sha256Hex(normalizedQuery);
  return `${KEY_PREFIX}:${parts.provider}:${parts.model}:${parts.dim}:${hash}`;
}

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  const bytes = new Uint8Array(buf);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  return hex;
}

function isVector(value: unknown, expectedDim: number): value is number[] {
  return (
    Array.isArray(value) &&
    value.length === expectedDim &&
    typeof value[0] === "number"
  );
}
