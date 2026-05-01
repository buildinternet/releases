// D1 caps prepared statements at 100 bound parameters. Chunk sizes below are
// derived from this limit and the per-row bind count Drizzle emits for each
// statement shape. Changing the schema (adding columns to `releases`) or the
// Drizzle insert shape means recomputing these — the bind-budget invariant
// tests in tests/api/releases-batch-binds.test.ts fail loudly when a bump
// would push a statement past the cap.

export const D1_MAX_BINDINGS = 100;

// `releases` INSERT binds 13 placeholders per row: id, source_id, version,
// type, title, content, url, content_hash, metadata, media, published_at,
// suppressed, fetched_at. 7 rows * 13 = 91 bindings.
export const RELEASES_BATCH_CHUNK_SIZE = 7;

// IN-clause chunk for id lookups/updates on releases. An UPDATE adds one
// SET binding, so 90 + 1 = 91 stays comfortably under the cap; a SELECT
// with 90 ids is 90.
export const RELEASES_ID_IN_CHUNK_SIZE = 90;

// `source_changelog_chunks` INSERT binds 11 placeholders per row: the nine
// listed columns (source_changelog_file_id, source_id, offset, length,
// tokens, content_hash, heading, vector_id, embedded_at — vectorId and
// embeddedAt land null in the D1-first staging, see #620) plus `id` and
// `created_at`, which Drizzle materializes from `$defaultFn` and binds
// like any other value. 9 rows * 11 = 99 bindings.
export const CHANGELOG_CHUNK_INSERT_CHUNK_SIZE = 9;
