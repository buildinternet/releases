import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  organizations,
  products,
  tags,
  orgTags,
  productTags,
} from "@buildinternet/releases-core/schema";
import { isValidCategory } from "@buildinternet/releases-core/categories";
import { orgNotOnDemand } from "../queries/shared.js";
import type { Env } from "../index.js";
import type { CategoryDetail, TagDetail } from "@buildinternet/releases-api-types";

export const taxonomyRoutes = new Hono<Env>();

const orgFields = {
  slug: organizations.slug,
  name: organizations.name,
  domain: organizations.domain,
  avatarUrl: organizations.avatarUrl,
} as const;

const productFields = {
  slug: products.slug,
  name: products.name,
  description: products.description,
  orgSlug: organizations.slug,
  orgName: organizations.name,
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
      .from(organizations)
      .where(and(eq(organizations.category, slug), orgNotOnDemand))
      .orderBy(organizations.name),
    db
      .select(productFields)
      .from(products)
      .innerJoin(organizations, eq(products.orgId, organizations.id))
      .where(and(eq(products.category, slug), orgNotOnDemand))
      .orderBy(products.name),
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
      .from(organizations)
      .innerJoin(orgTags, eq(orgTags.orgId, organizations.id))
      .where(and(eq(orgTags.tagId, tag.id), orgNotOnDemand))
      .orderBy(organizations.name),
    db
      .select(productFields)
      .from(products)
      .innerJoin(productTags, eq(productTags.productId, products.id))
      .innerJoin(organizations, eq(products.orgId, organizations.id))
      .where(and(eq(productTags.tagId, tag.id), orgNotOnDemand))
      .orderBy(products.name),
  ]);

  const body: TagDetail = { slug: tag.slug, name: tag.name, orgs, products: productsList };
  return c.json(body);
});
