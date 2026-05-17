import { sql, type SQL } from "drizzle-orm";
import { releases } from "@buildinternet/releases-core/schema";
import type { ReleaseComposition } from "@buildinternet/releases-core/composition";

/**
 * Build the Drizzle SQL fragment that sets / clears `metadata.composition`
 * on the `releases` row. Used by the two ingest workflows
 * (poll-and-fetch, batch-summarize) and the PATCH /v1/releases/:id handler so
 * the three write paths produce byte-identical metadata transforms.
 *
 * Returns `null` when the caller should leave `metadata` untouched (composition
 * was not part of this update). Callers conditionally include the returned
 * fragment in their `.set({...})` call, which keeps a row's `metadata` UPDATE
 * — and the corresponding D1 page write — limited to rows whose composition
 * actually changes.
 *
 *   - `composition: object` → `json_set($.composition, json('{...}'))`
 *   - `composition: null`   → `json_remove($.composition)`
 *   - `composition: undefined` (default) → returns null (no-op)
 */
export function buildCompositionMetadataSet(
  composition: ReleaseComposition | null | undefined,
): SQL | null {
  if (composition === undefined) return null;
  if (composition === null) {
    return sql`json_remove(coalesce(${releases.metadata}, '{}'), '$.composition')`;
  }
  const json = JSON.stringify(composition);
  return sql`json_set(coalesce(${releases.metadata}, '{}'), '$.composition', json(${json}))`;
}
