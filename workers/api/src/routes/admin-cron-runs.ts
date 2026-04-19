/**
 * Admin-only routes for inspecting cron_runs history. Gated by authMiddleware
 * via the `admin/cron-runs` entry in workers/api/src/index.ts.
 */
import { Hono } from "hono";
import { and, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { fetchLog } from "@releases/core-internal/schema";
import { cronRuns } from "../db/schema-cron.js";
import { createDb } from "../db.js";
import type { Env } from "../index.js";

export const adminCronRunsRoutes = new Hono<Env>();

function getDb(c: any): any {
  return c.get("db") ?? createDb(c.env.DB);
}

adminCronRunsRoutes.get("/v1/admin/cron-runs", async (c) => {
  const db = getDb(c);
  const cron = c.req.query("cron");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const statusCsv = c.req.query("status");
  const since = c.req.query("since");

  const conditions: any[] = [];
  if (cron) conditions.push(eq(cronRuns.cronName, cron));
  if (statusCsv) {
    const statuses = statusCsv
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (statuses.length > 0) conditions.push(inArray(cronRuns.status, statuses as any));
  }
  if (since) {
    conditions.push(gt(cronRuns.startedAt, since));
  } else {
    const thirtyDaysAgo = new Date(Date.now() - 30 * 86400_000).toISOString();
    conditions.push(gt(cronRuns.startedAt, thirtyDaysAgo));
  }

  const rows = await db
    .select()
    .from(cronRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(cronRuns.startedAt))
    .limit(limit);

  return c.json(rows);
});

adminCronRunsRoutes.get("/v1/admin/cron-runs/:id", async (c) => {
  const db = getDb(c);
  const id = c.req.param("id");

  const [run] = await db.select().from(cronRuns).where(eq(cronRuns.id, id));
  if (!run) return c.json({ error: "not_found" }, 404);

  const sessionIds: string[] = run.sessionsStarted ? JSON.parse(run.sessionsStarted) : [];
  const sessionBreakdown: Record<string, Record<string, number>> = {};

  if (sessionIds.length > 0) {
    const logs = await db
      .select({
        sessionId: fetchLog.sessionId,
        status: fetchLog.status,
        count: sql<number>`count(*)`,
      })
      .from(fetchLog)
      .where(inArray(fetchLog.sessionId, sessionIds))
      .groupBy(fetchLog.sessionId, fetchLog.status);

    for (const row of logs) {
      if (!row.sessionId) continue;
      (sessionBreakdown[row.sessionId] ??= {})[row.status] = Number(row.count);
    }
  }

  return c.json({ run, sessionBreakdown });
});
