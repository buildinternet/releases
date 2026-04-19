import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { createDb } from "../db.js";
import { releaseSummaries, sources } from "@releases/core-internal/schema";
import { sourceWhere } from "../utils.js";
import type { Env } from "../index.js";

const app = new Hono<Env>();

// GET /summaries?sourceSlug=<slug> — get summaries for a source
app.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const sourceSlug = c.req.query("sourceSlug");
  const sourceId = c.req.query("sourceId");
  const type = c.req.query("type");
  const year = c.req.query("year");
  const month = c.req.query("month");

  let resolvedSourceId = sourceId;

  if (sourceSlug && !resolvedSourceId) {
    const [source] = await db
      .select({ id: sources.id })
      .from(sources)
      .where(sourceWhere(sourceSlug));
    if (!source) return c.json({ error: "Source not found" }, 404);
    resolvedSourceId = source.id;
  }

  if (!resolvedSourceId) {
    return c.json({ error: "sourceSlug or sourceId required" }, 400);
  }

  const conditions = [eq(releaseSummaries.sourceId, resolvedSourceId)];
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

// POST /summaries — upsert a summary
app.post("/", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json();

  const { sourceId, orgId, type, year, month, windowDays, summary, releaseCount } = body;

  if (!type || !summary || releaseCount == null) {
    return c.json({ error: "Missing required fields" }, 400);
  }

  await db
    .insert(releaseSummaries)
    .values({
      sourceId: sourceId ?? null,
      orgId: orgId ?? null,
      type,
      year: year ?? null,
      month: month ?? null,
      windowDays: windowDays ?? null,
      summary,
      releaseCount,
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
        summary,
        releaseCount,
        windowDays: windowDays ?? null,
        generatedAt: new Date().toISOString(),
      },
    });

  return c.json({ ok: true });
});

export default app;
