import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { eq, count, isNotNull, inArray } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  organizationsPublic,
  productsActive,
  tags,
  orgTags,
  productTags,
  categories,
} from "@buildinternet/releases-core/schema";
import {
  CATEGORIES,
  CATEGORY_ALIAS_RE,
  categoryDisplayName,
  isValidCategory,
  parseCategoryAliases,
  type Category,
} from "@buildinternet/releases-core/categories";
import { loadAliasMap } from "../lib/category-alias.js";
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
  UpdateCategoryRequest,
} from "@buildinternet/releases-api-types";
import {
  CategoryListResponseSchema,
  CategoryDetailSchema,
  UpdateCategoryRequestSchema,
  UpdateCategoryResponseSchema,
  CategoryReleasesResponseSchema,
  TagDetailSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";
import { validateJson } from "../lib/validate.js";

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

type CategoryMetaRow = {
  slug: string;
  name: string | null;
  description: string | null;
  aliases: string[];
};

type CategoryDbRow = {
  slug: string;
  name: string | null;
  description: string | null;
  aliases: string | null;
};

function toMetaRow(row: CategoryDbRow): CategoryMetaRow {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description,
    aliases: parseCategoryAliases(row.aliases),
  };
}

const toMetaMap = (rows: CategoryMetaRow[]) => new Map(rows.map((r) => [r.slug, r] as const));

function resolveCategoryDisplay(slug: string, meta: CategoryMetaRow | undefined) {
  return {
    name: meta?.name ?? categoryDisplayName(slug),
    description: meta?.description ?? null,
    aliases: meta?.aliases ?? [],
  };
}

// Empty categories are returned with zero counts so the response advertises
// the full taxonomy — including buckets that don't exist in the DB yet.
taxonomyRoutes.get(
  "/categories",
  describeRoute({
    tags: ["Taxonomy"],
    summary: "List all categories with org and product counts",
    description:
      "Categories are a fixed taxonomy (`CATEGORIES` in `@buildinternet/releases-core/categories`), so the response always includes every slug — including ones with zero members. `orgCount` and `productCount` are computed against `organizations_public` (excludes `on_demand` and soft-deleted orgs). `name` / `description` / `aliases` come from the optional `categories` metadata overlay; clients render their own fallback display name when no override is set.",
    responses: {
      200: {
        description: "Full category list, one row per canonical slug",
        content: { "application/json": { schema: resolver(CategoryListResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);

    const [orgRows, productRows, metaRows] = await Promise.all([
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
      db
        .select({
          slug: categories.slug,
          name: categories.name,
          description: categories.description,
          aliases: categories.aliases,
        })
        .from(categories)
        .where(inArray(categories.slug, [...CATEGORIES])),
    ]);

    const orgCounts = toCategoryCountMap(orgRows);
    const productCounts = toCategoryCountMap(productRows);
    const metaMap = toMetaMap(metaRows.map(toMetaRow));

    const body: CategoryListItem[] = CATEGORIES.map((slug) => {
      const display = resolveCategoryDisplay(slug, metaMap.get(slug));
      return {
        slug,
        name: display.name,
        description: display.description,
        aliases: display.aliases,
        orgCount: orgCounts.get(slug) ?? 0,
        productCount: productCounts.get(slug) ?? 0,
      };
    });
    return c.json(body);
  },
);

taxonomyRoutes.get(
  "/categories/:slug",
  describeRoute({
    tags: ["Taxonomy"],
    summary: "Get category detail with member orgs and products",
    description:
      "Returns orgs and products whose `category` matches the canonical slug. Aliases redirect: a non-canonical slug that matches an alias in the `categories` overlay returns a `301 Moved Permanently` to the canonical URL. Unknown slugs (neither canonical nor aliased) return `404`.",
    responses: {
      200: {
        description: "Category detail with org and product rollups",
        content: { "application/json": { schema: resolver(CategoryDetailSchema) } },
      },
      301: {
        description: "Slug is an alias; redirects to the canonical category URL",
      },
      404: {
        description: "Slug is neither canonical nor a known alias",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const input = c.req.param("slug");
    const db = createDb(c.env.DB);

    // Alias resolution: if the input isn't canonical, look it up in the alias
    // map and 301 to the canonical URL. Old bookmarks and external links keep
    // working without the response shape having to carry both slugs.
    if (!isValidCategory(input)) {
      const aliasMap = await loadAliasMap(db);
      const canonical = aliasMap.get(input);
      if (canonical && isValidCategory(canonical)) {
        const url = new URL(c.req.url);
        url.pathname = url.pathname.replace(
          `/categories/${encodeURIComponent(input)}`,
          `/categories/${canonical}`,
        );
        return c.redirect(url.toString(), 301);
      }
      return c.json({ error: "not_found", message: "Category not found" }, 404);
    }
    const slug = input;

    const [orgs, productsList, rawMetaRow] = await Promise.all([
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
      db
        .select({
          slug: categories.slug,
          name: categories.name,
          description: categories.description,
          aliases: categories.aliases,
        })
        .from(categories)
        .where(eq(categories.slug, slug))
        .limit(1)
        .then((r) => (r[0] ? toMetaRow(r[0]) : undefined)),
    ]);

    const display = resolveCategoryDisplay(slug, rawMetaRow);
    const body: CategoryDetail = {
      slug,
      name: display.name,
      description: display.description,
      aliases: display.aliases,
      orgs,
      products: productsList,
    };
    return c.json(body);
  },
);

// Writes inherit auth from `publicReadAuthMiddleware` via the
// `publicReadRoutes` allowlist in index.ts — same model as collections.
// Upserts a single row; passing `null` clears name/description, and an empty
// `aliases` array clears alias mappings.
taxonomyRoutes.patch(
  "/categories/:slug",
  describeRoute({
    tags: ["Taxonomy"],
    summary: "Update the category metadata overlay",
    description:
      "Upserts the `categories` overlay row for the given canonical slug. All body fields are optional. `name` and `description` accept `null` to clear the override; `aliases` replaces the full alias set (pass `[]` to clear).\n\nAliases must be kebab-case, must not match a canonical slug, and must not be claimed by another category row — a cross-row conflict returns 409. Writes inherit auth from `publicReadAuthMiddleware`.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Updated overlay values",
        content: { "application/json": { schema: resolver(UpdateCategoryResponseSchema) } },
      },
      400: {
        description: "Empty body, malformed alias, or alias collides with a canonical slug",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Slug is not a canonical category",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      409: {
        description: "Alias is already claimed by a different category row",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(UpdateCategoryRequestSchema),
  async (c) => {
    const slug = c.req.param("slug");
    if (!isValidCategory(slug)) {
      return c.json({ error: "not_found", message: "Category not found" }, 404);
    }
    // `validateJson` enforces the body shape (string types, length caps,
    // at-least-one-field). The handler still owns the post-trim invariants
    // and the runtime-state checks (canonical-slug shadowing, cross-row
    // alias claim, intra-request dedup) below.
    const body: UpdateCategoryRequest = { ...c.req.valid("json") };
    if (body.name != null) {
      const trimmed = body.name.trim();
      if (trimmed.length === 0) {
        return c.json({ error: "bad_request", message: "Name must be 1–200 characters" }, 400);
      }
      body.name = trimmed;
    }

    let normalizedAliases: string[] | undefined;
    if (body.aliases !== undefined) {
      const seen = new Set<string>();
      normalizedAliases = [];
      for (const raw of body.aliases) {
        const alias = raw.trim().toLowerCase();
        if (!CATEGORY_ALIAS_RE.test(alias)) {
          return c.json(
            {
              error: "bad_request",
              message: `Invalid alias "${raw}". Must match ${CATEGORY_ALIAS_RE.source}`,
            },
            400,
          );
        }
        if (isValidCategory(alias)) {
          return c.json(
            {
              error: "bad_request",
              message: `Alias "${alias}" is already a canonical category slug`,
            },
            400,
          );
        }
        if (seen.has(alias)) {
          return c.json(
            { error: "bad_request", message: `Duplicate alias "${alias}" in request` },
            400,
          );
        }
        seen.add(alias);
        normalizedAliases.push(alias);
      }
    }

    const db = createDb(c.env.DB);
    const now = new Date().toISOString();

    // One full-table fetch covers both the existing-row lookup and the
    // cross-row alias-conflict check. The table is bounded by `CATEGORIES.length`
    // (one row per customized category) so reading it whole is cheap.
    const allRows = await db
      .select({
        slug: categories.slug,
        name: categories.name,
        description: categories.description,
        aliases: categories.aliases,
      })
      .from(categories);
    const existing = allRows.find((r) => r.slug === slug);

    // Cross-row alias-claim conflict: an alias may only redirect to one canonical.
    if (normalizedAliases !== undefined && normalizedAliases.length > 0) {
      for (const row of allRows) {
        if (row.slug === slug) continue;
        const claimed = new Set(parseCategoryAliases(row.aliases));
        for (const alias of normalizedAliases) {
          if (claimed.has(alias)) {
            return c.json(
              {
                error: "conflict",
                message: `Alias "${alias}" is already claimed by category "${row.slug}"`,
              },
              409,
            );
          }
        }
      }
    }

    const nextName = body.name === undefined ? (existing?.name ?? null) : body.name;
    const nextDescription =
      body.description === undefined ? (existing?.description ?? null) : body.description;
    const nextAliases =
      normalizedAliases === undefined ? parseCategoryAliases(existing?.aliases) : normalizedAliases;
    const nextAliasesJson = JSON.stringify(nextAliases);

    if (existing) {
      await db
        .update(categories)
        .set({
          name: nextName,
          description: nextDescription,
          aliases: nextAliasesJson,
          updatedAt: now,
        })
        .where(eq(categories.slug, slug));
    } else {
      await db.insert(categories).values({
        slug,
        name: nextName,
        description: nextDescription,
        aliases: nextAliasesJson,
        updatedAt: now,
      });
    }

    return c.json({
      slug,
      name: nextName ?? categoryDisplayName(slug),
      description: nextDescription,
      aliases: nextAliases,
    });
  },
);

// Aggregated release feed for a category — mirrors
// /v1/collections/:slug/releases (cursor, pagination, content negotiation).
// Effective category = COALESCE(product.category, org.category), see
// @releases/core-internal/category-feed for details.
taxonomyRoutes.get(
  "/categories/:slug/releases",
  describeRoute({
    tags: ["Taxonomy"],
    summary: "Cross-org release feed scoped to a category",
    description:
      "Aggregated release feed for a category rollup. Mirrors `/v1/collections/:slug/releases` (cursor pagination, content negotiation). Effective category resolution: `COALESCE(product.category, org.category)` — see `@releases/core-internal/category-feed`.\n\nNon-canonical slugs that match a known alias resolve to the canonical category internally (no redirect — feeds aren't bookmarked). Content negotiation: `Accept: text/markdown` returns a Markdown-rendered version.",
    parameters: [
      {
        name: "cursor",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Opaque pagination cursor from a previous response's `pagination.nextCursor`.",
      },
      {
        name: "limit",
        in: "query",
        required: false,
        schema: { type: "integer", minimum: 1, maximum: 100, default: 20 },
        description: "Max releases per page. Clamped to `[1, 100]`.",
      },
      {
        name: "include_prereleases",
        in: "query",
        required: false,
        schema: { type: "boolean" },
        description: "Include alpha/beta/rc/preview/nightly releases. Default false.",
      },
    ],
    responses: {
      200: {
        description: "Category release feed (or Markdown when `Accept: text/markdown` is sent)",
        content: { "application/json": { schema: resolver(CategoryReleasesResponseSchema) } },
      },
      404: {
        description: "Slug is neither canonical nor a known alias",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const input = c.req.param("slug");
    const db = createDb(c.env.DB);

    let slug: Category;
    if (isValidCategory(input)) {
      slug = input;
    } else {
      const aliasMap = await loadAliasMap(db);
      const canonical = aliasMap.get(input);
      if (!canonical || !isValidCategory(canonical)) {
        return c.json({ error: "not_found", message: "Category not found" }, 404);
      }
      slug = canonical;
    }
    const cursorParam = c.req.query("cursor") ?? null;
    const limit = parseLimitParam(c.req.query("limit"), 20, 100);
    const includePrereleases = parseBoolParam(c.req.query("include_prereleases"));

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
        categoryReleaseFeedToMarkdown(
          slug,
          categoryDisplayName(slug),
          releasesFormatted,
          pagination,
        ),
      );
    }

    return c.json({ releases: releasesFormatted, pagination });
  },
);

taxonomyRoutes.get(
  "/tags/:slug",
  describeRoute({
    tags: ["Taxonomy"],
    summary: "Get tag detail with member orgs and products",
    description:
      "Returns orgs and products tagged with the given slug. Tags are freeform (get-or-create on write paths); unknown slugs return `404`. Both rollups include orgs from `organizations_public` only — `on_demand` and soft-deleted orgs are excluded.",
    responses: {
      200: {
        description: "Tag detail with org and product rollups",
        content: { "application/json": { schema: resolver(TagDetailSchema) } },
      },
      404: {
        description: "Tag not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
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
  },
);
