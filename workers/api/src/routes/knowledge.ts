import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { knowledgePages, organizations, products } from "@releases/db/schema.js";
import type { Env } from "../index.js";

function newKnowledgePageId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  const base64 = btoa(String.fromCharCode(...bytes));
  return "kp_" + base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

const app = new Hono<Env>();

// GET /knowledge?scope=org&slug=<orgSlug> — get knowledge page for an org
// GET /knowledge?scope=product&slug=<productSlug> — get knowledge page for a product
app.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const scope = c.req.query("scope") as "org" | "product" | "source-guide" | undefined;
  const slug = c.req.query("slug");

  if (!scope || !slug) {
    return c.json({ error: "scope and slug required" }, 400);
  }

  // Both "org" and "source-guide" scopes resolve by org slug
  if (scope === "org" || scope === "source-guide") {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug));
    if (!org) return c.json(null);

    const [row] = await db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, scope), eq(knowledgePages.orgId, org.id)));
    return c.json(row ?? null);
  }

  if (scope === "product") {
    const [product] = await db
      .select({ id: products.id })
      .from(products)
      .where(eq(products.slug, slug));
    if (!product) return c.json(null);

    const [row] = await db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "product"), eq(knowledgePages.productId, product.id)));
    return c.json(row ?? null);
  }

  return c.json({ error: "Invalid scope — must be 'org', 'product', or 'source-guide'" }, 400);
});

// POST /knowledge — upsert a knowledge page
app.post("/", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json();

  const { scope, orgId, productId, content, releaseCount, lastContributingReleaseAt } = body;

  if (!scope || !content || releaseCount == null) {
    return c.json({ error: "Missing required fields (scope, content, releaseCount)" }, 400);
  }

  const now = new Date().toISOString();

  // Use raw SQL for upsert — Drizzle table-qualifies ON CONFLICT columns which D1 rejects.
  if ((scope === "org" || scope === "source-guide") && orgId) {
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
    return c.json({ error: "Must provide orgId (for org/source-guide scope) or productId (for product scope)" }, 400);
  }

  return c.json({ ok: true });
});

export default app;
