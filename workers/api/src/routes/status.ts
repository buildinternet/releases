import { Hono } from "hono";
import { and, desc, eq, sql, gte, lte } from "drizzle-orm";
import { createDb } from "../db.js";
import { fetchLog, sources, organizations, usageLog } from "@releases/core/schema";
import type { Env } from "../index.js";
import { getStatusHub } from "../utils.js";

export const statusRoutes = new Hono<Env>();

statusRoutes.get("/status/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  return getStatusHub(c.env).fetch(c.req.raw);
});

statusRoutes.get("/status/fetch-log", async (c) => {
  const db = createDb(c.env.DB);
  const limit = parseInt(c.req.query("limit") ?? "200", 10);
  const after = c.req.query("after");   // ISO date string
  const before = c.req.query("before"); // ISO date string
  const org = c.req.query("org");       // org slug filter

  const conditions = [];
  if (after) conditions.push(gte(fetchLog.createdAt, after));
  if (before) conditions.push(lte(fetchLog.createdAt, before));
  if (org) conditions.push(eq(organizations.slug, org));

  const logs = await db
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
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(fetchLog.createdAt))
    .limit(limit);

  return c.json(logs);
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
  await getStatusHub(c.env).fetch(new Request("https://do/event", {
    method: "POST",
    body: JSON.stringify(event),
    headers: { "Content-Type": "application/json" },
  }));
  return c.json({ ok: true });
});
