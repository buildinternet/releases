import { Hono } from "hono";
import { eq, and, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { knowledgePages, organizations, sources, products } from "@releases/core-internal/schema";
import { generatePlaybookHeader } from "@releases/ai/playbook.js";
import { newKnowledgePageId, orgWhere } from "../utils.js";
import type { Env } from "../index.js";

const app = new Hono<Env>();

// GET /playbook?slug=<orgSlug> — get assembled playbook for an org
app.get("/", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.query("slug");

  if (!slug) {
    return c.json({ error: "slug required" }, 400);
  }

  const [org] = await db
    .select({ id: organizations.id })
    .from(organizations)
    .where(orgWhere(slug));
  if (!org) return c.json(null);

  const [row] = await db
    .select()
    .from(knowledgePages)
    .where(and(eq(knowledgePages.scope, "playbook"), eq(knowledgePages.orgId, org.id)));

  if (!row) return c.json(null);

  return c.json(row);
});

// PATCH /playbook/notes?slug=<orgSlug> — update playbook notes
app.patch("/notes", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.query("slug");
  const body = await c.req.json<{ notes: string }>();

  if (!slug) return c.json({ error: "slug query param required" }, 400);
  if (body.notes === undefined) return c.json({ error: "notes field required" }, 400);

  const [org] = await db
    .select({ id: organizations.id, name: organizations.name, slug: organizations.slug, domain: organizations.domain })
    .from(organizations)
    .where(orgWhere(slug));
  if (!org) return c.json({ error: "Organization not found" }, 404);

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
    const orgSources = await db.select().from(sources).where(eq(sources.orgId, org.id));
    const orgProducts = await db
      .select({ id: products.id, name: products.name, slug: products.slug, description: products.description })
      .from(products)
      .where(eq(products.orgId, org.id));

    const header = generatePlaybookHeader({
      orgName: org.name,
      orgSlug: org.slug,
      domain: org.domain,
      sources: orgSources,
      products: orgProducts.map((p) => ({ id: p.id, name: p.name, slug: p.slug, description: p.description })),
    });

    const id = newKnowledgePageId();
    await db.run(sql`INSERT INTO knowledge_pages (id, scope, org_id, product_id, content, notes, release_count, generated_at, updated_at)
      VALUES (${id}, 'playbook', ${org.id}, NULL, ${header}, ${notes}, ${orgSources.length}, ${now}, ${now})`);
  }

  return c.json({ ok: true, notes });
});

export default app;
