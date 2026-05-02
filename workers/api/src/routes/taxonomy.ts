import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  organizationsActive,
  productsActive,
  tags,
  orgTags,
  productTags,
} from "@buildinternet/releases-core/schema";
import { isValidCategory } from "@buildinternet/releases-core/categories";
import { notOnDemand } from "../queries/shared.js";
import type { Env } from "../index.js";
import type { CategoryDetail, TagDetail } from "@buildinternet/releases-api-types";

export const taxonomyRoutes = new Hono<Env>();

const orgFields = {
  slug: organizationsActive.slug,
  name: organizationsActive.name,
  domain: organizationsActive.domain,
  avatarUrl: organizationsActive.avatarUrl,
} as const;

const productFields = {
  slug: productsActive.slug,
  name: productsActive.name,
  description: productsActive.description,
  orgSlug: organizationsActive.slug,
  orgName: organizationsActive.name,
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
      .from(organizationsActive)
      .where(
        and(eq(organizationsActive.category, slug), notOnDemand(organizationsActive.discovery)),
      )
      .orderBy(organizationsActive.name),
    db
      .select(productFields)
      .from(productsActive)
      .innerJoin(organizationsActive, eq(productsActive.orgId, organizationsActive.id))
      .where(and(eq(productsActive.category, slug), notOnDemand(organizationsActive.discovery)))
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
      .from(organizationsActive)
      .innerJoin(orgTags, eq(orgTags.orgId, organizationsActive.id))
      .where(and(eq(orgTags.tagId, tag.id), notOnDemand(organizationsActive.discovery)))
      .orderBy(organizationsActive.name),
    db
      .select(productFields)
      .from(productsActive)
      .innerJoin(productTags, eq(productTags.productId, productsActive.id))
      .innerJoin(organizationsActive, eq(productsActive.orgId, organizationsActive.id))
      .where(and(eq(productTags.tagId, tag.id), notOnDemand(organizationsActive.discovery)))
      .orderBy(productsActive.name),
  ]);

  const body: TagDetail = { slug: tag.slug, name: tag.name, orgs, products: productsList };
  return c.json(body);
});
