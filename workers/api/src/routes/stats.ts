import { Hono } from "hono";
import { count } from "drizzle-orm";
import { createDb } from "../db.js";
import { organizations, sources, releases } from "../../../../src/db/schema.js";
import type { Env } from "../index.js";

export const statsRoutes = new Hono<Env>();

statsRoutes.get("/stats", async (c) => {
  const db = createDb(c.env.DB);
  const [orgCount] = await db.select({ n: count() }).from(organizations);
  const [sourceCount] = await db.select({ n: count() }).from(sources);
  const [releaseCount] = await db.select({ n: count() }).from(releases);
  return c.json({ orgs: orgCount.n, sources: sourceCount.n, releases: releaseCount.n });
});
