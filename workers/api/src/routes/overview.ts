import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { knowledgePages, organizations, products } from "@buildinternet/releases-core/schema";
import { newKnowledgePageId, orgWhere, productWhere } from "../utils.js";
import type { Env } from "../index.js";

const app = new Hono<Env>();

app.get("/orgs/:slug/overview", async (c) => {
  const db = createDb(c.env.DB);
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(orgWhere(c.req.param("slug")));
  if (!org) return c.json(null);

  const [row] = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, org.id)));

  return c.json(row ?? null);
});

app.post("/orgs/:slug/overview", async (c) => {
  const db = createDb(c.env.DB);
  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(orgWhere(c.req.param("slug")));
  if (!org) return c.json({ error: "not_found" }, 404);

  const body = await c.req.json<{
    content: string;
    releaseCount: number;
    lastContributingReleaseAt?: string | null;
  }>();
  if (!body.content || body.releaseCount == null) {
    return c.json({ error: "Missing required fields (content, releaseCount)" }, 400);
  }

  const now = new Date().toISOString();
  const id = newKnowledgePageId();
  await db.run(sql`INSERT INTO knowledge_pages (id, scope, org_id, product_id, content, release_count, last_contributing_release_at, generated_at, updated_at)
    VALUES (${id}, 'org', ${org.id}, NULL, ${body.content}, ${body.releaseCount}, ${body.lastContributingReleaseAt ?? null}, ${now}, ${now})
    ON CONFLICT (scope, org_id) DO UPDATE SET content = ${body.content}, release_count = ${body.releaseCount}, last_contributing_release_at = ${body.lastContributingReleaseAt ?? null}, updated_at = ${now}`);

  return c.json({ ok: true });
});

app.get("/products/:slug/overview", async (c) => {
  const db = createDb(c.env.DB);
  const [product] = await db
    .select({ id: products.id })
    .from(products)
    .where(productWhere(c.req.param("slug")));
  if (!product) return c.json(null);

  const [row] = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "product"), eq(knowledgePages.productId, product.id)));

  return c.json(row ?? null);
});

export default app;
