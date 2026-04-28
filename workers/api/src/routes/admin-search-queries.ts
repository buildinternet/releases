/**
 * Admin-only routes for inspecting `search_queries` — the per-call log of
 * what users actually typed into `/v1/search` and the MCP `search`/
 * `search_releases`/`search_registry` tools. Gated by `authMiddleware` via
 * the `admin/search-queries` entry in workers/api/src/index.ts.
 *
 * Two endpoints:
 *   GET /admin/search-queries        — paginated raw rows (newest first)
 *   GET /admin/search-queries/top    — top queries grouped by text
 *
 * Both endpoints accept `?bots=exclude|include|only` (default: exclude) to
 * filter rows by `user_agent`. Bot detection uses substring matching on
 * `bot`, `crawl`, `spider`, `slurp` plus a NULL/empty-UA check.
 */
import { Hono } from "hono";
import { and, desc, eq, gt, isNull, not, like, or, sql, type SQL } from "drizzle-orm";
import { searchQueries, SEARCH_SURFACES } from "@buildinternet/releases-core/schema";
import { createDb } from "../db.js";
import type { Env } from "../index.js";

export const adminSearchQueriesRoutes = new Hono<Env>();

// Matches the test-injection pattern in workers/api/src/routes/admin-cron-runs.ts;
// real routes get a fresh drizzle handle, tests inject their own via c.set("db", ...).
function getDb(c: any): any {
  return c.get("db") ?? createDb(c.env.DB);
}

function parseSurface(v: string | undefined): string | null {
  if (!v) return null;
  return (SEARCH_SURFACES as readonly string[]).includes(v) ? v : null;
}

function parseLimit(raw: string | undefined): number {
  const parsed = parseInt(raw ?? "", 10);
  const fallback = Number.isFinite(parsed) ? parsed : 100;
  return Math.max(1, Math.min(fallback, 500));
}

const DEFAULT_WINDOW_MS = 7 * 86_400_000;

/**
 * Known bot/crawler substrings used for UA filtering.
 * Named bots (Googlebot, bingbot, etc.) all match the generic `bot` substring,
 * so we keep only the four minimal patterns that cover the full heuristic list.
 * The empty-UA case is handled separately via `isNull`.
 *
 * Full named list for documentation / future tuning:
 *   Googlebot, bingbot, AhrefsBot, SemrushBot, MJ12bot, DuckDuckBot,
 *   BLEXBot, DotBot, PetalBot — all caught by `%bot%`.
 */
const BOT_UA_PATTERNS = ["%bot%", "%crawl%", "%spider%", "%slurp%"] as const;

type BotsParam = "exclude" | "include" | "only";

function parseBots(raw: string | undefined): BotsParam | null {
  if (!raw || raw === "exclude") return "exclude";
  if (raw === "include") return "include";
  if (raw === "only") return "only";
  return null; // invalid value → caller returns 400
}

/**
 * Returns a SQL predicate that keeps only bot rows (`only`), excludes them
 * (`exclude`), or returns nothing extra (`include` — caller omits the condition).
 */
function botCondition(mode: BotsParam): SQL | null {
  if (mode === "include") return null;

  // A row is a "bot" if its UA is NULL/empty or matches any of the substring patterns.
  const patternMatches = BOT_UA_PATTERNS.map((p) => like(searchQueries.userAgent, p));
  const isBotRow = or(
    isNull(searchQueries.userAgent),
    eq(searchQueries.userAgent, ""),
    ...patternMatches,
  ) as SQL;

  return mode === "only" ? isBotRow : not(isBotRow);
}

/**
 * Accepts `7d` / `12h` / `30m` shorthand or an absolute ISO-8601 string.
 * Bare integers are intentionally rejected — `since=1000` is ambiguous
 * (1000 ms past epoch, or "1 second ago"?) and the wrong reading silently
 * returns every row.
 */
function parseSinceMs(raw: string | undefined): number {
  if (!raw) return Date.now() - DEFAULT_WINDOW_MS;
  const m = raw.match(/^(\d+)([dhm])$/i);
  if (m) {
    const n = parseInt(m[1], 10);
    const unit = m[2].toLowerCase();
    const factor = unit === "d" ? 86_400_000 : unit === "h" ? 3_600_000 : 60_000;
    return Date.now() - n * factor;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : Date.now() - DEFAULT_WINDOW_MS;
}

adminSearchQueriesRoutes.get("/admin/search-queries", async (c) => {
  const db = getDb(c);
  const limit = parseLimit(c.req.query("limit"));
  const surface = parseSurface(c.req.query("surface"));
  const since = parseSinceMs(c.req.query("since") ?? undefined);
  const botsMode = parseBots(c.req.query("bots"));
  if (botsMode === null) {
    return c.json(
      { error: "invalid_param", message: "bots must be exclude, include, or only" },
      400,
    );
  }

  const conditions: SQL[] = [gt(searchQueries.timestamp, since)];
  if (surface) conditions.push(eq(searchQueries.surface, surface));
  const bc = botCondition(botsMode);
  if (bc) conditions.push(bc);

  const rows = await db
    .select()
    .from(searchQueries)
    .where(and(...conditions))
    .orderBy(desc(searchQueries.timestamp))
    .limit(limit);

  return c.json(rows);
});

adminSearchQueriesRoutes.get("/admin/search-queries/top", async (c) => {
  const db = getDb(c);
  const limit = parseLimit(c.req.query("limit"));
  const surface = parseSurface(c.req.query("surface"));
  const since = parseSinceMs(c.req.query("since") ?? undefined);
  const botsMode = parseBots(c.req.query("bots"));
  if (botsMode === null) {
    return c.json(
      { error: "invalid_param", message: "bots must be exclude, include, or only" },
      400,
    );
  }

  const conditions: SQL[] = [gt(searchQueries.timestamp, since)];
  if (surface) conditions.push(eq(searchQueries.surface, surface));
  const bc = botCondition(botsMode);
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

  return c.json(rows);
});
