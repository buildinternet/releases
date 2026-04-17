import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { knowledgePages, organizations, products } from "@buildinternet/releases-core/schema";
import { newKnowledgePageId, orgWhere, productWhere } from "../utils.js";
import type { Env } from "../index.js";

const app = new Hono<Env>();

// GET /overview?slug=<orgSlug> — get overview page for an org
// GET /overview?scope=product&slug=<productSlug> — get overview page for a product
// Also accepts scope=org explicitly (default)
app.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const scope = (c.req.query("scope") as "org" | "product" | undefined) ?? "org";
  const slug = c.req.query("slug");

  if (!slug) {
    return c.json({ error: "slug required" }, 400);
  }

  if (scope === "org") {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(slug));
    if (!org) return c.json(null);

    const [row] = await db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "org"), eq(knowledgePages.orgId, org.id)));

    return c.json(row ?? null);
  }

  if (scope === "product") {
    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(productWhere(slug));
    if (!product) return c.json(null);

    const [row] = await db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "product"), eq(knowledgePages.productId, product.id)));
    return c.json(row ?? null);
  }

  return c.json({ error: "Invalid scope — must be 'org' or 'product'" }, 400);
});

// POST /overview — upsert an overview page
app.post("/", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json();

  const { scope, orgId, productId, content, releaseCount, lastContributingReleaseAt } = body;

  if (!scope || !content || releaseCount == null) {
    return c.json({ error: "Missing required fields (scope, content, releaseCount)" }, 400);
  }

  const now = new Date().toISOString();

  if ((scope === "org" || scope === "playbook") && orgId) {
    const id = newKnowledgePageId();
    await db.run(sql`INSERT INTO knowledge_pages (id, scope, org_id, product_id, content, release_count, last_contributing_release_at, generated_at, updated_at)
      VALUES (${id}, ${scope}, ${orgId}, NULL, ${content}, ${releaseCount}, ${lastContributingReleaseAt ?? null}, ${now}, ${now})
      ON CONFLICT (scope, org_id) DO UPDATE SET content = ${content}, release_count = ${releaseCount}, last_contributing_release_at = ${lastContributingReleaseAt ?? null}, updated_at = ${now}`);
  } else if (scope === "product" && productId) {
    const id = newKnowledgePageId();
    await db.run(sql`INSERT INTO knowledge_pages (id, scope, org_id, product_id, content, release_count, last_contributing_release_at, generated_at, updated_at)
      VALUES (${id}, ${scope}, NULL, ${productId}, ${content}, ${releaseCount}, ${lastContributingReleaseAt ?? null}, ${now}, ${now})
      ON CONFLICT (scope, product_id) DO UPDATE SET content = ${content}, release_count = ${releaseCount}, last_contributing_release_at = ${lastContributingReleaseAt ?? null}, updated_at = ${now}`);
  } else {
    return c.json({ error: "Must provide orgId (for org/playbook scope) or productId (for product scope)" }, 400);
  }

  return c.json({ ok: true });
});

export default app;
