import { Hono } from "hono";
import { desc, sql, gte } from "drizzle-orm";
import { createDb } from "../db.js";
import { fetchLog, sources, usageLog } from "../../../../src/db/schema.js";
import { devModeMiddleware } from "../middleware/dev-mode.js";
import type { Env } from "../index.js";

export const statusRoutes = new Hono<Env>();

function getStatusHub(env: Env["Bindings"]) {
  return env.STATUS_HUB.get(env.STATUS_HUB.idFromName("global"));
}

statusRoutes.use("/*", devModeMiddleware);

statusRoutes.get("/status/ws", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.text("Expected WebSocket upgrade", 426);
  }
  return getStatusHub(c.env).fetch(c.req.raw);
});

statusRoutes.get("/status/sessions", async (c) => {
  const res = await getStatusHub(c.env).fetch(new Request("https://do/sessions"));
  const sessions = await res.json();
  return c.json(sessions);
});

statusRoutes.get("/status/fetch-log", async (c) => {
  const db = createDb(c.env.DB);
  const limit = parseInt(c.req.query("limit") ?? "50", 10);

  const logs = await db
    .select({
      id: fetchLog.id,
      sourceId: fetchLog.sourceId,
      sourceName: sources.name,
      sourceSlug: sources.slug,
      releasesFound: fetchLog.releasesFound,
      releasesInserted: fetchLog.releasesInserted,
      durationMs: fetchLog.durationMs,
      status: fetchLog.status,
      error: fetchLog.error,
      createdAt: fetchLog.createdAt,
    })
    .from(fetchLog)
    .leftJoin(sources, sql`${fetchLog.sourceId} = ${sources.id}`)
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
