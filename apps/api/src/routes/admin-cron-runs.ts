/**
 * Admin-only routes for inspecting cron_runs history. Gated by authMiddleware
 * via the `admin/cron-runs` entry in workers/api/src/index.ts.
 */
import { Hono } from "hono";
import { and, asc, desc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { fetchLog } from "@buildinternet/releases-core/schema";
import { cronRuns } from "../db/schema-cron.js";
import { createDb } from "../db.js";
import { buildBareLimitEnvelope } from "../lib/pagination.js";
import { parseEnumParam, parseSortDir } from "../utils.js";
import { nullsLastOrderBy } from "../queries/shared.js";
import type { Env } from "../index.js";
import { respondError } from "../lib/error-response.js";
import { NotFoundError } from "@releases/lib/releases-error";

export const adminCronRunsRoutes = new Hono<Env>();

function getDb(c: any): any {
  return c.get("db") ?? createDb(c.env.DB);
}

const CRON_RUN_SORT_FIELDS = ["startedAt", "durationMs", "cronName"] as const;

adminCronRunsRoutes.get("/admin/cron-runs", async (c) => {
  const db = getDb(c);
  const cron = c.req.query("cron");
  const limit = Math.min(parseInt(c.req.query("limit") ?? "50", 10) || 50, 200);
  const statusCsv = c.req.query("status");
  const since = c.req.query("since");
  const sort = parseEnumParam(c.req.query("sort"), CRON_RUN_SORT_FIELDS, "startedAt");
  const dir = parseSortDir(c.req.query("dir"));

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

  const dirFn = dir === "asc" ? asc : desc;
  const orderBy: SQL[] =
    sort === "durationMs"
      ? [...nullsLastOrderBy(cronRuns.durationMs, dir), desc(cronRuns.startedAt)]
      : sort === "cronName"
        ? [dirFn(cronRuns.cronName), desc(cronRuns.startedAt)]
        : [dirFn(cronRuns.startedAt)];

  const rows = await db
    .select()
    .from(cronRuns)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(...orderBy)
    .limit(limit);

  if (c.req.query("envelope") === "true") return c.json(buildBareLimitEnvelope(rows, limit));
  return c.json(rows);
});

adminCronRunsRoutes.get("/admin/cron-runs/:id", async (c) => {
  const db = getDb(c);
  const id = c.req.param("id");

  const [run] = await db.select().from(cronRuns).where(eq(cronRuns.id, id));
  if (!run) return respondError(c, new NotFoundError());

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
