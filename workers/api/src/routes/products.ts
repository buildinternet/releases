import { Hono } from "hono";
import { describeRoute, resolver } from "hono-openapi";
import { and, count, eq, sql } from "drizzle-orm";
import { createDb } from "../db.js";
import {
  products,
  productsActive,
  sources,
  sourcesActive,
  organizations,
  orgAccounts,
  tags,
  productTags,
  domainAliases,
} from "@buildinternet/releases-core/schema";
import { toSlug } from "@buildinternet/releases-core/slug";
import { isReservedSlug } from "@buildinternet/releases-core/reserved-slugs";
import { isValidCategory } from "@buildinternet/releases-core/categories";
import {
  ProductListResponseSchema,
  ProductDetailSchema,
  ProductRowSchema,
  ProductAdoptResponseSchema,
  ProductDeleteResponseSchema,
  ErrorResponseSchema,
} from "@buildinternet/releases-api-types";
import {
  findProductForOrgSlug,
  isConflictError,
  getOrCreateTagsD1,
  orgWhere,
  replaceAliases,
  resolveProductFromContext,
} from "../utils.js";
import type { Env } from "../index.js";
import { embedAndUpsertEntities, type EntityKind } from "@releases/search/embed-entities.js";
import { buildEmbedConfig } from "../lib/embed-config.js";
import { logEvent } from "@releases/lib/log-event";
import { buildListResponse, parseListPagination } from "../lib/pagination.js";

export const productRoutes = new Hono<Env>();

// List products, optionally filtered by orgId
productRoutes.get(
  "/products",
  describeRoute({
    tags: ["Products"],
    summary: "List products",
    description:
      "Returns the paginated `{items, pagination}` envelope. Filter by `?orgId=` to scope to one org.",
    responses: {
      200: {
        description: "Products list",
        content: { "application/json": { schema: resolver(ProductListResponseSchema) } },
      },
    },
  }),
  async (c) => {
    const db = createDb(c.env.DB);
    const orgId = c.req.query("orgId");
    const pagination = parseListPagination(new URL(c.req.url).searchParams);

    const where = orgId ? eq(productsActive.orgId, orgId) : undefined;
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
          sourceCount: sql<number>`(SELECT COUNT(*) FROM sources_active s WHERE s.product_id = products_active.id)`,
        })
        .from(productsActive)
        .where(where)
        .orderBy(productsActive.name, productsActive.id)
        .limit(pagination.pageSize)
        .offset(pagination.offset),
      db.select({ n: count() }).from(productsActive).where(where),
    ]);

    return c.json(buildListResponse(rows, pagination, Number(totalRow[0]?.n ?? 0)));
  },
);

// Adopt: migrate an org into a product under another org (must be before /:identifier)
productRoutes.post(
  "/products/adopt",
  describeRoute({
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
  async (c) => {
    const db = createDb(c.env.DB);
    const body = await c.req.json<{
      sourceOrgSlug: string;
      targetOrgSlug: string;
      slug?: string;
      url?: string;
      mergeInto?: string;
      dryRun?: boolean;
    }>();

    if (!body.sourceOrgSlug || !body.targetOrgSlug) {
      return c.json(
        { error: "bad_request", message: "Missing required fields: sourceOrgSlug, targetOrgSlug" },
        400,
      );
    }

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

// Get product by id (preferred) or slug. Registered at both the bare
// `/products/:identifier` path and the org-scoped `/orgs/:orgSlug/products/:productSlug`.
const getProductDetailHandler = async (c: import("hono").Context<Env>) => {
  const db = createDb(c.env.DB);

  const product = await resolveProductFromContext(c, db);
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const [productSources, tagRows, aliasRows] = await Promise.all([
    db
      .select({
        id: sourcesActive.id,
        slug: sourcesActive.slug,
        name: sourcesActive.name,
        type: sourcesActive.type,
        url: sourcesActive.url,
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

  return c.json({
    ...product,
    sources: productSources,
    tags: tagRows.map((t) => t.name),
    aliases: aliasRows.map((a) => a.domain),
  });
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
    tags: ["Products"],
    summary: "Create product",
    description:
      "Body fields: `name` (required), `orgId` or `orgSlug` (one required), `slug?`, `url?`, `description?`, `category?`, `tags?`. `category` is validated against the canonical list. Returns the raw product row (201).",
    security: [{ bearerAuth: [] }],
    responses: {
      201: {
        description: "Product created",
        content: { "application/json": { schema: resolver(ProductRowSchema) } },
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
  async (c) => {
    const db = createDb(c.env.DB);
    const body = await c.req.json<{
      orgId?: string;
      orgSlug?: string;
      name: string;
      slug?: string;
      url?: string;
      description?: string;
      category?: string;
      tags?: string[];
    }>();

    if ((!body.orgId && !body.orgSlug) || !body.name) {
      return c.json(
        { error: "bad_request", message: "Missing required fields: orgId or orgSlug, name" },
        400,
      );
    }

    const orgCond = body.orgId ? eq(organizations.id, body.orgId) : orgWhere(body.orgSlug!);
    const [org] = await db.select().from(organizations).where(orgCond);
    if (!org) return c.json({ error: "not_found", message: "Organization not found" }, 404);

    if (body.category && !isValidCategory(body.category)) {
      return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
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

      if (body.tags && body.tags.length > 0) {
        const tagRows = await getOrCreateTagsD1(db, body.tags);
        const now = new Date().toISOString();
        await db
          .insert(productTags)
          .values(tagRows.map((t) => ({ productId: created.id, tagId: t.id, createdAt: now })))
          .onConflictDoNothing();
      }

      c.executionCtx.waitUntil(embedProductSideEffect(c.env, db, created.id));
      return c.json(created, 201);
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
  const body = await c.req.json<{
    name?: string;
    url?: string | null;
    description?: string | null;
    category?: string | null;
    tags?: string[];
    aliases?: string[];
  }>();

  const product = await resolveProductFromContext(c, db);
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  const updates: Record<string, string | null> = {};
  if (body.name) updates.name = body.name;
  if (body.url !== undefined) updates.url = body.url;
  if (body.description !== undefined) updates.description = body.description;

  if (body.category !== undefined && body.category !== null && !isValidCategory(body.category)) {
    return c.json({ error: "bad_request", message: `Invalid category: "${body.category}"` }, 400);
  }
  if (body.category !== undefined) updates.category = body.category;

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
productRoutes.patch("/products/:slug", patchProductRoute, patchProductHandler);
productRoutes.patch("/orgs/:orgSlug/products/:productSlug", patchProductRoute, patchProductHandler);

productRoutes.get("/products/:identifier/tags", async (c) => {
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
});

productRoutes.put("/products/:identifier/tags", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ tags: string[] }>();
  const product = await resolveProductFromContext(c, db);
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  if (body.tags.length > 0) {
    const tagRows = await getOrCreateTagsD1(db, body.tags);
    const now = new Date().toISOString();
    await db
      .insert(productTags)
      .values(tagRows.map((t) => ({ productId: product.id, tagId: t.id, createdAt: now })))
      .onConflictDoNothing();
  }
  return c.json({ ok: true });
});

productRoutes.delete("/products/:identifier/tags", async (c) => {
  const db = createDb(c.env.DB);
  const body = await c.req.json<{ tags: string[] }>();
  const product = await resolveProductFromContext(c, db);
  if (!product) return c.json({ error: "not_found", message: "Product not found" }, 404);

  for (const tagName of body.tags) {
    const tagSlug = toSlug(tagName);
    // oxlint-disable-next-line no-await-in-loop -- sequential: tag lookup result feeds the delete
    const [tag] = await db.select().from(tags).where(eq(tags.slug, tagSlug));
    if (tag) {
      // oxlint-disable-next-line no-await-in-loop -- sequential per-tag delete; ordering matters for partial success
      await db
        .delete(productTags)
        .where(and(eq(productTags.productId, product.id), eq(productTags.tagId, tag.id)));
    }
  }
  return c.json({ ok: true });
});

// Delete product
productRoutes.delete(
  "/products/:identifier",
  describeRoute({
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
    });
  }
}
