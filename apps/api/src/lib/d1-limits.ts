// D1 caps prepared statements at 100 bound parameters. Chunk sizes below are
// derived from this limit and the per-row bind count Drizzle emits for each
// statement shape. `RELEASES_BATCH_CHUNK_SIZE` follows the releases column
// count via `maxChunkLength`, so adding a column shrinks the chunk. The
// bind-budget tests in apps/api/test/releases-batch-binds.test.ts still compile
// the statement with `.toSQL()` and fail when a shape binds more than the
// column count assumed here.
//
// Backend capability constants and the shared chunk helpers live in
// `@buildinternet/releases-core/d1-limits` so packages below the worker
// (core-internal eligibility / overview-upsert) share one source of truth.
// Re-exported here so existing worker import paths keep working.

import { getTableColumns } from "drizzle-orm";
import { releases } from "@buildinternet/releases-core/schema";
import {
  D1_MAX_BINDINGS,
  IN_ARRAY_CHUNK_SIZE,
  assertBindBudget,
  chunkArray,
  chunkForBindBudget,
  maxChunkLength,
} from "@buildinternet/releases-core/d1-limits";

export {
  D1_MAX_BINDINGS,
  IN_ARRAY_CHUNK_SIZE,
  assertBindBudget,
  chunkArray,
  chunkForBindBudget,
  maxChunkLength,
};

// Worst case for a `releases` INSERT: every column is present on the values
// object. Drizzle binds each of those, including explicit nulls, and also
// binds omitted columns that have a default or `$defaultFn`. Nullable columns
// with no default are inlined as `null` only when the key is absent. Poll-fetch
// sets 21 of these (the `body_hash` dedup column plus `suppressed_reason` and
// `effective_category`); five such rows bind 105 parameters and D1 rejects the
// statement with `SQLITE_ERROR: too many SQL variables`. Size the chunk from
// the column count so a fully-bound row stays under the cap with the remainder
// as headroom (27 binds/row → 3 rows → 81 binds).
export const RELEASES_INSERT_BINDS_PER_ROW = Object.keys(getTableColumns(releases)).length;
export const RELEASES_BATCH_CHUNK_SIZE = maxChunkLength(RELEASES_INSERT_BINDS_PER_ROW);

/** Count the binds Drizzle will send and refuse a statement over the D1 cap. */
export function assertStatementBindBudget(
  statement: { toSQL(): { params: readonly unknown[] } },
  label: string,
): void {
  assertBindBudget(statement.toSQL().params.length, label);
}

// IN-clause chunk for id lookups/updates on releases. An UPDATE adds one
// SET binding, so IN_ARRAY_CHUNK_SIZE + 1 stays under the cap; a SELECT
// with that many ids is pure IN-list. Same budget as the generic IN-array chunk.
export const RELEASES_ID_IN_CHUNK_SIZE = IN_ARRAY_CHUNK_SIZE;

// `knowledge_page_citations` INSERT binds 9 placeholders per row: id,
// knowledge_page_id, start_index, end_index, source_url, title, cited_text,
// release_id, created_at. 11 rows * 9 = 99 bindings. In practice an overview
// rarely produces more than ~30 citations, so this cap is mostly defensive.
export const KNOWLEDGE_PAGE_CITATIONS_CHUNK_SIZE = 11;

// `release_coverage` INSERT binds 5 placeholders per row: canonical_id,
// coverage_id, reason, decided_by, decided_at. 20 rows * 5 = 100 bindings.
export const RELEASE_COVERAGE_INSERT_CHUNK_SIZE = 20;

// `org_tags` / `product_tags` INSERT binds 3 placeholders per row
// (org_id|product_id, tag_id, created_at). 33 rows * 3 = 99 bindings; cap at
// 30 for headroom.
export const ENTITY_TAG_INSERT_CHUNK_SIZE = 30;

// `org_accounts` INSERT binds 5 placeholders per row: id ($defaultFn), org_id,
// platform, handle, created_at. 18 rows * 5 = 90 bindings, under the 100 cap.
// (Distinct from the 3-bind tag chunk — don't reuse ENTITY_TAG_INSERT_CHUNK_SIZE
// here; 30 * 5 = 150 would blow the budget.)
export const ORG_ACCOUNTS_INSERT_CHUNK_SIZE = 18;

// `source_changelog_chunks` INSERT binds 11 placeholders per row: the nine
// listed columns (source_changelog_file_id, source_id, offset, length,
// tokens, content_hash, heading, vector_id, embedded_at — vectorId and
// embeddedAt land null in the D1-first staging, see #620) plus `id` and
// `created_at`, which Drizzle materializes from `$defaultFn` and binds
// like any other value. 9 rows * 11 = 99 bindings.
export const CHANGELOG_CHUNK_INSERT_CHUNK_SIZE = 9;

// `release_locations` INSERT binds 18 placeholders per row when every row in
// the batch carries a uniform column set (id, org_id, product_id, url, feed,
// github, appstore, file, title, canonical, publish, path, basis, evidence,
// source_id, match_key, created_at, updated_at). deleted_at is the only column
// left as an inline null. 5 rows * 18 = 90 bindings, under the 100 cap.
// Callers build every row with the same keys so the prepared statement shape
// stays uniform.
export const RELEASE_LOCATIONS_INSERT_CHUNK_SIZE = 5;
