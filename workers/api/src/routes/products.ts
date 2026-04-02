import { Hono } from "hono";
import { eq, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { products, sources, organizations, orgAccounts } from "../../../../src/db/schema.js";
import { toSlug } from "../../../../src/lib/slug.js";
import { isConflictError } from "../utils.js";
import type { Env } from "../index.js";

export const productRoutes = new Hono<Env>();

// List products, optionally filtered by orgId
productRoutes.get("/products", async (c) => {
  const db = createDb(c.env.DB);
  const orgId = c.req.query("orgId");

  const rows = await db
    .select({
      id: products.id,
      name: products.name,
      slug: products.slug,
      orgId: products.orgId,
      url: products.url,
      description: products.description,
      createdAt: products.createdAt,
      sourceCount: sql<number>`(SELECT COUNT(*) FROM sources s WHERE s.product_id = products.id)`,
    })
    .from(products)
    .where(orgId ? eq(products.orgId, orgId) : undefined)
    .orderBy(products.name);

  return c.json(rows);
});

// Adopt: migrate an org into a product under another org (must be before /:identifier)
productRoutes.post("/products/adopt", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{
    sourceOrgSlug: string;
    targetOrgSlug: string;
    slug?: string;
    url?: string;
    dryRun?: boolean;
  }>();

  if (!body.sourceOrgSlug || !body.targetOrgSlug) {
    return c.json({ error: "bad_request", message: "Missing required fields: sourceOrgSlug, targetOrgSlug" }, 400);
  }

  const [sourceOrg] = await db.select().from(organizations).where(eq(organizations.slug, body.sourceOrgSlug));
  if (!sourceOrg) return c.json({ error: "not_found", message: `Source org not found: ${body.sourceOrgSlug}` }, 404);

  const [targetOrg] = await db.select().from(organizations).where(eq(organizations.slug, body.targetOrgSlug));
  if (!targetOrg) return c.json({ error: "not_found", message: `Target org not found: ${body.targetOrgSlug}` }, 404);

  const sourcesToMove = await db.select().from(sources).where(eq(sources.orgId, sourceOrg.id));

  const productSlug = body.slug ?? sourceOrg.slug;
  const productUrl = body.url ?? (sourceOrg.domain ? `https://${sourceOrg.domain}` : null);

  if (body.dryRun) {
    return c.json({
      dryRun: true,
      product: { name: sourceOrg.name, slug: productSlug, url: productUrl, orgSlug: targetOrg.slug },
      sourcesToMove: sourcesToMove.map((s) => s.slug),
      sourceOrgToDelete: sourceOrg.slug,
    });
  }

  let product;
  try {
    [product] = await db.insert(products).values({
      name: sourceOrg.name,
      slug: productSlug,
      orgId: targetOrg.id,
      url: productUrl,
      description: sourceOrg.description,
    }).returning();
  } catch (err) {
    if (isConflictError(err)) {
      return c.json({ error: "conflict", message: `Product with slug "${productSlug}" already exists` }, 409);
    }
    throw err;
  }

  // Move sources to target org and link to new product
  if (sourcesToMove.length > 0) {
    await db.update(sources)
      .set({ orgId: targetOrg.id, productId: product.id })
      .where(eq(sources.orgId, sourceOrg.id));
  }

  // Move org accounts to target org (skip duplicates)
  const accountsToMove = await db.select().from(orgAccounts).where(eq(orgAccounts.orgId, sourceOrg.id));
  if (accountsToMove.length > 0) {
    await db.insert(orgAccounts)
      .values(accountsToMove.map((a) => ({ orgId: targetOrg.id, platform: a.platform, handle: a.handle, createdAt: a.createdAt })))
      .onConflictDoNothing();
  }

  // Delete source org (cascade removes its now-migrated accounts)
  await db.delete(organizations).where(eq(organizations.id, sourceOrg.id));

  return c.json({
    product,
    sourcesMoved: sourcesToMove.length,
    accountsMoved: accountsToMove.length,
    sourceOrgDeleted: sourceOrg.slug,
  });
});

// Get product by slug or ID
productRoutes.get("/products/:identifier", async (c) => {
  const db = createDb(c.env.DB);
  const identifier = c.req.param("identifier");

  const [product] = await db.select().from(products).where(
    identifier.startsWith("prod_") ? eq(products.id, identifier) : eq(products.slug, identifier),
  );

  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const productSources = await db
    .select({ id: sources.id, slug: sources.slug, name: sources.name, type: sources.type, url: sources.url })
    .from(sources)
    .where(eq(sources.productId, product.id))
    .orderBy(sources.name);

  return c.json({ ...product, sources: productSources });
});

// Create product
productRoutes.post("/products", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ orgId: string; name: string; slug?: string; url?: string; description?: string }>();

  if (!body.orgId || !body.name) {
    return c.json({ error: "bad_request", message: "Missing required fields: orgId, name" }, 400);
  }

  const [org] = await db.select().from(organizations).where(eq(organizations.id, body.orgId));
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  const slug = body.slug ?? toSlug(body.name);

  try {
    const [created] = await db
      .insert(products)
      .values({
        name: body.name,
        slug,
        orgId: body.orgId,
        url: body.url ?? null,
        description: body.description ?? null,
      })
      .returning();
    return c.json(created, 201);
  } catch (err) {
    if (isConflictError(err)) {
      return c.json({ error: "conflict", message: `Product with slug "${slug}" already exists` }, 409);
    }
    throw err;
  }
});

// Update product
productRoutes.patch("/products/:slug", async (c) => {
  const db = createDb(c.env.DB);
  const slug = c.req.param("slug");
  const body = await c.req.json<{ name?: string; url?: string | null; description?: string | null }>();

  const [product] = await db.select().from(products).where(eq(products.slug, slug));
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const updates: Record<string, string | null> = {};
  if (body.name) updates.name = body.name;
  if (body.url !== undefined) updates.url = body.url;
  if (body.description !== undefined) updates.description = body.description;

  if (Object.keys(updates).length === 0) {
    return c.json(product);
  }

  const [updated] = await db.update(products).set(updates).where(eq(products.id, product.id)).returning();
  return c.json(updated);
});

// Delete product
productRoutes.delete("/products/:identifier", async (c) => {
  const db = createDb(c.env.DB);
  const identifier = c.req.param("identifier");

  const [product] = await db.select().from(products).where(
    identifier.startsWith("prod_") ? eq(products.id, identifier) : eq(products.slug, identifier),
  );
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  await db.delete(products).where(eq(products.id, product.id));
  return c.json({ deleted: true });
});
