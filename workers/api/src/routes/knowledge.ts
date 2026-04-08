import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { createDb } from "../db.js";
import { knowledgePages, organizations, products } from "@releases/db/schema.js";
import type { Env } from "../index.js";

const app = new Hono<Env>();

// GET /knowledge?scope=org&slug=<orgSlug> — get knowledge page for an org
// GET /knowledge?scope=product&slug=<productSlug> — get knowledge page for a product
app.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const scope = c.req.query("scope") as "org" | "product" | undefined;
  const slug = c.req.query("slug");

  if (!scope || !slug) {
    return c.json({ error: "scope and slug required" }, 400);
  }

  if (scope === "org") {
    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(eq(organizations.slug, slug));
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
      .where(eq(products.slug, slug));
    if (!product) return c.json(null);

    const [row] = await db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "product"), eq(knowledgePages.productId, product.id)));
    return c.json(row ?? null);
  }

  return c.json({ error: "Invalid scope — must be 'org' or 'product'" }, 400);
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

  if (scope === "org" && orgId) {
    await db
      .insert(knowledgePages)
      .values({
        scope,
        orgId,
        productId: null,
        content,
        releaseCount,
        lastContributingReleaseAt: lastContributingReleaseAt ?? null,
        generatedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [knowledgePages.orgId],
        set: {
          content,
          releaseCount,
          lastContributingReleaseAt: lastContributingReleaseAt ?? null,
          updatedAt: now,
        },
      });
  } else if (scope === "product" && productId) {
    await db
      .insert(knowledgePages)
      .values({
        scope,
        orgId: null,
        productId,
        content,
        releaseCount,
        lastContributingReleaseAt: lastContributingReleaseAt ?? null,
        generatedAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [knowledgePages.productId],
        set: {
          content,
          releaseCount,
          lastContributingReleaseAt: lastContributingReleaseAt ?? null,
          updatedAt: now,
        },
      });
  } else {
    return c.json({ error: "Must provide orgId (for org scope) or productId (for product scope)" }, 400);
  }

  return c.json({ ok: true });
});

export default app;
