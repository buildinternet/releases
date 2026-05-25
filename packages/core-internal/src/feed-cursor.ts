import { sql, type SQL } from "drizzle-orm";
import type { ReleaseType } from "@buildinternet/releases-core/schema";

/**
 * Shared cursor primitives for cross-org release feeds (collections,
 * categories, future aggregations). Keeping these in one place guarantees
 * every surface tie-breaks on `published_at, fetched_at, id` identically —
 * a divergence here would let the same cursor produce different next-pages
 * across surfaces.
 */

// Structural shim so this module doesn't need @cloudflare/workers-types.
// Both workers' Drizzle handles satisfy this — `db.all(sql`…`)` is the only
// surface used here.
export interface FeedQueryRunner {
  all<T = unknown>(query: SQL): Promise<T[]>;
}

/** Row shape returned by every cross-org feed query. */
export type AggregateReleaseRow = {
  id: string;
  version: string | null;
  title: string;
  content: string;
  summary: string | null;
  /**
   * Cached `LENGTH(content)` / token count (#958). Optional because not every
   * cross-org feed query selects them; feed renderers degrade gracefully when
   * absent.
   */
  content_chars?: number | null;
  content_tokens?: number | null;
  title_generated: string | null;
  title_short: string | null;
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
  /**
   * Org identity for cross-org feed surfaces (e.g. the MCP release-feed UI's
   * company icon). Optional because not every cross-org query selects them.
   * `org_avatar_url` is the stored R2/3rd-party avatar; `org_github_handle` is
   * the first linked GitHub account, used as the avatar fallback.
   */
  org_avatar_url?: string | null;
  org_github_handle?: string | null;
  product_slug: string | null;
  product_name: string | null;
  /** Number of demoted siblings rolling up via `release_coverage` (0 when standalone). */
  coverage_count: number;
};

/**
 * Encode the last row of a page into the wire cursor format
 * `publishedAt|fetchedAt|id`. Always 3 parts (publishedAt empty when null)
 * so the parser knows whether to apply the null-tail branch.
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
 *
 * The ORDER BY puts non-null `published_at` rows before nulls (CASE on
 * IS NOT NULL), so the null-tail rules differ by which side the cursor sits on:
 *
 * - Dated cursor (`pub|fet|id`, `pub|id`, or `pub`): match any null-published
 *   row plus any dated row that lex-sorts after the cursor. Without the
 *   `r.published_at IS NULL OR …` arm, paginating past the last dated row
 *   would silently drop every undated release.
 * - Null-tail cursor (`|fet|id`, `|id`): restrict to null-published rows —
 *   every dated row already came before the cursor in the ORDER BY.
 *
 * Legacy 2-part `publishedAt|id` cursors still parse (degrade to the prior
 * tie-break-on-id shape).
 */
export function feedCursorSql(cursorParam: string | null): SQL {
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
