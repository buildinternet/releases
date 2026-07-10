/**
 * Relational backend bound-parameter capability constants (D1 / SQLite today).
 *
 * D1 rejects prepared statements with more than 100 bound parameters. These
 * two values are the backend capability every single-column `IN (...)` chunk
 * should read — hoisted here so both `workers/api` and `packages/core-internal`
 * share one source of truth. A higher-limit backend (e.g. Postgres) bumps these
 * in one place. Row-shape-specific INSERT chunk sizes (releases batch,
 * citations, tags, …) stay in `workers/api/src/lib/d1-limits.ts`.
 *
 * Broader capability matrix (FTS, batch, vectors, IDs):
 * docs/architecture/storage-portability.md → Backend capability map.
 */

/** Hard ceiling on bound parameters per prepared statement (D1 / SQLite). */
export const D1_MAX_BINDINGS = 100;

/**
 * Generic IN-clause chunk for single-column `inArray(...)` SELECTs on any
 * table. 90 leaves headroom for a scalar SET/WHERE bind beside the list.
 * Use when callers can supply an unbounded list (URLs, slugs, ids).
 */
export const IN_ARRAY_CHUNK_SIZE = 90;

/**
 * Split an array into chunks of at most `size` elements. The one shared
 * implementation for every D1 bind-budget chunking site (`IN (...)` lists,
 * chunked INSERTs, …) — do not add another private copy. `size` is the
 * caller's chunk width (often `IN_ARRAY_CHUNK_SIZE` above, but row-shape
 * INSERT chunk sizes live with their own tables and are passed in directly).
 */
export function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
