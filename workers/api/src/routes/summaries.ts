import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { createDb } from "../db.js";
import { releaseSummaries, sources } from "@buildinternet/releases-core/schema";
import { sourceMatchByIdOrSlug } from "../utils.js";
import type { Env } from "../index.js";

const app = new Hono<Env>();

app.get("/sources/:slug/summaries", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const type = c.req.query("type");
  const year = c.req.query("year");
  const month = c.req.query("month");

  const [source] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(sourceMatchByIdOrSlug(slug));
  if (!source) return c.json({ error: "Source not found" }, 404);

  const conditions = [eq(releaseSummaries.sourceId, source.id)];
  if (type) conditions.push(eq(releaseSummaries.type, type as "rolling" | "monthly"));
  if (year) conditions.push(eq(releaseSummaries.year, parseInt(year)));
  if (month) conditions.push(eq(releaseSummaries.month, parseInt(month)));

  const rows = await db
    .select()
    .from(releaseSummaries)
    .where(and(...conditions))
    .orderBy(desc(releaseSummaries.generatedAt));

  return c.json(rows);
});

app.post("/sources/:slug/summaries", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{
    type: "rolling" | "monthly";
    year?: number | null;
    month?: number | null;
    windowDays?: number | null;
    summary: string;
    releaseCount: number;
  }>();

  if (!body.type || !body.summary || body.releaseCount == null) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  const [source] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(sourceMatchByIdOrSlug(slug));
  if (!source) return c.json({ error: "Source not found" }, 404);

  await db
    .insert(releaseSummaries)
    .values({
      sourceId: source.id,
      orgId: null,
      type: body.type,
      year: body.year ?? null,
      month: body.month ?? null,
      windowDays: body.windowDays ?? null,
      summary: body.summary,
      releaseCount: body.releaseCount,
    })
    .onConflictDoUpdate({
      target: [
        releaseSummaries.sourceId,
        releaseSummaries.orgId,
        releaseSummaries.type,
        releaseSummaries.year,
        releaseSummaries.month,
      ],
      set: {
        summary: body.summary,
        releaseCount: body.releaseCount,
        windowDays: body.windowDays ?? null,
        generatedAt: new Date().toISOString(),
      },
    });

  return c.json({ ok: true });
});

export default app;
