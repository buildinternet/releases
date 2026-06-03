import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { hideInProduction } from "../openapi.js";
import { and, count, eq, inArray, max, min, sql, type SQL } from "drizzle-orm";
import { parseKindParam, KIND_VALUES } from "@buildinternet/releases-core/kinds";
import { parseNotice, setNoticeInMetadata, type Notice } from "@buildinternet/releases-core/notice";
import { createDb } from "../db.js";
import {
  products,
  productsActive,
  sources,
  sourcesActive,
  releasesVisible,
  organizations,
  orgAccounts,
  tags,
  productTags,
  domainAliases,
} from "@buildinternet/releases-core/schema";
import { toSlug } from "@buildinternet/releases-core/slug";
import { isReservedSlug } from "@buildinternet/releases-core/reserved-slugs";
import { resolveCategoryInput } from "@releases/core-internal/category-alias";
import { validateJson } from "../lib/validate.js";
import {
  ProductListResponseSchema,
  ProductDetailSchema,
  ProductRowSchema,
  ProductCreateResponseSchema,
  CreateProductBodySchema,
  UpdateProductBodySchema,
  AdoptProductBodySchema,
  ProductAdoptResponseSchema,
  ProductDeleteResponseSchema,
  ProductTagsListResponseSchema,
  ProductTagsBodySchema,
  ProductTagsMutationResponseSchema,
  ProductActivityResponseSchema,
  ProductHeatmapResponseSchema,
  CollectionListResponseSchema,
  ErrorResponseSchema,
  ResolveResponseSchema,
} from "@buildinternet/releases-api-types";
import {
  findProductForOrgSlug,
  findSourceForOrgSlug,
  isConflictError,
  getOrCreateTagsD1,
  orgWhere,
  replaceAliases,
  resolveProductFromContext,
  computeAvgPerWeek,
  heatmapDateRange,
} from "../utils.js";
import { buildSourceDetailPayload } from "./sources.js";
import type { Env } from "../index.js";
import { embedAndUpsertEntities, type EntityKind } from "@releases/search/embed-entities.js";
import { buildEmbedConfig } from "@releases/search/embed-config.js";
import { logEvent } from "@releases/lib/log-event";
import { dbErrorLogFields } from "@releases/lib/db-errors";
import { buildListResponse, parseListPagination } from "../lib/pagination.js";
import { IN_ARRAY_CHUNK_SIZE } from "../lib/d1-limits.js";
import { getProductActivityData, getProductHeatmapData } from "../queries/orgs.js";
import { listCollectionsWhere } from "../queries/collections.js";

export const productRoutes = new Hono<Env>();

async function detectSourceSlugShadow(
  db: ReturnType<typeof createDb>,
  orgId: string,
  slug: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.orgId, orgId), eq(sources.slug, slug)))
    .limit(1);
  return Boolean(row);
}

/**
 * Shared product-list query for the bare `GET /products` collection and the
 * org-scoped `GET /orgs/:slug/products`. The two routes differ only in how they
 * build `where`; the projection, `sourceCount` subquery, ordering, pagination,
 * and parallel count are identical — so they live here, in one place.
 */
async function queryProductList(
  db: ReturnType<typeof createDb>,
  where: SQL | undefined,
  pagination: ReturnType<typeof parseListPagination>,
) {
  const [rows, totalRow] = await Promise.all([
    db
      .select({
        id: productsActive.id,
        name: productsActive.name,
        slug: productsActive.slug,
        orgId: productsActive.orgId,
        url: productsActive.url,
        description: productsActive.description,
        createdAt: productsActive.createdAt,
        category: productsActive.category,
        kind: productsActive.kind,
        avatarUrl: productsActive.avatarUrl,
        sourceCount: sql<number>`(SELECT COUNT(*) FROM sources_active s WHERE s.product_id = products_active.id)`,
      })
      .from(productsActive)
      .where(where)
      .orderBy(productsActive.name, productsActive.id)
      .limit(pagination.pageSize)
      .offset(pagination.offset),
    db.select({ n: count() }).from(productsActive).where(where),
  ]);
  return buildListResponse(rows, pagination, Number(totalRow[0]?.n ?? 0));
}

// List products, optionally filtered by orgId and/or kind
productRoutes.get(
  "/products",
  describeRoute({
    tags: ["Products"],
    summary: "List products",
    description:
      "Returns the paginated `{items, pagination}` envelope. Filter by `?orgId=` to scope to one org. Filter by `?kind=` to narrow to a specific entity kind.",
    parameters: [
      {
        name: "orgId",
        in: "query",
        required: false,
        schema: { type: "string" },
        description: "Scope results to one organization by ID.",
      },
      {
        name: "kind",
        in: "query",
        required: false,
        schema: { type: "string", enum: KIND_VALUES as unknown as string[] },
        description: `Filter by entity kind. Direct match on the row's own kind — no inheritance from a parent. One of: ${KIND_VALUES.join(", ")}.`,
      },
    ],
    responses: {
      200: {
        description: "Products list",
        content: { "application/json": { schema: resolver(ProductListResponseSchema) } },
      },
      400: {
        description: "Invalid kind value",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const orgId = c.req.query("orgId");
    const pagination = parseListPagination(new URL(c.req.url).searchParams);

    const kind = parseKindParam(c.req.query("kind"));
    if (kind === null)
      return c.json(
        {
          error: "bad_request",
          message: `Invalid kind. Expected one of: ${KIND_VALUES.join(", ")}`,
        },
        400,
      );

    const conditions = [
      ...(orgId ? [eq(productsActive.orgId, orgId)] : []),
      ...(kind ? [eq(productsActive.kind, kind)] : []),
    ];
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    return c.json(await queryProductList(db, where, pagination));
  },
);

// List one org's products — the canonical org-scoped form of GET /products?orgId=
// (#1225). `:slug` resolves a slug or org_… id; results are always scoped to it.
productRoutes.get(
  "/orgs/:slug/products",
  describeRoute({
    tags: ["Products"],
    summary: "List an organization's products",
    description:
      "Org-scoped product list — the canonical nested form of `GET /products?orgId=`. `:slug` accepts an org slug or `org_…` id. Returns the paginated `{items, pagination}` envelope. Filter by `?kind=` to narrow to a specific entity kind (direct match on the product's own kind).",
    parameters: [
      {
        name: "slug",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: "Organization slug or `org_…` id.",
      },
      {
        name: "kind",
        in: "query",
        required: false,
        schema: { type: "string", enum: KIND_VALUES as unknown as string[] },
        description: `Filter by entity kind. Direct match on the row's own kind — no inheritance from a parent. One of: ${KIND_VALUES.join(", ")}.`,
      },
    ],
    responses: {
      200: {
        description: "Products list",
        content: { "application/json": { schema: resolver(ProductListResponseSchema) } },
      },
      400: {
        description: "Invalid kind value",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const slug = c.req.param("slug");
    const pagination = parseListPagination(new URL(c.req.url).searchParams);

    const kind = parseKindParam(c.req.query("kind"));
    if (kind === null)
      return c.json(
        {
          error: "bad_request",
          message: `Invalid kind. Expected one of: ${KIND_VALUES.join(", ")}`,
        },
        400,
      );

    const [org] = await db
      .select({ id: organizations.id })
      .from(organizations)
      .where(orgWhere(slug));
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    const where = and(
      eq(productsActive.orgId, org.id),
      ...(kind ? [eq(productsActive.kind, kind)] : []),
    );

    return c.json(await queryProductList(db, where, pagination));
  },
);

// Adopt: migrate an org into a product under another org (must be before /:identifier)
productRoutes.post(
  "/products/adopt",
  describeRoute({
    hide: hideInProduction,
    tags: ["Products"],
    summary: "Adopt an org as a product",
    description:
      "Migrates `sourceOrgSlug` into a new product under `targetOrgSlug`. Sources and org_accounts move to the target org; the source org is deleted (cascade removes the now-migrated rows). Pass `dryRun: true` to preview without writing.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Adopt result (live or dry-run preview)",
        content: { "application/json": { schema: resolver(ProductAdoptResponseSchema) } },
      },
      400: {
        description: "Missing required fields",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Source or target org not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      409: {
        description: "Slug conflict or reserved slug",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(AdoptProductBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const body = c.req.valid("json");

    if (body.mergeInto && (body.slug || body.url)) {
      return c.json(
        {
          error: "bad_request",
          message: "mergeInto cannot be combined with slug or url (existing product is reused)",
        },
        400,
      );
    }

    const [sourceOrg] = await db.select().from(organizations).where(orgWhere(body.sourceOrgSlug));
    if (!sourceOrg)
      return c.json(
        { error: "not_found", message: `Source org not found: ${body.sourceOrgSlug}` },
        404,
      );

    const [targetOrg] = await db.select().from(organizations).where(orgWhere(body.targetOrgSlug));
    if (!targetOrg)
      return c.json(
        { error: "not_found", message: `Target org not found: ${body.targetOrgSlug}` },
        404,
      );

    // Self-adopt would have `migrateOrgToProduct` delete the only org and
    // strand the new product — refuse before any writes.
    if (sourceOrg.id === targetOrg.id) {
      return c.json(
        {
          error: "conflict",
          message: "sourceOrgSlug and targetOrgSlug must refer to different orgs",
        },
        409,
      );
    }

    const sourcesToMove = await db
      .select()
      .from(sourcesActive)
      .where(eq(sourcesActive.orgId, sourceOrg.id));

    if (body.mergeInto) {
      // Product slugs are unique per-org, not globally — scope by targetOrg
      // so a slug collision in another org doesn't resolve the wrong row.
      const existingProduct = await findProductForOrgSlug(db, targetOrg.id, body.mergeInto);
      if (!existingProduct) {
        return c.json(
          {
            error: "not_found",
            message: `Product "${body.mergeInto}" not found under org "${targetOrg.slug}"`,
          },
          404,
        );
      }

      if (body.dryRun) {
        return c.json({
          dryRun: true,
          mergeInto: existingProduct.slug,
          product: {
            name: existingProduct.name,
            slug: existingProduct.slug,
            url: existingProduct.url,
            orgSlug: targetOrg.slug,
          },
          sourcesToMove: sourcesToMove.map((s) => s.slug),
          sourceOrgToDelete: sourceOrg.slug,
        });
      }

      const moved = await migrateOrgToProduct(db, sourceOrg.id, targetOrg.id, existingProduct.id);
      return c.json({
        product: existingProduct,
        mergedInto: existingProduct.slug,
        sourcesMoved: moved.sourcesMoved,
        accountsMoved: moved.accountsMoved,
        sourceOrgDeleted: sourceOrg.slug,
      });
    }

    const productSlug = body.slug ?? sourceOrg.slug;
    if (isReservedSlug(productSlug, "nested")) {
      return c.json(
        {
          error: "slug_reserved",
          message: `Slug "${productSlug}" is reserved and cannot be used for a product. Pass an explicit "slug" field to override.`,
          slug: productSlug,
        },
        409,
      );
    }

    const productUrl = body.url ?? (sourceOrg.domain ? `https://${sourceOrg.domain}` : null);

    if (body.dryRun) {
      return c.json({
        dryRun: true,
        product: {
          name: sourceOrg.name,
          slug: productSlug,
          url: productUrl,
          orgSlug: targetOrg.slug,
        },
        sourcesToMove: sourcesToMove.map((s) => s.slug),
        sourceOrgToDelete: sourceOrg.slug,
      });
    }

    let product;
    try {
      [product] = await db
        .insert(products)
        .values({
          name: sourceOrg.name,
          slug: productSlug,
          orgId: targetOrg.id,
          url: productUrl,
          description: sourceOrg.description,
        })
        .returning();
    } catch (err) {
      if (isConflictError(err)) {
        return c.json(
          { error: "conflict", message: `Product with slug "${productSlug}" already exists` },
          409,
        );
      }
      throw err;
    }

    const moved = await migrateOrgToProduct(db, sourceOrg.id, targetOrg.id, product.id);
    return c.json({
      product,
      sourcesMoved: moved.sourcesMoved,
      accountsMoved: moved.accountsMoved,
      sourceOrgDeleted: sourceOrg.slug,
    });
  },
);

/**
 * Move every source + org_account from `sourceOrgId` to `targetOrgId` (linking
 * sources to `productId`), then delete the now-empty source org. Steps run in
 * order — the org delete must come last because its FKs cascade.
 */
async function migrateOrgToProduct(
  db: ReturnType<typeof createDb>,
  sourceOrgId: string,
  targetOrgId: string,
  productId: string,
): Promise<{ sourcesMoved: number; accountsMoved: number }> {
  const movedSources = await db
    .update(sources)
    .set({ orgId: targetOrgId, productId })
    .where(eq(sources.orgId, sourceOrgId))
    .returning({ id: sources.id });

  const accountsToMove = await db
    .select()
    .from(orgAccounts)
    .where(eq(orgAccounts.orgId, sourceOrgId));
  // org_accounts insert binds 5 cols/row (id default + orgId + platform +
  // handle + createdAt). D1 caps prepared-statement params at 100, so
  // chunk at floor(100 / 5) = 20 to stay under the limit on busy orgs.
  const ACCOUNTS_INSERT_CHUNK = 20;
  for (let i = 0; i < accountsToMove.length; i += ACCOUNTS_INSERT_CHUNK) {
    const chunk = accountsToMove.slice(i, i + ACCOUNTS_INSERT_CHUNK);
    // oxlint-disable-next-line no-await-in-loop -- sequential chunks under the D1 bind-param cap
    await db
      .insert(orgAccounts)
      .values(
        chunk.map((a) => ({
          orgId: targetOrgId,
          platform: a.platform,
          handle: a.handle,
          createdAt: a.createdAt,
        })),
      )
      .onConflictDoNothing();
  }

  await db.delete(organizations).where(eq(organizations.id, sourceOrgId));

  return { sourcesMoved: movedSources.length, accountsMoved: accountsToMove.length };
}

export async function buildProductDetailPayload(
  db: ReturnType<typeof createDb>,
  product: typeof products.$inferSelect,
) {
  const [productSources, tagRows, aliasRows] = await Promise.all([
    db
      .select({
        id: sourcesActive.id,
        slug: sourcesActive.slug,
        name: sourcesActive.name,
        type: sourcesActive.type,
        url: sourcesActive.url,
        metadata: sourcesActive.metadata,
        kind: sourcesActive.kind,
      })
      .from(sourcesActive)
      .where(eq(sourcesActive.productId, product.id))
      .orderBy(sourcesActive.name),
    db
      .select({ name: tags.name })
      .from(productTags)
      .innerJoin(tags, eq(productTags.tagId, tags.id))
      .where(eq(productTags.productId, product.id))
      .orderBy(tags.name),
    db
      .select({ domain: domainAliases.domain })
      .from(domainAliases)
      .where(eq(domainAliases.productId, product.id))
      .orderBy(domainAliases.domain),
  ]);

  const { metadata, ...productRow } = product;
  return {
    ...productRow,
    sources: productSources,
    tags: tagRows.map((t) => t.name),
    aliases: aliasRows.map((a) => a.domain),
    notice: parseNotice(metadata),
  };
}

// Get product by id (preferred) or slug. Registered at both the bare
// `/products/:identifier` path and the org-scoped `/orgs/:orgSlug/products/:productSlug`.
const getProductDetailHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const product = await resolveProductFromContext(c, db);
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);
  return c.json(await buildProductDetailPayload(db, product));
};
const getProductDetailRoute = describeRoute({
  tags: ["Products"],
  summary: "Get product detail",
  description:
    "Resolves by slug or `prod_…` ID on the bare path, or by org-scoped slug pair. Returns the product row plus its sources, tags, and domain aliases.",
  responses: {
    200: {
      description: "Product detail with sources, tags, and aliases",
      content: { "application/json": { schema: resolver(ProductDetailSchema) } },
    },
    400: {
      description:
        "Bare slug supplied on `/products/:identifier` (#698 — use the org-scoped path or `/v1/lookups/product-by-slug`)",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Product not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
productRoutes.get("/products/:identifier", getProductDetailRoute, getProductDetailHandler);
productRoutes.get(
  "/orgs/:orgSlug/products/:productSlug",
  getProductDetailRoute,
  getProductDetailHandler,
);

// Create product
productRoutes.post(
  "/products",
  describeRoute({
    hide: hideInProduction,
    tags: ["Products"],
    summary: "Create product",
    description:
      "Requires `orgId` or `orgSlug` (one must be set). Slug derived from `name` when omitted. `category` is resolved through the alias overlay before persisting. Returns the raw product row (201).",
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: "Product created",
        content: { "application/json": { schema: resolver(ProductCreateResponseSchema) } },
      },
      400: {
        description: "Missing required fields or invalid category",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Organization not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      409: {
        description: "Slug conflict or reserved slug",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(CreateProductBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const body: {
      orgId?: string;
      orgSlug?: string;
      name: string;
      slug?: string;
      url?: string;
      description?: string;
      category?: string;
      tags?: string[];
      kind?: string | null;
    } = { ...c.req.valid("json") };

    // Cross-field: at least one of orgId/orgSlug must be set. Can't express
    // cleanly via `.refine` while keeping a useful per-field error path, so
    // it stays in the handler.
    if (!body.orgId && !body.orgSlug) {
      return c.json(
        { error: "bad_request", message: "Missing required fields: orgId or orgSlug" },
        400,
      );
    }

    const orgCond = body.orgId ? eq(organizations.id, body.orgId) : orgWhere(body.orgSlug!);
    const [org] = await db.select().from(organizations).where(orgCond);
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    if (body.category) {
      const resolved = await resolveCategoryInput(db, body.category);
      if (!resolved.ok) {
        return c.json(
          { error: "bad_request", message: `Invalid category: "${body.category}"` },
          400,
        );
      }
      body.category = resolved.slug;
    }

    const slug = body.slug ?? toSlug(body.name);
    if (isReservedSlug(slug, "nested")) {
      return c.json(
        {
          error: "slug_reserved",
          message: `Slug "${slug}" is reserved and cannot be used for a product. Choose a different slug or rename the product.`,
          slug,
        },
        409,
      );
    }

    const shadowed = await detectSourceSlugShadow(db, org.id, slug);
    if (shadowed) {
      logEvent("warn", {
        component: "products",
        event: "slug-shadows-source",
        orgId: org.id,
        slug,
      });
    }

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
          kind: body.kind ?? null,
        })
        .returning();

      if (body.tags && body.tags.length > 0) {
        const tagRows = await getOrCreateTagsD1(db, body.tags);
        const now = new Date().toISOString();
        await db
          .insert(productTags)
          .values(tagRows.map((t) => ({ productId: created.id, tagId: t.id, createdAt: now })))
          .onConflictDoNothing();
      }

      c.executionCtx.waitUntil(embedProductSideEffect(c.env, db, created.id));
      return c.json(
        shadowed
          ? {
              ...created,
              warning: `Product slug "${slug}" shadows an existing source in this org; the product will win the bare URL.`,
            }
          : created,
        201,
      );
    } catch (err) {
      if (isConflictError(err)) {
        return c.json(
          { error: "conflict", message: `Product with slug "${slug}" already exists` },
          409,
        );
      }
      throw err;
    }
  },
);

const patchProductHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  // The validator middleware (registered alongside this handler) parsed the
  // body. Hono's static type for this standalone handler doesn't carry the
  // schema, so reach for the parsed payload via the bodyCache through a
  // narrow cast rather than `c.req.valid()`. Same shape at runtime.
  const body: {
    name?: string;
    url?: string | null;
    description?: string | null;
    category?: string | null;
    tags?: string[];
    aliases?: string[];
    kind?: string | null;
    avatarUrl?: string | null;
    notice?: Notice | null;
  } = {
    ...(c.req as unknown as { valid: (target: "json") => Record<string, unknown> }).valid("json"),
  };

  const product = await resolveProductFromContext(c, db);
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const updates: Record<string, string | null> = {};
  if (body.name) updates.name = body.name;
  if (body.url !== undefined) updates.url = body.url;
  if (body.description !== undefined) updates.description = body.description;

  if (body.category !== undefined && body.category !== null) {
    const resolved = await resolveCategoryInput(db, body.category);
    if (!resolved.ok) {
      return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
    }
    body.category = resolved.slug;
  }
  if (body.category !== undefined) updates.category = body.category;
  if ("kind" in body) updates.kind = body.kind ?? null;
  if (body.avatarUrl !== undefined) updates.avatarUrl = body.avatarUrl;
  if (body.notice !== undefined)
    updates.metadata = setNoticeInMetadata(product.metadata, body.notice);

  if (Object.keys(updates).length === 0 && body.tags === undefined && body.aliases === undefined) {
    return c.json(product);
  }

  let updated = product;
  if (Object.keys(updates).length > 0) {
    [updated] = await db
      .update(products)
      .set(updates)
      .where(eq(products.id, product.id))
      .returning();
  }

  if (body.tags !== undefined) {
    await db.delete(productTags).where(eq(productTags.productId, product.id));
    if (body.tags.length > 0) {
      const tagRows = await getOrCreateTagsD1(db, body.tags);
      const now = new Date().toISOString();
      await db
        .insert(productTags)
        .values(tagRows.map((t) => ({ productId: product.id, tagId: t.id, createdAt: now })))
        .onConflictDoNothing();
    }
  }

  if (body.aliases !== undefined) {
    const { conflict } = await replaceAliases(db, {
      productId: product.id,
      aliases: body.aliases,
    });
    if (conflict)
      return c.json(
        {
          error: "conflict",
          message: `Domain alias "${conflict}" already claimed by another org or product`,
        },
        409,
      );
  }

  const semanticChanged =
    body.name !== undefined ||
    body.description !== undefined ||
    body.category !== undefined ||
    body.url !== undefined;
  if (semanticChanged) {
    c.executionCtx.waitUntil(embedProductSideEffect(c.env, db, product.id));
  }

  return c.json(updated);
};
const patchProductRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Products"],
  summary: "Update product",
  description:
    "All body fields optional. Re-embeds the product in Vectorize when `name`, `description`, `category`, or `url` changes. `tags` (when provided) replaces the full tag set; `aliases` (when provided) replaces the full domain-alias set and rejects with 409 on cross-entity collisions.",
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: "Product updated (returns the raw product row)",
      content: { "application/json": { schema: resolver(ProductRowSchema) } },
    },
    400: {
      description: "Invalid category or bare slug supplied on the bare path",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Product not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    409: {
      description: "Domain alias collision",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});
productRoutes.patch(
  "/products/:slug",
  patchProductRoute,
  validateJson(UpdateProductBodySchema),
  patchProductHandler,
);
productRoutes.patch(
  "/orgs/:orgSlug/products/:productSlug",
  patchProductRoute,
  validateJson(UpdateProductBodySchema),
  patchProductHandler,
);

productRoutes.get(
  "/products/:identifier/tags",
  describeRoute({
    tags: ["Products"],
    summary: "List product tags",
    description:
      "Returns the product's tag names sorted alphabetically. Empty array when the product has no tags. Only a typed `prod_…` ID resolves on this path; bare slugs return 400 (#698). Slug-only callers should first resolve via `GET /v1/lookups/product-by-slug?slug=…` and re-hit this endpoint with the returned `productId`.",
    responses: {
      200: {
        description: "Tag names",
        content: { "application/json": { schema: resolver(ProductTagsListResponseSchema) } },
      },
      400: {
        description: "Bare slug supplied on `/products/:identifier/tags`",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Product not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const product = await resolveProductFromContext(c, db);
    if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

    const rows = await db
      .select({ name: tags.name })
      .from(productTags)
      .innerJoin(tags, eq(productTags.tagId, tags.id))
      .where(eq(productTags.productId, product.id))
      .orderBy(tags.name);
    return c.json(rows.map((r) => r.name));
  },
);

productRoutes.put(
  "/products/:identifier/tags",
  describeRoute({
    hide: hideInProduction,
    tags: ["Products"],
    summary: "Add tags to a product",
    description:
      "Adds the named tags to the product (get-or-create — unknown names land a row in `tags`). Idempotent: tags already attached are no-ops via `ON CONFLICT DO NOTHING`.\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Tags added",
        content: { "application/json": { schema: resolver(ProductTagsMutationResponseSchema) } },
      },
      400: {
        description: "Malformed body, or bare slug supplied on `/products/:identifier/tags`",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Product not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(ProductTagsBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const { tags: tagNames } = c.req.valid("json");
    const product = await resolveProductFromContext(c, db);
    if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

    if (tagNames.length > 0) {
      const tagRows = await getOrCreateTagsD1(db, tagNames);
      const now = new Date().toISOString();
      await db
        .insert(productTags)
        .values(tagRows.map((t) => ({ productId: product.id, tagId: t.id, createdAt: now })))
        .onConflictDoNothing();
    }
    return c.json({ ok: true });
  },
);

productRoutes.delete(
  "/products/:identifier/tags",
  describeRoute({
    hide: hideInProduction,
    tags: ["Products"],
    summary: "Remove tags from a product",
    description:
      "Removes each named tag from the product — names are slugified via `toSlug()` before lookup, so display-cased input still matches. Unknown tag names are silently skipped (idempotent).\n\nAuth inherited from `publicReadAuthMiddleware`'s non-SAFE_METHODS branch — Bearer token required.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Tags removed",
        content: { "application/json": { schema: resolver(ProductTagsMutationResponseSchema) } },
      },
      400: {
        description: "Malformed body, or bare slug supplied on `/products/:identifier/tags`",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Product not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  validateJson(ProductTagsBodySchema),
  async (c) => {
    const db = createDb(c.env.DB);
    const { tags: tagNames } = c.req.valid("json");
    const product = await resolveProductFromContext(c, db);
    if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

    const slugs = Array.from(new Set(tagNames.map((t) => toSlug(t))));
    if (slugs.length === 0) return c.json({ ok: true });
    // Single DELETE per chunk via a tag-slug subquery — the per-name SELECT
    // phase folds into the DELETE. For the typical request (<= IN_ARRAY_CHUNK_SIZE
    // tags) this is one D1 round-trip total.
    for (let i = 0; i < slugs.length; i += IN_ARRAY_CHUNK_SIZE) {
      const chunk = slugs.slice(i, i + IN_ARRAY_CHUNK_SIZE);
      const tagIdsForSlugs = db.select({ id: tags.id }).from(tags).where(inArray(tags.slug, chunk));
      // oxlint-disable-next-line no-await-in-loop -- chunked DELETE
      await db
        .delete(productTags)
        .where(
          and(eq(productTags.productId, product.id), inArray(productTags.tagId, tagIdsForSlugs)),
        );
    }
    return c.json({ ok: true });
  },
);

// Delete product
productRoutes.delete(
  "/products/:identifier",
  describeRoute({
    hide: hideInProduction,
    tags: ["Products"],
    summary: "Delete product",
    description:
      "Soft-deletes by default — sets `deletedAt` and renames the slug to `<slug>--<id>` so the inline UNIQUE doesn't block re-onboarding. Pass `?hard=true` to permanently remove the row (cascades to product_tags and domain_aliases). Hard-delete reaches tombstones; pass a `prod_…` ID for that path.",
    security: [{ bearerAuth: [] }],
    responses: {
      200: {
        description: "Product deleted (soft or hard)",
        content: { "application/json": { schema: resolver(ProductDeleteResponseSchema) } },
      },
      400: {
        description: "Bare slug supplied on `/products/:identifier`",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
      404: {
        description: "Product not found",
        content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const hard = c.req.query("hard") === "true";

    // includeDeleted lets hard-delete reach tombstones for purge. Tombstones
    // rename their slug to "<slug>--<id>" so a normal slug-path lookup wouldn't
    // collide with a live row; passing a `prod_` ID is the canonical way to
    // reach a tombstone.
    const product = await resolveProductFromContext(c, db, { includeDeleted: hard });
    if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

    if (hard) {
      await db.delete(products).where(eq(products.id, product.id));
      return c.json({ deleted: true, hard: true });
    }

    // Soft delete: rename slug so the inline UNIQUE doesn't block re-onboarding.
    const now = new Date().toISOString();
    await db
      .update(products)
      .set({ deletedAt: now, slug: `${product.slug}--${product.id}` })
      .where(eq(products.id, product.id));
    return c.json({ deleted: true, deletedAt: now });
  },
);

// ── Resolve: product-first slug resolution for /[org]/[slug] ──

const resolveRoute = describeRoute({
  tags: ["Orgs"],
  summary: "Resolve an org-scoped slug to a product or source",
  description:
    'Product-first: returns `{ kind: "product", product }` when a product owns the slug, else `{ kind: "source", source }` for a source, else 404. One round trip for the bare `/[org]/[slug]` web route (#1190).',
  parameters: [
    {
      name: "org",
      in: "path",
      required: true,
      schema: { type: "string" },
      description: "Organization slug or `org_…` ID.",
    },
    {
      name: "slug",
      in: "path",
      required: true,
      schema: { type: "string" },
      description: "Org-scoped product or source slug to resolve (product-first).",
    },
  ],
  responses: {
    200: {
      description: "Discriminated product or source detail",
      content: { "application/json": { schema: resolver(ResolveResponseSchema) } },
    },
    404: {
      description: "Neither a product nor a source matched",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});

const resolveHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const org = c.req.param("org");
  const slug = c.req.param("slug");
  if (!org || !slug) return c.json({ error: "bad_request", message: "org and slug required" }, 400);

  const product = await findProductForOrgSlug(db, org, slug);
  if (product) {
    return c.json({ kind: "product", product: await buildProductDetailPayload(db, product) });
  }
  const src = await findSourceForOrgSlug(db, org, slug);
  if (src) {
    return c.json({
      kind: "source",
      source: await buildSourceDetailPayload(db, src, {
        cursor: null,
        limit: 20,
        includeCoverage: false,
        includePrereleases: false,
        d1: c.env.DB,
        mediaOrigin: c.env.MEDIA_ORIGIN ?? "",
      }),
    });
  }
  return c.json({ error: "not_found", message: "No product or source for that slug" }, 404);
};

productRoutes.get("/orgs/:org/resolve/:slug", resolveRoute, resolveHandler);

// ── Embed side effect ──

async function embedProductSideEffect(
  env: Env["Bindings"],
  db: ReturnType<typeof createDb>,
  productId: string,
): Promise<void> {
  try {
    const embedConfig = await buildEmbedConfig(env);
    if (!embedConfig) return;
    const [product] = await db.select().from(products).where(eq(products.id, productId));
    if (!product) return;
    let domain: string | null = null;
    if (product.url) {
      try {
        domain = new URL(product.url).hostname;
      } catch {
        domain = null;
      }
    }
    await embedAndUpsertEntities({
      entities: [
        {
          id: product.id,
          kind: "product" as EntityKind,
          name: product.name,
          description: product.description,
          category: product.category,
          domain,
          orgId: product.orgId ?? null,
        },
      ],
      // Cast: workers-types VectorizeIndex has a stricter metadata value
      // type than the shared runtime-agnostic interface.
      vectorIndex:
        env.ENTITIES_INDEX as unknown as import("@releases/search/vector-search.js").VectorizeIndex,
      embedConfig,
      onPersisted: async () => {
        await db
          .update(products)
          .set({ embeddedAt: new Date().toISOString() })
          .where(eq(products.id, product.id));
      },
    });
  } catch (err) {
    logEvent("warn", {
      component: "products",
      event: "embed-side-effect-failed",
      err: err instanceof Error ? err : String(err),
      ...dbErrorLogFields(err),
    });
  }
}

// ── Product activity + heatmap ──

function isValidCalendarDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]),
    mo = Number(m[2]),
    d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

const getProductActivityHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const product = await resolveProductFromContext(c, db);
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  // Validate date params
  const fromParam = c.req.query("from");
  const toParam = c.req.query("to");

  if (fromParam && !isValidCalendarDate(fromParam)) {
    return c.json(
      { error: "bad_request", message: "Invalid date format for 'from'. Use YYYY-MM-DD." },
      400,
    );
  }
  if (toParam && !isValidCalendarDate(toParam)) {
    return c.json(
      { error: "bad_request", message: "Invalid date format for 'to'. Use YYYY-MM-DD." },
      400,
    );
  }
  if (fromParam && toParam && fromParam > toParam) {
    return c.json({ error: "bad_request", message: "'from' must be before 'to'." }, 400);
  }

  // Fetch all active sources for this product
  const productSources = await db
    .select({ id: sourcesActive.id, slug: sourcesActive.slug, name: sourcesActive.name })
    .from(sourcesActive)
    .where(eq(sourcesActive.productId, product.id))
    .orderBy(sourcesActive.name);

  if (productSources.length === 0) {
    const today = new Date().toISOString().slice(0, 10);
    return c.json({
      product: { slug: product.slug, name: product.name },
      range: { from: fromParam ?? today, to: toParam ?? today },
      sources: [],
      aggregateWeekly: [],
    });
  }

  const sourceIds = productSources.map((s) => s.id);

  // Default range: oldest to newest release across all product sources
  let from = fromParam;
  let to = toParam;
  if (!from || !to) {
    const [bounds] = await db
      .select({
        oldest: min(releasesVisible.publishedAt),
        newest: max(releasesVisible.publishedAt),
      })
      .from(releasesVisible)
      .where(
        and(
          inArray(releasesVisible.sourceId, sourceIds),
          sql`${releasesVisible.publishedAt} IS NOT NULL`,
        ),
      );
    const today = new Date().toISOString().slice(0, 10);
    if (!from) from = bounds.oldest?.slice(0, 10) ?? today;
    if (!to) to = bounds.newest?.slice(0, 10) ?? today;
  }

  // Compute exclusive upper bound for inclusive to-date
  const toDate = new Date(to + "T00:00:00Z");
  toDate.setUTCDate(toDate.getUTCDate() + 1);
  const toExclusive = toDate.toISOString().slice(0, 10);

  const {
    bucketRows,
    statsRows,
    latestVersionRows: versionRows,
    earliestVersionRows,
  } = await getProductActivityData(db, product.id, from, toExclusive);

  const latestVersionBySource = new Map<string, string | null>();
  for (const row of versionRows) {
    latestVersionBySource.set(row.source_id, row.version);
  }

  const earliestVersionBySource = new Map<string, string | null>();
  for (const row of earliestVersionRows) {
    earliestVersionBySource.set(row.source_id, row.version);
  }

  // Index stats and buckets by source ID
  const statsMap = new Map(statsRows.map((r) => [r.source_id, r]));
  const bucketMap = new Map<
    string,
    {
      weekStart: string;
      count: number;
      earliestVersion: string | null;
      latestVersion: string | null;
    }[]
  >();
  for (const row of bucketRows) {
    let arr = bucketMap.get(row.source_id);
    if (!arr) {
      arr = [];
      bucketMap.set(row.source_id, arr);
    }
    arr.push({
      weekStart: row.week_start,
      count: row.cnt,
      earliestVersion: row.earliest_version ?? null,
      latestVersion: row.latest_version ?? null,
    });
  }

  // Assemble per-source response
  const sourcesOut = productSources.map((src) => {
    const stats = statsMap.get(src.id);
    const total = stats?.total ?? 0;
    const oldest = stats?.oldest ?? null;
    const latestDate = stats?.latest_date ?? null;

    return {
      slug: src.slug,
      name: src.name,
      releaseCount: total,
      avgReleasesPerWeek: computeAvgPerWeek(total, oldest),
      earliestVersion: earliestVersionBySource.get(src.id) ?? null,
      latestVersion: latestVersionBySource.get(src.id) ?? null,
      latestDate,
      weeklyBuckets: bucketMap.get(src.id) ?? [],
    };
  });

  // Aggregate weekly buckets across all sources
  const aggMap = new Map<string, number>();
  for (const row of bucketRows) {
    aggMap.set(row.week_start, (aggMap.get(row.week_start) ?? 0) + row.cnt);
  }
  const aggregateWeekly = Array.from(aggMap.entries())
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, releaseCount]) => ({ weekStart, count: releaseCount }));

  return c.json({
    product: { slug: product.slug, name: product.name },
    range: { from, to },
    sources: sourcesOut,
    aggregateWeekly,
  });
};

const getProductActivityRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Products"],
  summary: "Product release activity (weekly buckets)",
  description:
    "Returns per-source weekly release buckets across the product, plus an aggregate rollup. Used for timeline / chart visualization. Accepts optional `?from=YYYY-MM-DD` and `?to=YYYY-MM-DD` date bounds — defaults to the earliest/latest release across all sources when omitted.",
  parameters: [
    {
      name: "from",
      in: "query",
      required: false,
      schema: { type: "string", format: "date" },
      description: "Start date (inclusive, YYYY-MM-DD). Defaults to oldest release date.",
    },
    {
      name: "to",
      in: "query",
      required: false,
      schema: { type: "string", format: "date" },
      description: "End date (inclusive, YYYY-MM-DD). Defaults to newest release date.",
    },
  ],
  responses: {
    200: {
      description: "Activity data",
      content: { "application/json": { schema: resolver(ProductActivityResponseSchema) } },
    },
    400: {
      description: "Invalid date format or range",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
    404: {
      description: "Product not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});

productRoutes.get("/products/:slug/activity", getProductActivityRoute, getProductActivityHandler);
productRoutes.get(
  "/orgs/:orgSlug/products/:productSlug/activity",
  getProductActivityRoute,
  getProductActivityHandler,
);

const getProductHeatmapHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const product = await resolveProductFromContext(c, db);
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const { from, to, toExclusive } = heatmapDateRange();
  const { rows, total } = await getProductHeatmapData(db, product.id, from, toExclusive);

  return c.json({
    product: { slug: product.slug, name: product.name },
    range: { from, to },
    dailyCounts: rows.map((r) => ({ date: r.date, count: r.cnt })),
    total,
  });
};

const getProductHeatmapRoute = describeRoute({
  hide: hideInProduction,
  tags: ["Products"],
  summary: "Product release heatmap (daily counts)",
  description:
    "Returns daily release counts for the trailing 365 days — used for the contribution-graph visualization on the product detail page. Range is fixed server-side; no date parameters accepted.",
  responses: {
    200: {
      description: "Heatmap data",
      content: { "application/json": { schema: resolver(ProductHeatmapResponseSchema) } },
    },
    404: {
      description: "Product not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});

productRoutes.get("/products/:slug/heatmap", getProductHeatmapRoute, getProductHeatmapHandler);
productRoutes.get(
  "/orgs/:orgSlug/products/:productSlug/heatmap",
  getProductHeatmapRoute,
  getProductHeatmapHandler,
);

// ── Product collections (/products/:slug/collections, /orgs/:orgSlug/products/:productSlug/collections) ──

const getProductCollectionsHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);
  const product = await resolveProductFromContext(c, db);
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const body = await listCollectionsWhere(
    db,
    sql`c.id IN (SELECT cm.collection_id FROM collection_members cm WHERE cm.product_id = ${product.id})`,
  );
  return c.json(body);
};

const getProductCollectionsRoute = describeRoute({
  tags: ["Products"],
  summary: "Collections this product belongs to",
  description:
    "Returns the curated collections that pin this product, ordered alphabetically by collection name. Mirrors `GET /v1/orgs/:slug/collections` so the web 'Featured in' sidebar renders identically at the org and product levels — a `coding-agents` collection that pins Claude Code surfaces on the Claude Code product page. Each item includes `memberCount` (visible public orgs + products).",
  responses: {
    200: {
      description: "Collection membership list",
      content: { "application/json": { schema: resolver(CollectionListResponseSchema) } },
    },
    404: {
      description: "Product not found",
      content: { "application/json": { schema: resolver(ErrorResponseSchema) } },
    },
  },
});

productRoutes.get(
  "/products/:slug/collections",
  getProductCollectionsRoute,
  getProductCollectionsHandler,
);
productRoutes.get(
  "/orgs/:orgSlug/products/:productSlug/collections",
  getProductCollectionsRoute,
  getProductCollectionsHandler,
);
