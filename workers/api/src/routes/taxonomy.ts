import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  organizationsPublic,
  productsActive,
  tags,
  orgTags,
  productTags,
} from "@buildinternet/releases-core/schema";
import { isValidCategory } from "@buildinternet/releases-core/categories";
import type { Env } from "../index.js";
import type { CategoryDetail, TagDetail } from "@buildinternet/releases-api-types";

export const taxonomyRoutes = new Hono<Env>();

const orgFields = {
  slug: organizationsPublic.slug,
  name: organizationsPublic.name,
  domain: organizationsPublic.domain,
  avatarUrl: organizationsPublic.avatarUrl,
} as const;

const productFields = {
  slug: productsActive.slug,
  name: productsActive.name,
  description: productsActive.description,
  orgSlug: organizationsPublic.slug,
  orgName: organizationsPublic.name,
} as const;

taxonomyRoutes.get("/categories/:slug", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidCategory(slug)) {
    return c.json({ error: "not_found", message: "Category not found" }, 404);
  }
  const db = createDb(c.env.DB);

  const [orgs, productsList] = await Promise.all([
    db
      .select(orgFields)
      .from(organizationsPublic)
      .where(eq(organizationsPublic.category, slug))
      .orderBy(organizationsPublic.name),
    db
      .select(productFields)
      .from(productsActive)
      .innerJoin(organizationsPublic, eq(productsActive.orgId, organizationsPublic.id))
      .where(eq(productsActive.category, slug))
      .orderBy(productsActive.name),
  ]);

  const body: CategoryDetail = { slug, orgs, products: productsList };
  return c.json(body);
});

taxonomyRoutes.get("/tags/:slug", async (c) => {
  const slug = c.req.param("slug");
  const db = createDb(c.env.DB);

  const [tag] = await db.select().from(tags).where(eq(tags.slug, slug));
  if (!tag) {
    return c.json({ error: "not_found", message: "Tag not found" }, 404);
  }

  const [orgs, productsList] = await Promise.all([
    db
      .select(orgFields)
      .from(organizationsPublic)
      .innerJoin(orgTags, eq(orgTags.orgId, organizationsPublic.id))
      .where(eq(orgTags.tagId, tag.id))
      .orderBy(organizationsPublic.name),
    db
      .select(productFields)
      .from(productsActive)
      .innerJoin(productTags, eq(productTags.productId, productsActive.id))
      .innerJoin(organizationsPublic, eq(productsActive.orgId, organizationsPublic.id))
      .where(eq(productTags.tagId, tag.id))
      .orderBy(productsActive.name),
  ]);

  const body: TagDetail = { slug: tag.slug, name: tag.name, orgs, products: productsList };
  return c.json(body);
});
