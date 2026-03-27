import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { ignoredUrls } from "../../../../src/db/schema.js";
import type { Env } from "../index.js";

export const ignoreRoutes = new Hono<Env>();

ignoreRoutes.get("/ignore", async (c) => {
  const db = createDb(c.env.DB);
  const orgId = c.req.query("orgId");

  if (orgId) {
    const rows = await db.select().from(ignoredUrls).where(eq(ignoredUrls.orgId, orgId));
    return c.json(rows);
  }

  const rows = await db.select().from(ignoredUrls);
  return c.json(rows);
});

ignoreRoutes.post("/ignore", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ url: string; orgId?: string; reason?: string }>();

  if (!body.url) return c.json({ error: "bad_request", message: "Missing required field: url" }, 400);

  await db
    .insert(ignoredUrls)
    .values({
      url: body.url,
      orgId: body.orgId ?? null,
      reason: body.reason ?? null,
      ignoredAt: new Date().toISOString(),
    })
    .onConflictDoNothing();

  return c.json({ ignored: true }, 201);
});

ignoreRoutes.delete("/ignore/:url", async (c) => {
  const db = createDb(c.env.DB);
  const url = decodeURIComponent(c.req.param("url"));

  await db.delete(ignoredUrls).where(eq(ignoredUrls.url, url));
  return c.json({ deleted: true });
});
