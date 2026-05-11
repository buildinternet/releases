import { Hono } from "hono";
import { eq, count, isNotNull } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  organizationsPublic,
  productsActive,
  tags,
  orgTags,
  productTags,
} from "@buildinternet/releases-core/schema";
import {
  CATEGORIES,
  categoryDisplayName,
  isValidCategory,
} from "@buildinternet/releases-core/categories";
import { getCategoryReleasesFeed } from "@releases/core-internal/category-feed";
import {
  buildFeedCursor,
  formatAggregateReleaseRow,
  parseBoolParam,
  parseLimitParam,
} from "../utils.js";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { categoryReleaseFeedToMarkdown } from "@releases/rendering/formatters.js";
import type { Env } from "../index.js";
import type {
  CategoryDetail,
  CategoryListItem,
  CategoryReleaseItem,
  TagDetail,
} from "@buildinternet/releases-api-types";

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

// `WHERE IS NOT NULL` guarantees `category` is non-null at runtime, but
// drizzle types the column as nullable; the `!` reflects the query's filter
// rather than skipping null rows. Drizzle's count() can return string|number
// depending on the driver — Number() normalizes.
const toCategoryCountMap = (rows: { category: string | null; count: number | string }[]) =>
  new Map(rows.map((r) => [r.category!, Number(r.count)]));

// Empty categories are returned with zero counts so the response advertises
// the full taxonomy — including buckets that don't exist in the DB yet.
taxonomyRoutes.get("/categories", async (c) => {
  const db = createDb(c.env.DB);

  const [orgRows, productRows] = await Promise.all([
    db
      .select({ category: organizationsPublic.category, count: count() })
      .from(organizationsPublic)
      .where(isNotNull(organizationsPublic.category))
      .groupBy(organizationsPublic.category),
    db
      .select({ category: productsActive.category, count: count() })
      .from(productsActive)
      .innerJoin(organizationsPublic, eq(productsActive.orgId, organizationsPublic.id))
      .where(isNotNull(productsActive.category))
      .groupBy(productsActive.category),
  ]);

  const orgCounts = toCategoryCountMap(orgRows);
  const productCounts = toCategoryCountMap(productRows);

  const body: CategoryListItem[] = CATEGORIES.map((slug) => ({
    slug,
    name: categoryDisplayName(slug),
    orgCount: orgCounts.get(slug) ?? 0,
    productCount: productCounts.get(slug) ?? 0,
  }));
  return c.json(body);
});

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

// Aggregated release feed for a category — mirrors
// /v1/collections/:slug/releases (cursor, pagination, content negotiation).
// Effective category = COALESCE(product.category, org.category), see
// @releases/core-internal/category-feed for details.
taxonomyRoutes.get("/categories/:slug/releases", async (c) => {
  const slug = c.req.param("slug");
  if (!isValidCategory(slug)) {
    return c.json({ error: "not_found", message: "Category not found" }, 404);
  }
  const cursorParam = c.req.query("cursor") ?? null;
  const limit = parseLimitParam(c.req.query("limit"), 20, 100);
  const includePrereleases = parseBoolParam(c.req.query("include_prereleases"));

  const db = createDb(c.env.DB);
  const results = await getCategoryReleasesFeed(db, slug, cursorParam, limit + 1, {
    includePrereleases,
  });

  const hasMore = results.length > limit;
  const pageRows = hasMore ? results.slice(0, limit) : results;

  let nextCursor: string | null = null;
  if (hasMore && pageRows.length > 0) {
    nextCursor = buildFeedCursor(pageRows[pageRows.length - 1]);
  }

  const mediaOrigin = c.env.MEDIA_ORIGIN ?? "";
  const releasesFormatted: CategoryReleaseItem[] = pageRows.map((r) =>
    formatAggregateReleaseRow(r, mediaOrigin),
  );

  const pagination = { nextCursor, limit };

  if (wantsMarkdown(c)) {
    return markdownResponse(
      c,
      categoryReleaseFeedToMarkdown(slug, categoryDisplayName(slug), releasesFormatted, pagination),
    );
  }

  return c.json({ releases: releasesFormatted, pagination });
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
