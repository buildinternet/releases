import { z } from "zod";
import { CategorySchema } from "./shared.js";
import { CollectionReleaseItemSchema } from "./collections.js";

/**
 * Org rollup row shared by category and tag detail responses. Slim by
 * design — taxonomy pages link out to the full org detail page rather
 * than embedding it.
 */
export const TaxonomyOrgSchema = z.object({
  slug: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  avatarUrl: z.string().nullable(),
});

/** Product rollup row, paired with `TaxonomyOrg`. */
export const TaxonomyProductSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  orgSlug: z.string(),
  orgName: z.string(),
});

/**
 * Per-category row on `GET /v1/categories`. Categories are a fixed
 * taxonomy (`CATEGORIES` in `@buildinternet/releases-core/categories`),
 * so the response always includes every slug, including ones with zero
 * members. `name` / `description` / `aliases` come from the optional
 * `categories` metadata overlay; `description` is null when no override
 * has been set.
 */
export const CategoryListItemSchema = z.object({
  slug: CategorySchema,
  name: z.string(),
  description: z.string().nullable(),
  aliases: z.array(z.string()),
  orgCount: z.number().int().min(0),
  productCount: z.number().int().min(0),
});

export const CategoryListResponseSchema = z.array(CategoryListItemSchema);

/** Returned by `GET /v1/categories/:slug` for the canonical slug. */
export const CategoryDetailSchema = z.object({
  slug: CategorySchema,
  name: z.string(),
  description: z.string().nullable(),
  aliases: z.array(z.string()),
  orgs: z.array(TaxonomyOrgSchema),
  products: z.array(TaxonomyProductSchema),
});

/**
 * Body accepted by `PATCH /v1/categories/:slug`. All fields are optional.
 * `name` and `description` accept `null` to clear the overlay value;
 * `aliases` replaces the full set (pass `[]` to clear). The row is
 * upserted — categories that have never been customized have no row.
 *
 * Each alias must be kebab-case, not a canonical slug, and not claimed
 * by another category row.
 */
export const UpdateCategoryRequestSchema = z.object({
  name: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  aliases: z.array(z.string()).optional(),
});

/** Response from `PATCH /v1/categories/:slug` — the resolved overlay values. */
export const UpdateCategoryResponseSchema = z.object({
  slug: CategorySchema,
  name: z.string(),
  description: z.string().nullable(),
  aliases: z.array(z.string()),
});

/**
 * Aggregated release row on `GET /v1/categories/:slug/releases`. Same wire
 * shape as `CollectionReleaseItem` — both surfaces aggregate across orgs and
 * use `formatAggregateReleaseRow` in `workers/api/src/utils.ts` for the
 * formatting. Re-exported here so the two endpoints describe one schema
 * instead of two drifting copies.
 */
export const CategoryReleaseItemSchema = CollectionReleaseItemSchema;

export const CategoryFeedPaginationSchema = z.object({
  nextCursor: z.string().nullable(),
  limit: z.number().int().min(1),
});

export const CategoryReleasesResponseSchema = z.object({
  releases: z.array(CategoryReleaseItemSchema),
  pagination: CategoryFeedPaginationSchema,
});

/** Returned by `GET /v1/tags/:slug`. */
export const TagDetailSchema = z.object({
  slug: z.string(),
  name: z.string(),
  orgs: z.array(TaxonomyOrgSchema),
  products: z.array(TaxonomyProductSchema),
});
