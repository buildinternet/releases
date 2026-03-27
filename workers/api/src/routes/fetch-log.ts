import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { createDb } from "../db.js";
import { fetchLog, sources } from "../../../../src/db/schema.js";
import type { Env } from "../index.js";

export const fetchLogRoutes = new Hono<Env>();

fetchLogRoutes.get("/fetch-log", async (c) => {
  const db = createDb(c.env.DB);
  const sourceSlug = c.req.query("source");
  const limit = parseInt(c.req.query("limit") ?? "20", 10);

  if (sourceSlug) {
    const [src] = await db.select().from(sources).where(eq(sources.slug, sourceSlug));
    if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

    const logs = await db
      .select()
      .from(fetchLog)
      .where(eq(fetchLog.sourceId, src.id))
      .orderBy(desc(fetchLog.createdAt))
      .limit(limit);
    return c.json(logs);
  }

  const logs = await db
    .select()
    .from(fetchLog)
    .orderBy(desc(fetchLog.createdAt))
    .limit(limit);
  return c.json(logs);
});
