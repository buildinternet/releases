/**
 * Shared helper for fetching top search queries grouped by text.
 * Used by both the admin route (`GET /v1/admin/search-queries/top`) and the
 * nightly sweep email so both callers share the same SQL and bot-filtering
 * logic without going through an HTTP hop.
 */
import { and, desc, gt, isNull, not, like, or, eq, sql, type SQL } from "drizzle-orm";
import { searchQueries } from "@buildinternet/releases-core/schema";

export type TopSearchRow = {
  query: string;
  count: number;
  lastSeen: number;
};

/** Known bot/crawler UA substrings — mirrors the admin route's BOT_UA_PATTERNS. */
const BOT_UA_PATTERNS = ["%bot%", "%crawl%", "%spider%", "%slurp%"] as const;

/**
 * Returns a SQL predicate that excludes bot rows (NULL/empty UA or matching a
 * known bot pattern). Pass `false` to include all rows (no filter applied).
 */
function buildBotExcludeCondition(): SQL {
  const patternMatches = BOT_UA_PATTERNS.map((p) => like(searchQueries.userAgent, p));
  const isBotRow = or(
    isNull(searchQueries.userAgent),
    eq(searchQueries.userAgent, ""),
    ...patternMatches,
  ) as SQL;
  return not(isBotRow);
}

export interface TopSearchesOptions {
  /** Unix-epoch milliseconds; rows with `timestamp > since` are included. */
  since: number;
  /** Maximum number of rows to return. Defaults to 20. */
  limit?: number;
  /** Whether to exclude bot/crawler rows. Defaults to `true`. */
  excludeBots?: boolean;
}

/**
 * Fetch the top search queries grouped by text, ordered by count desc.
 * `db` is typed `any` so this helper accepts both the D1 drizzle instance and
 * the bun:sqlite drizzle used in tests — the consuming code owns the concrete
 * type. Matches the convention used in `sweep-results.ts`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getTopSearchQueries(
  db: any,
  opts: TopSearchesOptions,
): Promise<TopSearchRow[]> {
  const limit = opts.limit ?? 20;
  const excludeBots = opts.excludeBots ?? true;

  const conditions: SQL[] = [gt(searchQueries.timestamp, opts.since)];
  if (excludeBots) {
    conditions.push(buildBotExcludeCondition());
  }

  const countExpr = sql<number>`count(*)`.as("count");
  const rows = await db
    .select({
      query: searchQueries.query,
      count: countExpr,
      lastSeen: sql<number>`max(${searchQueries.timestamp})`.as("lastSeen"),
    })
    .from(searchQueries)
    .where(and(...conditions))
    .groupBy(searchQueries.query)
    .orderBy(desc(countExpr))
    .limit(limit);

  return rows as TopSearchRow[];
}
