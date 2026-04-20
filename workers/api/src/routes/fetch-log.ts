import { Hono } from "hono";
import { eq, desc } from "drizzle-orm";
import { createDb } from "../db.js";
import { fetchLog, sources } from "@buildinternet/releases-core/schema";
import { sourceWhere } from "../utils.js";
import type { Env } from "../index.js";

export const fetchLogRoutes = new Hono<Env>();

fetchLogRoutes.get("/fetch-log", async (c) => {
  const db = createDb(c.env.DB);
  const sourceSlug = c.req.query("source");
  const limit = parseInt(c.req.query("limit") ?? "20", 10);

  if (sourceSlug) {
    const [src] = await db.select().from(sources).where(sourceWhere(sourceSlug));
    if (!src) return c.json({ error: "not_found", message: "Source not found" }, 404);

    const logs = await db
      .select()
      .from(fetchLog)
      .where(eq(fetchLog.sourceId, src.id))
      .orderBy(desc(fetchLog.createdAt))
      .limit(limit);
    return c.json(logs);
  }

  const logs = await db.select().from(fetchLog).orderBy(desc(fetchLog.createdAt)).limit(limit);
  return c.json(logs);
});

fetchLogRoutes.post("/fetch-log", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json();

  let inserted;
  try {
    [inserted] = await db.insert(fetchLog).values(body).returning();
  } catch {
    return c.json({ error: "insert_failed", message: "Failed to insert fetch log" }, 500);
  }

  // Best-effort notify StatusHub for live dashboard
  if (c.env.STATUS_HUB) {
    try {
      // Resolve source name for the dashboard display
      let sourceName: string | undefined;
      let sourceSlug: string | undefined;
      if (body.sourceId) {
        const [src] = await db
          .select({ name: sources.name, slug: sources.slug })
          .from(sources)
          .where(eq(sources.id, body.sourceId));
        sourceName = src?.name;
        sourceSlug = src?.slug;
      }

      const id = c.env.STATUS_HUB.idFromName("global");
      const stub = c.env.STATUS_HUB.get(id);
      await stub.fetch(
        new Request("https://do/event", {
          method: "POST",
          body: JSON.stringify({
            type: "fetch:complete",
            id: inserted.id,
            sourceId: body.sourceId,
            sessionId: body.sessionId ?? null,
            sourceName,
            sourceSlug,
            releasesFound: body.releasesFound,
            releasesInserted: body.releasesInserted,
            durationMs: body.durationMs,
            status: body.status,
            error: body.error,
            createdAt: inserted.createdAt,
          }),
          headers: { "Content-Type": "application/json" },
        }),
      );
    } catch {
      // Dashboard notification is best-effort
    }
  }

  return c.json(inserted, 201);
});
