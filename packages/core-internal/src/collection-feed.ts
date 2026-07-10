import { sql } from "drizzle-orm";
import { chunkArray } from "@buildinternet/releases-core/d1-limits";
import { feedCursorSql, type AggregateReleaseRow, type FeedQueryRunner } from "./feed-cursor.js";
import { COVERAGE_COUNT_EXPR } from "./release-coverage-sql.js";

export { buildFeedCursor } from "./feed-cursor.js";

export type CollectionReleaseRow = AggregateReleaseRow;

/**
 * D1 ceiling: 100 bound parameters per prepared statement. The collection
 * feed query binds up to 6 parameters for the cursor predicate, 1 for LIMIT,
 * and up to 4 for `sourceTypes` (the full SOURCE_TYPES enum). 100 − 11 = 89
 * slots for the IN clause (org_id or product_id chunked independently).
 */
const ID_CHUNK_SIZE = 89;

type MemberWhereKind = "org" | "product";

function memberWhere(kind: MemberWhereKind, ids: string[]) {
  return kind === "org" ? sql`s.org_id IN ${ids}` : sql`s.product_id IN ${ids}`;
}

function runFeedChunk(
  db: FeedQueryRunner,
  kind: MemberWhereKind,
  idsChunk: string[],
  cursor: ReturnType<typeof feedCursorSql>,
  prereleaseWhere: ReturnType<typeof feedCursorSql>,
  sourceTypeWhere: ReturnType<typeof feedCursorSql>,
  limit: number,
): Promise<CollectionReleaseRow[]> {
  return db.all<CollectionReleaseRow>(sql`
    SELECT r.id, r.version, r.title, r.content, r.summary,
           r.content_chars, r.content_tokens, r.metadata,
           r.title_generated, r.title_short, r.type,
           r.published_at, r.fetched_at, r.url, r.media, r.prerelease,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type,
           o.slug AS org_slug, o.name AS org_name, o.avatar_url AS org_avatar_url,
           (SELECT handle FROM org_accounts
              WHERE org_id = o.id AND platform = 'github'
              ORDER BY created_at, id LIMIT 1) AS org_github_handle,
           p.slug AS product_slug, p.name AS product_name,
           ${sql.raw(COVERAGE_COUNT_EXPR)} AS coverage_count
    FROM releases_visible r
    INNER JOIN sources_active s ON s.id = r.source_id
    INNER JOIN organizations_active o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE ${memberWhere(kind, idsChunk)}
      AND (r.suppressed IS NULL OR r.suppressed = 0)
      ${prereleaseWhere}
      ${sourceTypeWhere}
      ${cursor}
    ORDER BY
      CASE WHEN r.published_at IS NOT NULL THEN 0 ELSE 1 END,
      r.published_at DESC,
      r.fetched_at DESC,
      r.id DESC
    LIMIT ${limit}
  `);
}

function compareRows(a: CollectionReleaseRow, b: CollectionReleaseRow): number {
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
}

/**
 * Multi-member release feed for a collection. Used by both the REST handler
 * (`GET /v1/collections/:slug/releases`) and the MCP `get_collection_releases`
 * tool — sharing the query keeps ordering and cursor semantics in lock-step
 * across surfaces.
 *
 * Collections can pin orgs (whole-org membership) and products (one product
 * out of an org's catalog). Both kinds are passed as separate id lists and
 * UNION-merged client-side: we run one query per chunk per kind, dedupe the
 * combined rows by release id (a Claude Code release would match both the
 * Anthropic-org branch and the Claude-Code-product branch if a collection
 * happened to include both), then re-sort and slice to `limit`.
 *
 * D1 caps prepared-statement parameters at 100. Each chunk binds at most
 * `ID_CHUNK_SIZE` (89) IN values plus the cursor and source-type binds,
 * leaving the same headroom the previous single-kind implementation had.
 */
export async function getCollectionReleasesFeed(
  db: FeedQueryRunner,
  orgIds: string[],
  cursorParam: string | null,
  limit: number,
  opts: {
    includePrereleases?: boolean;
    sourceTypes?: string[];
    /** Product members. Sources joined by `s.product_id IN productIds`. */
    productIds?: string[];
  } = {},
): Promise<CollectionReleaseRow[]> {
  const productIds = opts.productIds ?? [];
  if (orgIds.length === 0 && productIds.length === 0) return [];

  const cursor = feedCursorSql(cursorParam);
  const prereleaseWhere = opts.includePrereleases
    ? sql``
    : sql`AND (r.prerelease IS NULL OR r.prerelease = 0)`;
  // Dedupe before building the `IN` clause: the bind-budget math relies on
  // sourceTypes contributing at most SOURCE_TYPES.length (4) binds, but
  // nothing in the type signature prevents a caller from passing repeats.
  // Set normalization is cheap (n ≤ 4) and keeps the 100-bind cap honest.
  const sourceTypes = opts.sourceTypes === undefined ? undefined : [...new Set(opts.sourceTypes)];
  // Empty `sourceTypes` array = caller asked to narrow but supplied no valid
  // types; treat as "match nothing" rather than silently widening to everything.
  const sourceTypeWhere =
    sourceTypes === undefined
      ? sql``
      : sourceTypes.length === 0
        ? sql`AND 1 = 0`
        : sql`AND s.type IN ${sourceTypes}`;

  const orgChunks = chunkArray(orgIds, ID_CHUNK_SIZE).map(
    (chunk) => ["org" as const, chunk] as const,
  );
  const productChunks = chunkArray(productIds, ID_CHUNK_SIZE).map(
    (chunk) => ["product" as const, chunk] as const,
  );
  const allChunks = [...orgChunks, ...productChunks];

  if (allChunks.length === 1) {
    const [kind, chunk] = allChunks[0]!;
    return runFeedChunk(db, kind, chunk, cursor, prereleaseWhere, sourceTypeWhere, limit);
  }

  const chunkResults = await Promise.all(
    allChunks.map(([kind, chunk]) =>
      runFeedChunk(db, kind, chunk, cursor, prereleaseWhere, sourceTypeWhere, limit),
    ),
  );

  // Dedupe across (kind × chunk) — a release whose source belongs to a
  // product that is *itself* the org's only product would appear in both
  // branches when a collection pins both the org and the product. Keep the
  // first occurrence; the row content is the same either way.
  const seen = new Set<string>();
  const merged: CollectionReleaseRow[] = [];
  for (const row of chunkResults.flat()) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    merged.push(row);
  }

  // Re-sort to match the DB ORDER BY:
  //   dated rows (published_at IS NOT NULL) before undated, then
  //   published_at DESC, fetched_at DESC, id DESC
  merged.sort(compareRows);

  return merged.slice(0, limit);
}
