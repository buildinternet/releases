import { Hono } from "hono";
import { sql, gte, and, isNotNull } from "drizzle-orm";
import { createDb } from "../db.js";
import { usageLog } from "@releases/core-internal/schema";
import { daysAgoIso } from "@releases/core-internal/dates";
import type { Env } from "../index.js";

export const usageLogRoutes = new Hono<Env>();

usageLogRoutes.get("/usage-log/stats", async (c) => {
  const db = createDb(c.env.DB);
  const days = parseInt(c.req.query("days") ?? "7", 10);
  const since = daysAgoIso(days);

  const [[totals], byOperation, byModel, bySource] = await Promise.all([
    db
      .select({
        totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(usageLog)
      .where(gte(usageLog.createdAt, since)),

    db
      .select({
        label: usageLog.operation,
        totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(usageLog)
      .where(gte(usageLog.createdAt, since))
      .groupBy(usageLog.operation),

    db
      .select({
        label: usageLog.model,
        totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(usageLog)
      .where(gte(usageLog.createdAt, since))
      .groupBy(usageLog.model),

    db
      .select({
        label: usageLog.sourceSlug,
        totalInput: sql<number>`COALESCE(SUM(${usageLog.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${usageLog.outputTokens}), 0)`,
        count: sql<number>`COUNT(*)`,
      })
      .from(usageLog)
      .where(and(gte(usageLog.createdAt, since), isNotNull(usageLog.sourceSlug)))
      .groupBy(usageLog.sourceSlug),
  ]);

  return c.json({ totals, byOperation, byModel, bySource });
});

usageLogRoutes.post("/usage-log", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json();

  const [inserted] = await db
    .insert(usageLog)
    .values({
      operation: body.operation,
      model: body.model,
      inputTokens: body.inputTokens,
      outputTokens: body.outputTokens,
      sourceSlug: body.sourceSlug ?? null,
      releaseCount: body.releaseCount ?? null,
    })
    .returning();

  return c.json(inserted, 201);
});
