import { z } from "zod";
import { CategorySchema } from "./shared.js";
import { CollectionMemberSchema, CollectionReleaseItemSchema } from "./collections.js";

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
  /**
   * A small mixed-kind preview (capped at 3) of the orgs and products in this
   * category, so the list page can render an inline avatar facepile without a
   * second round trip — same shape and intent as a collection's
   * `previewMembers`. Org entries are surfaced first (they carry the avatar);
   * product entries fill any remaining slots and dedupe against orgs already
   * shown. The list page derives "+N more" from `orgCount + productCount`.
   * Optional on the wire so older workers mid-rollout don't trip the schema.
   */
  previewMembers: z.array(CollectionMemberSchema).optional(),
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
 * Body accepted by `PATCH /v1/categories/:slug`. All fields are optional,
 * but the body must set at least one of them — an empty body is rejected.
 * `name` and `description` accept `null` to clear the overlay value;
 * `aliases` replaces the full set (pass `[]` to clear). The row is
 * upserted — categories that have never been customized have no row.
 *
 * `name` is bounded at 200 chars and `description` at 2000. Alias element
 * shape (kebab-case, not a canonical slug, not claimed by another row) is
 * enforced in the handler after the strings are trimmed + lowercased, since
 * those checks depend on runtime state and case-folding.
 */
export const UpdateCategoryRequestSchema = z
  .object({
    name: z.string().max(200).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    aliases: z.array(z.string()).optional(),
  })
  .refine((b) => b.name !== undefined || b.description !== undefined || b.aliases !== undefined, {
    message: "Body must set at least one of `name`, `description`, or `aliases`",
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
