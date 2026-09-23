import { and, desc, eq, gt, isNull, not, like, or, sql, type SQL } from "drizzle-orm";
import { searchQueries } from "@buildinternet/releases-core/schema";

export type TopSearchRow = {
  query: string;
  count: number;
  lastSeen: number;
};

export type BotsMode = "exclude" | "include" | "only";

// NULL/empty UA + known bot patterns. Named bots (Googlebot, bingbot, etc.)
// all match the generic `%bot%` substring.
const BOT_UA_PATTERNS = ["%bot%", "%crawl%", "%spider%", "%slurp%"] as const;

export function buildBotCondition(mode: BotsMode): SQL | null {
  if (mode === "include") return null;
  const patternMatches = BOT_UA_PATTERNS.map((p) => like(searchQueries.userAgent, p));
  const isBotRow = or(
    isNull(searchQueries.userAgent),
    eq(searchQueries.userAgent, ""),
    ...patternMatches,
  ) as SQL;
  return mode === "only" ? isBotRow : not(isBotRow);
}

export interface TopSearchesOptions {
  /** Unix-epoch milliseconds; rows with `timestamp > since` are included. */
  since: number;
  /** Maximum number of rows to return. Defaults to 20. */
  limit?: number;
  /**
   * Bot/crawler filtering mode. Defaults to `"exclude"`.
   * `"only"` returns bot-only rows; `"include"` skips the filter entirely.
   */
  botsMode?: BotsMode;
  /** Narrow to a single search surface (`web`, `mcp`, `api`). */
  surface?: string;
}

/**
 * `db` is typed `any` so this helper accepts both the D1 drizzle instance and
 * the bun:sqlite drizzle used in tests — the consuming code owns the concrete
 * type.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function getTopSearchQueries(
  db: any,
  opts: TopSearchesOptions,
): Promise<TopSearchRow[]> {
  const limit = opts.limit ?? 20;
  const botsMode = opts.botsMode ?? "exclude";

  const conditions: SQL[] = [gt(searchQueries.timestamp, opts.since)];
  if (opts.surface) conditions.push(eq(searchQueries.surface, opts.surface));
  const bc = buildBotCondition(botsMode);
  if (bc) conditions.push(bc);

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
