import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import { products, sources, organizations, orgAccounts, tags, productTags } from "@releases/db/schema.js";
import { toSlug } from "@releases/lib/slug.js";
import { isValidCategory } from "@releases/lib/categories.js";
import { isConflictError, getOrCreateTagD1, productWhere, orgWhere } from "../utils.js";
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
      category: products.category,
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

  const [sourceOrg] = await db.select().from(organizations).where(orgWhere(body.sourceOrgSlug));
  if (!sourceOrg) return c.json({ error: "not_found", message: `Source org not found: ${body.sourceOrgSlug}` }, 404);

  const [targetOrg] = await db.select().from(organizations).where(orgWhere(body.targetOrgSlug));
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

  const [product] = await db.select().from(products).where(productWhere(identifier));

  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const productSources = await db
    .select({ id: sources.id, slug: sources.slug, name: sources.name, type: sources.type, url: sources.url })
    .from(sources)
    .where(eq(sources.productId, product.id))
    .orderBy(sources.name);

  const tagRows = await db
    .select({ name: tags.name })
    .from(productTags)
    .innerJoin(tags, eq(productTags.tagId, tags.id))
    .where(eq(productTags.productId, product.id))
    .orderBy(tags.name);

  return c.json({ ...product, sources: productSources, tags: tagRows.map((t) => t.name) });
});

// Create product
productRoutes.post("/products", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ orgId?: string; orgSlug?: string; name: string; slug?: string; url?: string; description?: string; category?: string; tags?: string[] }>();

  if ((!body.orgId && !body.orgSlug) || !body.name) {
    return c.json({ error: "bad_request", message: "Missing required fields: orgId or orgSlug, name" }, 400);
  }

  const orgCond = body.orgId ? eq(organizations.id, body.orgId) : orgWhere(body.orgSlug!);
  const [org] = await db.select().from(organizations).where(orgCond);
  if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

  if (body.category && !isValidCategory(body.category)) {
    return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
  }

  const slug = body.slug ?? toSlug(body.name);

  try {
    const [created] = await db
      .insert(products)
      .values({
        name: body.name,
        slug,
        orgId: org.id,
        url: body.url ?? null,
        description: body.description ?? null,
        category: body.category ?? null,
      })
      .returning();

    // Handle tags
    if (body.tags && body.tags.length > 0) {
      for (const tagName of body.tags) {
        const tag = await getOrCreateTagD1(db, tagName);
        await db.insert(productTags).values({ productId: created.id, tagId: tag.id, createdAt: new Date().toISOString() }).onConflictDoNothing();
      }
    }

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
  const body = await c.req.json<{ name?: string; url?: string | null; description?: string | null; category?: string | null; tags?: string[] }>();

  const [product] = await db.select().from(products).where(productWhere(slug));
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const updates: Record<string, string | null> = {};
  if (body.name) updates.name = body.name;
  if (body.url !== undefined) updates.url = body.url;
  if (body.description !== undefined) updates.description = body.description;

  if (body.category !== undefined && body.category !== null && !isValidCategory(body.category)) {
    return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
  }
  if (body.category !== undefined) updates.category = body.category;

  if (Object.keys(updates).length === 0 && body.tags === undefined) {
    return c.json(product);
  }

  let updated = product;
  if (Object.keys(updates).length > 0) {
    [updated] = await db.update(products).set(updates).where(eq(products.id, product.id)).returning();
  }

  if (body.tags !== undefined) {
    await db.delete(productTags).where(eq(productTags.productId, product.id));
    for (const tagName of body.tags) {
      const tag = await getOrCreateTagD1(db, tagName);
      await db.insert(productTags).values({ productId: product.id, tagId: tag.id, createdAt: new Date().toISOString() }).onConflictDoNothing();
    }
  }

  return c.json(updated);
});

productRoutes.get("/products/:identifier/tags", async (c) => {
  const db = createDb(c.env.DB);
  const identifier = c.req.param("identifier");
  const [product] = await db.select().from(products).where(productWhere(identifier));
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const rows = await db
    .select({ name: tags.name })
    .from(productTags)
    .innerJoin(tags, eq(productTags.tagId, tags.id))
    .where(eq(productTags.productId, product.id))
    .orderBy(tags.name);
  return c.json(rows.map((r) => r.name));
});

productRoutes.put("/products/:identifier/tags", async (c) => {
  const db = createDb(c.env.DB);
  const identifier = c.req.param("identifier");
  const body = await c.req.json<{ tags: string[] }>();
  const [product] = await db.select().from(products).where(productWhere(identifier));
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  for (const tagName of body.tags) {
    const tag = await getOrCreateTagD1(db, tagName);
    await db.insert(productTags).values({ productId: product.id, tagId: tag.id, createdAt: new Date().toISOString() }).onConflictDoNothing();
  }
  return c.json({ ok: true });
});

productRoutes.delete("/products/:identifier/tags", async (c) => {
  const db = createDb(c.env.DB);
  const identifier = c.req.param("identifier");
  const body = await c.req.json<{ tags: string[] }>();
  const [product] = await db.select().from(products).where(productWhere(identifier));
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  for (const tagName of body.tags) {
    const tagSlug = toSlug(tagName);
    const [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (tag) {
      await db.delete(productTags).where(and(eq(productTags.productId, product.id), eq(productTags.tagId, tag.id)));
    }
  }
  return c.json({ ok: true });
});

// Delete product
productRoutes.delete("/products/:identifier", async (c) => {
  const db = createDb(c.env.DB);
  const identifier = c.req.param("identifier");

  const [product] = await db.select().from(products).where(productWhere(identifier));
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  await db.delete(products).where(eq(products.id, product.id));
  return c.json({ deleted: true });
});
