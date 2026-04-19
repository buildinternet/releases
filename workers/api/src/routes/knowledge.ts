import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { knowledgePages, organizations, products, sources } from "@releases/core-internal/schema";
import { generatePlaybookHeader } from "@releases/ai-internal/playbook";
import { newKnowledgePageId, orgWhere, productWhere } from "../utils.js";
import { isValidBearerAuth } from "../middleware/auth.js";
import type { Env } from "../index.js";

const app = new Hono<Env>();

// GET /knowledge?scope=org&slug=<orgSlug> — get knowledge page for an org
// GET /knowledge?scope=playbook&slug=<orgSlug> — get assembled playbook
// GET /knowledge?scope=product&slug=<productSlug> — get knowledge page for a product
app.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const scope = c.req.query("scope") as "org" | "product" | "playbook" | undefined;
  const slug = c.req.query("slug");

  if (!scope || !slug) {
    return c.json({ error: "scope and slug required" }, 400);
  }

  // Both "org" and "playbook" scopes resolve by org slug.
  // Playbook content is internal — gate that scope behind auth even though
  // this route is otherwise public.
  if (scope === "org" || scope === "playbook") {
    if (scope === "playbook" && !(await isValidBearerAuth(c))) {
      return c.json({ error: "unauthorized", message: "Invalid or missing API key" }, 401);
    }

    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(slug));
    if (!org) return c.json(null);

    const [row] = await db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, scope), eq(knowledgePages.orgId, org.id)));

    if (!row) return c.json(null);

    // Return raw content + notes — consumers assemble the full guide
    return c.json(row);
  }

  if (scope === "product") {
    const [product] = await db.select({ id: products.id }).from(products).where(productWhere(slug));
    if (!product) return c.json(null);

    const [row] = await db
      .select()
      .from(knowledgePages)
      .where(and(eq(knowledgePages.scope, "product"), eq(knowledgePages.productId, product.id)));
    return c.json(row ?? null);
  }

  return c.json({ error: "Invalid scope — must be 'org', 'product', or 'playbook'" }, 400);
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
    return c.json(
      { error: "Must provide orgId (for org/playbook scope) or productId (for product scope)" },
      400,
    );
  }

  return c.json({ ok: true });
});

// PATCH /knowledge/notes?slug=<orgSlug> — update playbook notes
app.patch("/notes", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.query("slug");
  const body = await c.req.json<{ notes: string }>();

  if (!slug) return c.json({ error: "slug query param required" }, 400);
  if (body.notes === undefined) return c.json({ error: "notes field required" }, 400);

  const [org] = await db
    .select({
      id: organizations.id,
      name: organizations.name,
      slug: organizations.slug,
      domain: organizations.domain,
    })
    .from(organizations)
    .where(orgWhere(slug));
  if (!org) return c.json({ error: "Organization not found" }, 404);

  // If no guide exists yet, create one with auto-generated header + the provided notes
  const [existing] = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "playbook"), eq(knowledgePages.orgId, org.id)));

  const now = new Date().toISOString();
  const notes = body.notes.trim() || null;

  if (existing) {
    await db.run(sql`UPDATE knowledge_pages SET notes = ${notes}, updated_at = ${now}
      WHERE scope = 'playbook' AND org_id = ${org.id}`);
  } else {
    // Generate header on the fly for first-time creation
    const orgSources = await db.select().from(sources).where(eq(sources.orgId, org.id));
    const orgProducts = await db
      .select({
        id: products.id,
        name: products.name,
        slug: products.slug,
        description: products.description,
      })
      .from(products)
      .where(eq(products.orgId, org.id));

    const header = generatePlaybookHeader({
      orgName: org.name,
      orgSlug: org.slug,
      domain: org.domain,
      sources: orgSources,
      products: orgProducts.map((p) => ({
        id: p.id,
        name: p.name,
        slug: p.slug,
        description: p.description,
      })),
    });

    const id = newKnowledgePageId();
    await db.run(sql`INSERT INTO knowledge_pages (id, scope, org_id, product_id, content, notes, release_count, generated_at, updated_at)
      VALUES (${id}, 'playbook', ${org.id}, NULL, ${header}, ${notes}, ${orgSources.length}, ${now}, ${now})`);
  }

  return c.json({ ok: true, notes });
});

export default app;
