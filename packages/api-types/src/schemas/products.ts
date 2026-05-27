import { z } from "zod";
import { KIND_VALUES } from "@buildinternet/releases-core/kinds";
import { CategorySchema, ListResponseSchema } from "./shared.js";
import { SourceTypeSchema } from "./sources.js";

/**
 * Raw `products` table row, returned by `POST /v1/products` and
 * `PATCH /v1/products/:slug`. The OSS CLI types these responses against
 * `Product` from `@buildinternet/releases-core/schema` (the drizzle row
 * type), so `embeddedAt` and `deletedAt` stay on the wire even though
 * they're internal columns. `deletedAt` is always `null` on these paths
 * (live rows only); `embeddedAt` reflects when the product was last
 * indexed for semantic search.
 */
export const ProductRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  orgId: z.string(),
  url: z.string().nullable(),
  description: z.string().nullable(),
  category: CategorySchema.nullable(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
  createdAt: z.string(),
  embeddedAt: z.string().nullable(),
  deletedAt: z.string().nullable(),
});

/** 201 body of POST /v1/products — ProductRow plus an optional non-blocking
 *  warning emitted when the new slug shadows an existing same-org source (#1190). */
export const ProductCreateResponseSchema = ProductRowSchema.extend({
  warning: z.string().optional(),
});
export type ProductCreateResponse = z.infer<typeof ProductCreateResponseSchema>;

/**
 * Per-product row returned by `GET /v1/products`. Adds `sourceCount` to
 * the row shape but omits the internal `embeddedAt` / `deletedAt` columns
 * (the list handler explicitly selects only the user-facing fields).
 */
export const ProductListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  orgId: z.string(),
  url: z.string().nullable(),
  description: z.string().nullable(),
  category: CategorySchema.nullable(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
  createdAt: z.string(),
  sourceCount: z.number().int().min(0),
});

export const ProductListResponseSchema = ListResponseSchema(ProductListItemSchema);

/**
 * Embedded source row returned in `ProductDetail.sources`. The detail
 * handler explicitly selects only this small subset; reuses the shared
 * `SourceTypeSchema` enum so source types stay in one place.
 */
export const ProductDetailSourceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: SourceTypeSchema,
  url: z.string(),
  metadata: z.string().nullable().optional(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
});

/**
 * Returned by `GET /v1/products/:identifier` (and the org-scoped twin).
 * Spreads the raw product row and adds `sources`, `tags`, `aliases`.
 */
export const ProductDetailSchema = ProductRowSchema.extend({
  sources: z.array(ProductDetailSourceSchema),
  tags: z.array(z.string()),
  aliases: z.array(z.string()),
});

/**
 * Body accepted by `POST /v1/products`. `category` is a non-empty string at
 * the wire boundary so callers can pass either a canonical slug or one of
 * its configured aliases (resolved server-side via `resolveCategoryInput`).
 * Responses always carry the canonical slug. Empty strings are rejected so
 * the truthy-guard around `resolveCategoryInput` in the handler can't be
 * bypassed into persisting an invalid `""` value.
 */
export const CreateProductBodySchema = z.object({
  name: z.string().min(1),
  orgId: z.string().optional(),
  orgSlug: z.string().optional(),
  slug: z.string().optional(),
  url: z.string().optional(),
  description: z.string().optional(),
  category: z.string().min(1).optional(),
  tags: z.array(z.string()).optional(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
});

/**
 * Body accepted by `PATCH /v1/products/:slug`. Same alias-allowed string rule
 * as create, plus `null` to explicitly clear the overlay. Empty strings stay
 * rejected so callers must pick between a slug/alias or `null`.
 */
export const UpdateProductBodySchema = z.object({
  name: z.string().optional(),
  url: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  category: z.string().min(1).nullable().optional(),
  tags: z.array(z.string()).optional(),
  aliases: z.array(z.string()).optional(),
  kind: z.enum(KIND_VALUES).nullable().optional(),
  avatarUrl: z.string().nullable().optional(),
});

/**
 * Body accepted by `POST /v1/products/adopt`.
 *
 * `mergeInto` (slug or `prod_…` ID) folds the source org into an existing
 * product under `targetOrgSlug` instead of creating a new one. When set,
 * `slug` and `url` must be omitted (the existing product's values stand).
 */
export const AdoptProductBodySchema = z.object({
  sourceOrgSlug: z.string().min(1),
  targetOrgSlug: z.string().min(1),
  slug: z.string().optional(),
  url: z.string().optional(),
  mergeInto: z.string().optional(),
  dryRun: z.boolean().optional(),
});

/**
 * Live (non-dryRun) result from `POST /v1/products/adopt`.
 *
 * `mergedInto` is set when the request used `mergeInto` — its value is the
 * existing product's slug, signalling that no new product was created.
 */
export const ProductAdoptResultSchema = z.object({
  product: ProductRowSchema,
  mergedInto: z.string().optional(),
  sourcesMoved: z.number().int().min(0),
  accountsMoved: z.number().int().min(0),
  sourceOrgDeleted: z.string(),
});

/** Dry-run preview from `POST /v1/products/adopt` with `dryRun: true`. */
export const ProductAdoptDryRunSchema = z.object({
  dryRun: z.literal(true),
  mergeInto: z.string().optional(),
  product: z.object({
    name: z.string(),
    slug: z.string(),
    url: z.string().nullable(),
    orgSlug: z.string(),
  }),
  sourcesToMove: z.array(z.string()),
  sourceOrgToDelete: z.string(),
});

/** Response shape returned by `POST /v1/products/adopt` (union of live + dry-run). */
export const ProductAdoptResponseSchema = z.union([
  ProductAdoptResultSchema,
  ProductAdoptDryRunSchema,
]);

/** Response shape returned by `DELETE /v1/products/:identifier`. */
export const ProductDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  hard: z.literal(true).optional(),
  deletedAt: z.string().optional(),
});

/**
 * Tag list returned by `GET /v1/products/:identifier/tags`. Tag names are
 * sorted alphabetically; the empty array is returned when the product has
 * no tags rather than 404.
 */
export const ProductTagsListResponseSchema = z.array(z.string());

/** Body accepted by `PUT` and `DELETE` `/v1/products/:identifier/tags`. */
export const ProductTagsBodySchema = z.object({
  tags: z.array(z.string()),
});

/** Response shape returned by `PUT` and `DELETE` `/v1/products/:identifier/tags`. */
export const ProductTagsMutationResponseSchema = z.object({
  ok: z.literal(true),
});
