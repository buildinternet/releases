import { sql } from "drizzle-orm";
import { feedCursorSql, type AggregateReleaseRow, type FeedQueryRunner } from "./feed-cursor.js";

export { buildFeedCursor } from "./feed-cursor.js";

export type CollectionReleaseRow = AggregateReleaseRow;

/** Split an array into chunks of at most `size` elements. */
function chunkArray<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    chunks.push(arr.slice(i, i + size));
  }
  return chunks;
}

/**
 * D1 ceiling: 100 bound parameters per prepared statement. The collection
 * feed query binds up to 6 parameters for the cursor predicate and 1 for
 * LIMIT, leaving 93 slots. We use 90 to stay safely clear.
 */
const ORG_ID_CHUNK_SIZE = 90;

function runFeedChunk(
  db: FeedQueryRunner,
  orgIdsChunk: string[],
  cursor: ReturnType<typeof feedCursorSql>,
  prereleaseWhere: ReturnType<typeof feedCursorSql>,
  limit: number,
): Promise<CollectionReleaseRow[]> {
  return db.all<CollectionReleaseRow>(sql`
    SELECT r.id, r.version, r.title, r.content, r.summary,
           r.title_generated, r.title_short, r.type,
           r.published_at, r.fetched_at, r.url, r.media, r.prerelease,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type,
           o.slug AS org_slug, o.name AS org_name,
           p.slug AS product_slug, p.name AS product_name
    FROM releases_visible r
    INNER JOIN sources_active s ON s.id = r.source_id
    INNER JOIN organizations_active o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE s.org_id IN ${orgIdsChunk}
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      ${prereleaseWhere}
      ${cursor}
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC,
      r.fetched_at DESC,
      r.id DESC
    LIMIT ${limit}
  `);
}

/**
 * Multi-org release feed for a collection. Used by both the REST handler
 * (`GET /v1/collections/:slug/releases`) and the MCP `get_collection_releases`
 * tool — sharing the query keeps ordering and cursor semantics in lock-step
 * across surfaces.
 *
 * D1 caps prepared-statement parameters at 100. When `orgIds` is large, a
 * single `IN (…)` clause would exceed this limit. The fix chunks `orgIds`
 * into batches of {@link ORG_ID_CHUNK_SIZE}, runs one query per chunk (each
 * carrying the same cursor + limit), then merges and re-sorts the combined
 * rows in JS before slicing to `limit`. Ordering is `published_at DESC,
 * fetched_at DESC, id DESC` with null `published_at` sorted last — matching
 * the ORDER BY inside each chunk query so the merge is stable.
 */
export async function getCollectionReleasesFeed(
  db: FeedQueryRunner,
  orgIds: string[],
  cursorParam: string | null,
  limit: number,
  opts: { includePrereleases?: boolean } = {},
): Promise<CollectionReleaseRow[]> {
  if (orgIds.length === 0) return [];
  const cursor = feedCursorSql(cursorParam);
  const prereleaseWhere = opts.includePrereleases
    ? sql``
    : sql`AND (r.prerelease IS NULL OR r.prerelease = 0)`;

  const chunks = chunkArray(orgIds, ORG_ID_CHUNK_SIZE);

  if (chunks.length === 1) {
    return runFeedChunk(db, chunks[0]!, cursor, prereleaseWhere, limit);
  }

  const chunkResults = await Promise.all(
    chunks.map((chunk) => runFeedChunk(db, chunk, cursor, prereleaseWhere, limit)),
  );

  const merged = chunkResults.flat();

  // Re-sort to match the DB ORDER BY:
  //   dated rows (published_at IS NOT NULL) before undated, then
  //   published_at DESC, fetched_at DESC, id DESC
  merged.sort((a, b) => {
    const aDated = a.published_at !== null ? 0 : 1;
    const bDated = b.published_at !== null ? 0 : 1;
    if (aDated !== bDated) return aDated - bDated;
    if (a.published_at !== b.published_at) {
      if (a.published_at === null) return 1;
      if (b.published_at === null) return -1;
      return b.published_at < a.published_at ? -1 : b.published_at > a.published_at ? 1 : 0;
    }
    if (a.fetched_at !== b.fetched_at) {
      return b.fetched_at < a.fetched_at ? -1 : b.fetched_at > a.fetched_at ? 1 : 0;
    }
    return b.id < a.id ? -1 : b.id > a.id ? 1 : 0;
  });

  return merged.slice(0, limit);
}
