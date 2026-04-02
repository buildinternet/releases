import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { createDb } from "../db.js";
import type { Env } from "../index.js";

export const searchRoutes = new Hono<Env>();

searchRoutes.get("/search", async (c) => {
  const q = c.req.query("q") ?? "";
  if (!q) {
    return c.json({ error: "bad_request", message: "Missing required query parameter: q" }, 400);
  }

  const limit = parseInt(c.req.query("limit") ?? "20", 10);
  const offset = parseInt(c.req.query("offset") ?? "0", 10);
  const db = createDb(c.env.DB);

  let results;
  try {
    results = await db.all(sql`
      SELECT
        r.id as id,
        s.id as sourceId,
        s.slug as sourceSlug,
        s.name as sourceName,
        o.slug as orgSlug,
        r.version,
        r.title,
        COALESCE(r.content_summary, SUBSTR(r.content, 1, 150)) as summary,
        r.published_at as publishedAt
      FROM releases_fts
      JOIN releases r ON r.rowid = releases_fts.rowid
      JOIN sources s ON s.id = r.source_id
      LEFT JOIN organizations o ON o.id = s.org_id
      WHERE releases_fts MATCH ${q}
        AND (r.suppressed IS NULL OR r.suppressed = 0)
      ORDER BY rank
      LIMIT ${limit}
      OFFSET ${offset}
    `);
  } catch {
    return c.json({ error: "invalid_query", message: "Invalid search query syntax" }, 400);
  }

  return c.json({ query: q, results });
});
