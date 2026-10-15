/**
 * Relational backend bound-parameter capability constants (D1 / SQLite today).
 *
 * D1 rejects prepared statements with more than 100 bound parameters. The
 * constants and chunk helpers here are the backend capability every `IN`,
 * `OR`, and batch INSERT should read — hoisted so both `apps/api` and
 * `packages/core-internal` share one source of truth. A higher-limit backend
 * (e.g. Postgres) bumps these in one place. Row-shape-specific INSERT chunk
 * sizes (releases batch, citations, tags, …) stay in `apps/api/src/lib/d1-limits.ts`.
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
export function chunkArray<T>(items: readonly T[], size: number): T[][] {
  if (!Number.isInteger(size) || size < 1) {
    throw new Error(`chunk size must be a positive integer (got ${String(size)})`);
  }
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Largest item count whose binds fit in one prepared statement.
 *
 * `bindsPerItem` is one `IN` element, one same-day range, or one INSERT row.
 * `fixedBinds` is everything else on the statement (a source id, a scope eq).
 * Throws when even one item cannot fit — that shape needs a different query,
 * not a bigger chunk. The unused remainder under {@link D1_MAX_BINDINGS} is
 * the headroom; re-measure with `.toSQL()` before spending it on a new bind.
 */
export function maxChunkLength(bindsPerItem: number, fixedBinds = 0): number {
  if (!Number.isInteger(bindsPerItem) || bindsPerItem < 1) {
    throw new Error(`bindsPerItem must be a positive integer (got ${String(bindsPerItem)})`);
  }
  if (!Number.isInteger(fixedBinds) || fixedBinds < 0) {
    throw new Error(`fixedBinds must be a non-negative integer (got ${String(fixedBinds)})`);
  }
  const room = D1_MAX_BINDINGS - fixedBinds;
  if (room < bindsPerItem) {
    throw new Error(
      `D1 bind budget cannot fit one item: ${bindsPerItem} binds plus ${fixedBinds} fixed exceeds ${D1_MAX_BINDINGS}`,
    );
  }
  return Math.floor(room / bindsPerItem);
}

/**
 * Split `items` so each chunk stays within {@link D1_MAX_BINDINGS}.
 * Empty input returns `[]`. Same budget as {@link maxChunkLength}.
 */
export function chunkForBindBudget<T>(
  items: readonly T[],
  bindsPerItem: number,
  fixedBinds = 0,
): T[][] {
  if (items.length === 0) return [];
  return chunkArray(items, maxChunkLength(bindsPerItem, fixedBinds));
}

/**
 * Refuse a statement that would hit D1's `SQLITE_ERROR: too many SQL variables`.
 * Call this on a planned bind count, or on `statement.toSQL().params.length`,
 * before execute — a chunk helper that is skipped should still fail here.
 */
export function assertBindBudget(bindCount: number, label: string): void {
  if (!Number.isInteger(bindCount) || bindCount < 0) {
    throw new Error(
      `${label}: bind count must be a non-negative integer (got ${String(bindCount)})`,
    );
  }
  if (bindCount > D1_MAX_BINDINGS) {
    throw new Error(
      `${label} binds ${bindCount} parameters, over D1's cap of ${D1_MAX_BINDINGS} (SQLITE_ERROR: too many SQL variables)`,
    );
  }
}
