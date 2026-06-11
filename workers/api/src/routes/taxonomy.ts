import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import { eq, count, isNotNull, inArray, sql } from "drizzle-orm";
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
import { loadAliasMap } from "@releases/core-internal/category-alias";
import { getCategoryReleasesFeed } from "@releases/core-internal/category-feed";
import {
  buildFeedCursor,
  formatAggregateReleaseRow,
  parseBoolParam,
  parseLimitParam,
} from "../utils.js";
import { parseSourceTypesLenient } from "../lib/source-types.js";
import { wantsMarkdown, markdownResponse } from "../middleware/content-negotiation.js";
import { categoryReleaseFeedToMarkdown } from "@releases/rendering/formatters.js";
import type { Env } from "../index.js";
import type {
  CategoryDetail,
  CategoryListItem,
  CategoryReleaseItem,
  CollectionMember,
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

// Avatar facepile preview on `GET /v1/categories`. Cap shown on the wire; fetch
// a couple extra candidates per bucket so the org/product dedupe below still has
// `PREVIEW_LIMIT` to work with.
const PREVIEW_LIMIT = 3;
const PREVIEW_FETCH = 6;

type OrgPreviewRow = {
  category: string;
  slug: string;
  name: string;
  domain: string | null;
  avatarUrl: string | null;
};
type ProductPreviewRow = {
  category: string;
  productSlug: string;
  productName: string;
  productDescription: string | null;
  orgSlug: string;
  orgName: string;
  orgDomain: string | null;
  orgAvatarUrl: string | null;
};

const groupBy = <T extends { category: string }>(rows: T[]): Map<string, T[]> => {
  const m = new Map<string, T[]>();
  for (const r of rows) {
    const arr = m.get(r.category);
    if (arr) arr.push(r);
    else m.set(r.category, [r]);
  }
  return m;
};

// Build the mixed-kind facepile preview for one category: orgs first (they carry
// the avatar), then products fill any remaining slots, skipping products whose
// parent org is already shown so the same logo never repeats. `githubHandle` is
// null — the same trade-off the category *detail* page makes — so the preview
// avoids a per-row `org_accounts` lookup; OrgAvatar falls back to a monogram.
function buildCategoryPreview(
  orgs: OrgPreviewRow[],
  products: ProductPreviewRow[],
): CollectionMember[] {
  const preview: CollectionMember[] = orgs.slice(0, PREVIEW_LIMIT).map((o) => ({
    kind: "org",
    slug: o.slug,
    name: o.name,
    domain: o.domain,
    avatarUrl: o.avatarUrl,
    githubHandle: null,
    description: null,
  }));
  if (preview.length < PREVIEW_LIMIT) {
    const shownOrgSlugs = new Set(orgs.map((o) => o.slug));
    for (const p of products) {
      if (preview.length >= PREVIEW_LIMIT) break;
      if (shownOrgSlugs.has(p.orgSlug)) continue;
      shownOrgSlugs.add(p.orgSlug);
      preview.push({
        kind: "product",
        slug: p.productSlug,
        name: p.productName,
        description: p.productDescription,
        org: {
          slug: p.orgSlug,
          name: p.orgName,
          domain: p.orgDomain,
          avatarUrl: p.orgAvatarUrl,
          githubHandle: null,
        },
      });
    }
  }
  return preview;
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

    const [orgRows, productRows, metaRows, orgPreviewRows, productPreviewRows] = await Promise.all([
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
      // Top-N orgs/products per category for the facepile preview. Windowed so
      // the scan returns ~PREVIEW_FETCH rows per bucket instead of the whole
      // catalog; avatar-bearing rows sort first so the preview shows logos.
      db.all<OrgPreviewRow>(sql`
        SELECT category, slug, name, domain, avatarUrl FROM (
          SELECT op.category AS category, op.slug AS slug, op.name AS name,
                 op.domain AS domain, op.avatar_url AS avatarUrl,
                 ROW_NUMBER() OVER (
                   PARTITION BY op.category ORDER BY (op.avatar_url IS NULL), op.name
                 ) AS rn
          FROM ${organizationsPublic} op
          WHERE op.category IS NOT NULL
        ) WHERE rn <= ${PREVIEW_FETCH}
      `),
      db.all<ProductPreviewRow>(sql`
        SELECT category, productSlug, productName, productDescription,
               orgSlug, orgName, orgDomain, orgAvatarUrl FROM (
          SELECT pa.category AS category, pa.slug AS productSlug, pa.name AS productName,
                 pa.description AS productDescription, op.slug AS orgSlug, op.name AS orgName,
                 op.domain AS orgDomain, op.avatar_url AS orgAvatarUrl,
                 ROW_NUMBER() OVER (
                   PARTITION BY pa.category ORDER BY (op.avatar_url IS NULL), pa.name
                 ) AS rn
          FROM ${productsActive} pa
          INNER JOIN ${organizationsPublic} op ON op.id = pa.org_id
          WHERE pa.category IS NOT NULL
        ) WHERE rn <= ${PREVIEW_FETCH}
      `),
    ]);

    const orgCounts = toCategoryCountMap(orgRows);
    const productCounts = toCategoryCountMap(productRows);
    const metaMap = toMetaMap(metaRows.map(toMetaRow));
    const orgPreviewByCat = groupBy(orgPreviewRows);
    const productPreviewByCat = groupBy(productPreviewRows);

    const body: CategoryListItem[] = CATEGORIES.map((slug) => {
      const display = resolveCategoryDisplay(slug, metaMap.get(slug));
      return {
        slug,
        name: display.name,
        description: display.description,
        aliases: display.aliases,
        orgCount: orgCounts.get(slug) ?? 0,
        productCount: productCounts.get(slug) ?? 0,
        previewMembers: buildCategoryPreview(
          orgPreviewByCat.get(slug) ?? [],
          productPreviewByCat.get(slug) ?? [],
        ),
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
    hide: hideInProduction,
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
      {
        name: "orgs",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Comma-separated org slugs to narrow the feed to a subset of the category's orgs. Unknown slugs are silently dropped; passing an `orgs=` value that resolves to nothing returns `releases: []`. Omit to include all orgs in the category.",
      },
      {
        name: "source_type",
        in: "query",
        required: false,
        schema: { type: "string" },
        description:
          "Comma-separated source types (`github`, `feed`, `scrape`, `agent`) to narrow the feed by ingest channel. Unknown tokens are silently dropped. Omit to include all source types.",
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
    const rawSourceType = c.req.query("source_type");
    const sourceTypes =
      rawSourceType === undefined ? undefined : parseSourceTypesLenient(rawSourceType);
    const orgsParam = c.req.query("orgs");
    const orgSlugs =
      orgsParam === undefined
        ? undefined
        : orgsParam
            .split(",")
            .map((s) => s.trim().toLowerCase())
            .filter((s) => s.length > 0);

    const results = await getCategoryReleasesFeed(db, slug, cursorParam, limit + 1, {
      includePrereleases,
      sourceTypes,
      orgSlugs,
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
