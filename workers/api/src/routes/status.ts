import { Hono } from "hono";
import { and, desc, eq, sql, gte, lte } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  FETCH_LOG_STATUSES,
  type FetchLogStatus,
  fetchLog,
  sources,
  organizations,
  usageLog,
} from "@buildinternet/releases-core/schema";
import type { Env } from "../index.js";
import { getStatusHub } from "../utils.js";
import { encodeCursor, decodeCursor } from "./fetch-log-cursor.js";

export const statusRoutes = new Hono<Env>();

statusRoutes.get("/status/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  return getStatusHub(c.env).fetch(c.req.raw);
});

statusRoutes.get("/status/fetch-log", async (c) => {
  const db = createDb(c.env.DB);
  const rawLimit = parseInt(c.req.query("limit") ?? "25", 10);
  const limit = Math.min(Math.max(Number.isFinite(rawLimit) ? rawLimit : 25, 1), 100);
  const after = c.req.query("after");
  const before = c.req.query("before");
  const org = c.req.query("org");
  const statusParam = c.req.query("status");
  const status = (FETCH_LOG_STATUSES as readonly string[]).includes(statusParam ?? "")
    ? (statusParam as FetchLogStatus)
    : undefined;
  const cursorToken = c.req.query("cursor");
  const cursor = cursorToken ? decodeCursor(cursorToken) : null;

  // Scope predicates — apply to both counts and the page.
  const scope = [];
  if (after) scope.push(gte(fetchLog.createdAt, after));
  if (before) scope.push(lte(fetchLog.createdAt, before));
  if (org) scope.push(eq(organizations.slug, org));

  // Page predicates add status and cursor.
  const pagePredicates = [...scope];
  if (status) pagePredicates.push(eq(fetchLog.status, status));
  if (cursor) {
    pagePredicates.push(
      sql`(${fetchLog.createdAt}, ${fetchLog.id}) < (${cursor.createdAt}, ${cursor.id})`,
    );
  }

  const rows = await db
    .select({
      id: fetchLog.id,
      sourceId: fetchLog.sourceId,
      sessionId: fetchLog.sessionId,
      sourceName: sources.name,
      sourceSlug: sources.slug,
      orgName: organizations.name,
      orgSlug: organizations.slug,
      releasesFound: fetchLog.releasesFound,
      releasesInserted: fetchLog.releasesInserted,
      durationMs: fetchLog.durationMs,
      status: fetchLog.status,
      error: fetchLog.error,
      rawContent: fetchLog.rawContent,
      createdAt: fetchLog.createdAt,
    })
    .from(fetchLog)
    .leftJoin(sources, sql`${fetchLog.sourceId} = ${sources.id}`)
    .leftJoin(organizations, sql`${sources.orgId} = ${organizations.id}`)
    .where(pagePredicates.length > 0 ? and(...pagePredicates) : undefined)
    .orderBy(desc(fetchLog.createdAt), desc(fetchLog.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const entries = hasMore ? rows.slice(0, limit) : rows;
  const last = entries[entries.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt, id: last.id }) : null;

  // Count query runs only on the first page (no cursor). The grouped
  // rollup gives us both the per-status counts and the scope-wide total.
  let totalCount: number | undefined;
  let statusCounts: Record<FetchLogStatus, number> | undefined;
  if (!cursor) {
    const grouped = await db
      .select({ status: fetchLog.status, n: sql<number>`count(*)` })
      .from(fetchLog)
      .leftJoin(sources, sql`${fetchLog.sourceId} = ${sources.id}`)
      .leftJoin(organizations, sql`${sources.orgId} = ${organizations.id}`)
      .where(scope.length > 0 ? and(...scope) : undefined)
      .groupBy(fetchLog.status);

    statusCounts = Object.fromEntries(FETCH_LOG_STATUSES.map((s) => [s, 0])) as Record<
      FetchLogStatus,
      number
    >;
    totalCount = 0;
    for (const row of grouped) {
      const n = Number(row.n);
      totalCount += n;
      statusCounts[row.status as FetchLogStatus] = n;
    }
  }

  return c.json({ entries, nextCursor, totalCount, statusCounts });
});

statusRoutes.get("/status/usage", async (c) => {
  const db = createDb(c.env.DB);
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);

  const rows = await db
    .select({
      model: usageLog.model,
      totalInput: sql<number>`sum(${usageLog.inputTokens})`,
      totalOutput: sql<number>`sum(${usageLog.outputTokens})`,
    })
    .from(usageLog)
    .where(gte(usageLog.createdAt, todayStart.toISOString()))
    .groupBy(usageLog.model);

  return c.json(rows);
});

statusRoutes.post("/status/event", async (c) => {
  const event = await c.req.json();
  await getStatusHub(c.env).fetch(
    new Request("https://do/event", {
      method: "POST",
      body: JSON.stringify(event),
      headers: { "Content-Type": "application/json" },
    }),
  );
  return c.json({ ok: true });
});
