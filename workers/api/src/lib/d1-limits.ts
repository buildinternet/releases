// D1 caps prepared statements at 100 bound parameters. Chunk sizes below are
// derived from this limit and the per-row bind count Drizzle emits for each
// statement shape. Changing the schema (adding columns to `releases`) or the
// Drizzle insert shape means recomputing these — the bind-budget invariant
// tests in tests/api/releases-batch-binds.test.ts fail loudly when a bump
// would push a statement past the cap.

export const D1_MAX_BINDINGS = 100;

// `releases` INSERT binds up to 17 placeholders per row when the caller
// provides the full sources-batch payload. Drizzle binds everything that has
// either an explicit value, a `$defaultFn`, or a plain `.default(...)`; only
// nullable columns with no default land as inline `null`. For releases that's
// 17 binds (id, source_id, version, version_sort, type, title, content, url,
// content_hash, content_chars, content_tokens, metadata, media, published_at,
// prerelease, suppressed, fetched_at). 5 rows * 17 = 85 binds. Lighter-payload
// insert sites carry fewer binds per row but share this chunk size to keep
// the budget guard rail uniform.
export const RELEASES_BATCH_CHUNK_SIZE = 5;

// IN-clause chunk for id lookups/updates on releases. An UPDATE adds one
// SET binding, so 90 + 1 = 91 stays comfortably under the cap; a SELECT
// with 90 ids is 90.
export const RELEASES_ID_IN_CHUNK_SIZE = 90;

// Generic IN-clause chunk for single-column `inArray(...)` SELECTs on any
// table — same 90-bind budget as the releases lookups. Use when callers
// can supply an unbounded list (URLs, slugs, ids).
export const IN_ARRAY_CHUNK_SIZE = 90;

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

// `source_changelog_chunks` INSERT binds 11 placeholders per row: the nine
// listed columns (source_changelog_file_id, source_id, offset, length,
// tokens, content_hash, heading, vector_id, embedded_at — vectorId and
// embeddedAt land null in the D1-first staging, see #620) plus `id` and
// `created_at`, which Drizzle materializes from `$defaultFn` and binds
// like any other value. 9 rows * 11 = 99 bindings.
export const CHANGELOG_CHUNK_INSERT_CHUNK_SIZE = 9;

// `release_locations` INSERT binds 16 placeholders per row when every row in
// the batch carries a uniform column set (id, org_id, product_id, url, feed,
// github, appstore, file, title, canonical, basis, evidence, source_id,
// match_key, created_at, updated_at). deleted_at is the only column left as an
// inline null. 6 rows * 16 = 96 bindings, under the 100 cap. Callers build
// every row with the same keys so the prepared statement shape stays uniform.
export const RELEASE_LOCATIONS_INSERT_CHUNK_SIZE = 6;
