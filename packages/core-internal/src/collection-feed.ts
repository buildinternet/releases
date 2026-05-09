import { sql, type SQL } from "drizzle-orm";
import type { ReleaseType } from "@buildinternet/releases-core/schema";

// Structural shim so this module doesn't need @cloudflare/workers-types.
// Both workers' Drizzle handles satisfy this — `db.all(sql`…`)` is the only
// surface used here.
interface FeedQueryRunner {
  all<T = unknown>(query: SQL): Promise<T[]>;
}

export type CollectionReleaseRow = {
  id: string;
  version: string | null;
  title: string;
  content: string;
  content_summary: string | null;
  content_title: string | null;
  content_title_short: string | null;
  published_at: string | null;
  fetched_at: string;
  url: string | null;
  media: string | null;
  prerelease: 0 | 1;
  source_slug: string;
  source_name: string;
  source_type: string;
  type: ReleaseType;
  org_slug: string;
  org_name: string;
  product_slug: string | null;
  product_name: string | null;
};

/**
 * Build a release-feed cursor from the last row on the current page. Wire
 * format: `publishedAt|fetchedAt|id` — always 3 parts, with `publishedAt`
 * empty when null. Encodes the full sort key so same-`publishedAt` ties
 * tie-break on `fetched_at` then `id`, matching the ORDER BY in
 * {@link getCollectionReleasesFeed}.
 */
export function buildFeedCursor(last: {
  published_at: string | null;
  fetched_at: string;
  id: string;
}): string {
  return `${last.published_at ?? ""}|${last.fetched_at}|${last.id}`;
}

/**
 * Drizzle-flavored cursor parser scoped to alias `r` on the releases table.
 * Wire format matches {@link buildFeedCursor} and the raw-D1 `parseFeedCursor`
 * used by single-source / single-org feeds, so the same web cursor parser
 * works on every surface.
 *
 * The ORDER BY puts non-null `published_at` rows before nulls (see CASE
 * expression in {@link getCollectionReleasesFeed}), so the null-tail rules
 * differ by which side the cursor sits on:
 *
 * - Dated cursor (`pub|fet|id`, `pub|id`, or `pub`): match any null-published
 *   row plus any dated row that lex-sorts after the cursor. Without the
 *   `r.published_at IS NULL OR …` arm, paginating past the last dated row
 *   would silently drop every undated release.
 * - Null-tail cursor (`|fet|id`, `|id`): restrict to null-published rows —
 *   every dated row already came before the cursor in the ORDER BY.
 *
 * Legacy 2-part `publishedAt|id` cursors from in-flight paginators still
 * parse (they degrade to the prior tie-break-on-id shape).
 */
function feedCursorSql(cursorParam: string | null): SQL {
  if (!cursorParam) return sql``;
  const parts = cursorParam.split("|");

  if (parts.length === 3) {
    const [pub, fet, id] = parts;
    if (pub && fet && id) {
      return sql`AND (r.published_at IS NULL OR (r.published_at < ${pub}) OR (r.published_at = ${pub} AND r.fetched_at < ${fet}) OR (r.published_at = ${pub} AND r.fetched_at = ${fet} AND r.id < ${id}))`;
    }
    if (!pub && fet && id) {
      return sql`AND (r.published_at IS NULL AND ((r.fetched_at < ${fet}) OR (r.fetched_at = ${fet} AND r.id < ${id})))`;
    }
  }

  if (parts.length === 2) {
    const [pub, id] = parts;
    if (pub && id) {
      return sql`AND (r.published_at IS NULL OR (r.published_at < ${pub}) OR (r.published_at = ${pub} AND r.id < ${id}))`;
    }
    // Legacy `|id` shape — no fetched_at to tie-break on, so accept any
    // null-published row whose id is smaller. Slightly weaker than the
    // 3-part shape; only reachable from in-flight pre-#806 cursors.
    if (!pub && id) return sql`AND (r.published_at IS NULL AND r.id < ${id})`;
  }

  if (parts.length === 1 && parts[0]) {
    return sql`AND (r.published_at IS NULL OR r.published_at < ${parts[0]})`;
  }
  return sql``;
}

/**
 * Multi-org release feed for a collection. Used by both the REST handler
 * (`GET /v1/collections/:slug/releases`) and the MCP `get_collection_releases`
 * tool — sharing the query keeps ordering and cursor semantics in lock-step
 * across surfaces.
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

  return db.all<CollectionReleaseRow>(sql`
    SELECT r.id, r.version, r.title, r.content, r.content_summary,
           r.content_title, r.content_title_short, r.type,
           r.published_at, r.fetched_at, r.url, r.media, r.prerelease,
           s.slug AS source_slug, s.name AS source_name, s.type AS source_type,
           o.slug AS org_slug, o.name AS org_name,
           p.slug AS product_slug, p.name AS product_name
    FROM releases_visible r
    INNER JOIN sources_active s ON s.id = r.source_id
    INNER JOIN organizations_active o ON o.id = s.org_id
    LEFT JOIN products_active p ON p.id = s.product_id
    WHERE s.org_id IN ${orgIds}
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
