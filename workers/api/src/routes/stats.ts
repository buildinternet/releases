import { Hono } from "hono";
import { count } from "drizzle-orm";
import { createDb } from "../db.js";
import { organizations, sources, releases, products } from "@releases/core/schema";
import type { Env } from "../index.js";

export const statsRoutes = new Hono<Env>();

statsRoutes.get("/stats", async (c) => {
  const db = createDb(c.env.DB);
  const [[orgCount], [sourceCount], [releaseCount], [productCount]] = await Promise.all([
    db.select({ n: count() }).from(organizations),
    db.select({ n: count() }).from(sources),
    db.select({ n: count() }).from(releases),
    db.select({ n: count() }).from(products),
  ]);
  return c.json({ orgs: orgCount.n, sources: sourceCount.n, releases: releaseCount.n, products: productCount.n });
});
