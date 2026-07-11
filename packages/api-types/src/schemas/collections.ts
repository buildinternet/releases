import { z } from "zod";
import { ReleaseItemSchema } from "./shared.js";

/**
 * One org as it appears inside a collection's preview list or detail page.
 * Joined through `organizations_public`, so soft-deleted / on_demand orgs
 * never leak via a collection.
 */
export const CollectionMemberOrgSchema = z.object({
  slug: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  /** GitHub handle from `org_accounts`; lets the avatar fall back to github.com/<handle>.png. */
  githubHandle: z.string().nullable(),
  description: z.string().nullable(),
});

/**
 * Org context attached to a product member so the chip can render the parent
 * org's avatar / handle. Subset of `CollectionMemberOrg` — description is
 * intentionally omitted because the byline comes from the product itself.
 */
export const ProductParentOrgSchema = z.object({
  slug: z.string(),
  name: z.string(),
  domain: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  githubHandle: z.string().nullable(),
});

/**
 * One product as it appears inside a collection. Carries the parent org block
 * so the chip can render the org's avatar (products don't have their own).
 */
export const CollectionMemberProductSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  org: ProductParentOrgSchema,
});

/**
 * Mixed-kind member entry. `kind` discriminates: `org` carries the org block at
 * the top level; `product` carries the product fields plus a `org` parent block.
 * Used by `GET /v1/collections/:slug` (`members` field) and the new
 * `previewMembers` on `GET /v1/collections`.
 */
export const CollectionMemberSchema = z.discriminatedUnion("kind", [
  CollectionMemberOrgSchema.extend({ kind: z.literal("org") }),
  CollectionMemberProductSchema.extend({ kind: z.literal("product") }),
]);

/**
 * Row on `GET /v1/collections`. `previewMembers` (the new mixed-kind preview)
 * is the first few visible members so the list page can render inline avatars
 * without a second round trip. `previewOrgs` is the legacy org-only preview,
 * retained for back-compat — clients should migrate to `previewMembers`.
 */
export const CollectionListItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int().min(0),
  /** Whether the collection is promoted on the homepage. Filterable via `?featured=1`. */
  isFeatured: z.boolean(),
  /** Mixed-kind preview (org + product). Cap matches `previewOrgs`. */
  previewMembers: z.array(CollectionMemberSchema).optional(),
  /** Legacy org-only preview. Populated with the org-kind subset of `previewMembers`. */
  previewOrgs: z.array(CollectionMemberOrgSchema).optional(),
});

export const CollectionListResponseSchema = z.array(CollectionListItemSchema);

/**
 * Returned by `GET /v1/collections/:slug`.
 *
 * `members` is the mixed-kind canonical list. `orgs` is the legacy org-only
 * field, populated with the org-kind subset of `members` for back-compat —
 * new clients should consume `members`.
 */
export const CollectionDetailSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  /** Whether the collection is promoted on the homepage. */
  isFeatured: z.boolean(),
  /** Per-collection enable toggle for the nightly daily-summary generation. */
  dailySummaryEnabled: z.boolean(),
  members: z.array(CollectionMemberSchema),
  /** @deprecated Use `members`. Org-only subset, kept for back-compat. */
  orgs: z.array(CollectionMemberOrgSchema),
});

/**
 * Cross-member release feed row on `GET /v1/collections/:slug/releases`. Same
 * shape as `OrgReleaseItem` plus the origin `org` block (and optional
 * `product`) so the web's release card can render it identically. `source.type`
 * stays as `z.string()` because the SQL passes the column through unvalidated —
 * tightening to the SourceType enum would break pass-through code.
 */
export const CollectionReleaseItemSchema = ReleaseItemSchema.extend({
  source: z.object({ slug: z.string(), name: z.string(), type: z.string() }),
  org: z.object({ slug: z.string(), name: z.string() }),
  /**
   * Product the release belongs to, if the source is bound to one. `null` for
   * orgs without products or standalone sources. Optional on the wire so older
   * workers mid-rollout (and hand-constructed test fixtures) don't trip the
   * typecheck — clients should treat missing and `null` identically.
   */
  product: z.object({ slug: z.string(), name: z.string() }).nullable().optional(),
  /**
   * Server-resolved grouping identity — `COALESCE(product.slug, source.slug)` /
   * `COALESCE(product.name, source.name)`. The web release feeds key and label
   * SDK/package-cluster rollups on these instead of reconstructing
   * `product ?? source` client-side. Optional on the wire: older workers omit
   * them, so clients must fall back to deriving from `product ?? source`. Never
   * null when present (`source` is always set). #1234
   */
  groupSlug: z.string().optional(),
  groupName: z.string().optional(),
});

/** Cursor pagination shape matches `/v1/orgs/:slug/releases`. */
export const CollectionFeedPaginationSchema = z.object({
  nextCursor: z.string().nullable(),
  limit: z.number().int().min(1),
});

export const CollectionReleasesResponseSchema = z.object({
  releases: z.array(CollectionReleaseItemSchema),
  pagination: CollectionFeedPaginationSchema,
});

/**
 * Bare row returned by `POST /v1/collections` and `PATCH /v1/collections/:slug`.
 * Mirrors the `collections` table columns (no member rollup — that's a
 * separate detail call).
 */
export const CollectionRowSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  isFeatured: z.boolean(),
  /** Per-collection enable toggle for the nightly daily-summary generation. */
  dailySummaryEnabled: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * Body for `POST /v1/collections`. `slug` derives from `name` via `toSlug()`
 * when omitted. Slug shape is lowercased alnum + hyphens, alnum-start, 2–64
 * chars — enforced server-side.
 */
export const CreateCollectionRequestSchema = z.object({
  slug: z.string().optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
});

/** Body for `PATCH /v1/collections/:slug`. All fields optional; slug rename allowed. */
export const UpdateCollectionRequestSchema = z.object({
  slug: z.string().optional(),
  name: z.string().min(1).max(200).optional(),
  description: z.string().max(2000).nullable().optional(),
  /** Promote / demote the collection on the homepage. */
  isFeatured: z.boolean().optional(),
  /** Enable or disable the nightly daily-summary generation for this collection. */
  dailySummaryEnabled: z.boolean().optional(),
});

/**
 * One member entry accepted by the member-write endpoints.
 *
 * Exactly one of `orgId` / `orgSlug` / `productId` / `productSlug` must be
 * present. When both an id and a slug are supplied for the same kind, the id
 * wins. Mixing kinds (e.g. `orgId` + `productSlug`) is rejected by the handler.
 *
 * Product slug is resolved within an org — supply either `productId`
 * (`prod_…`, globally unique) or pair `productSlug` with `orgSlug`/`orgId`.
 * `productSlug` alone is rejected.
 */
export const CollectionMemberInputSchema = z.object({
  orgId: z.string().optional(),
  orgSlug: z.string().optional(),
  productId: z.string().optional(),
  productSlug: z.string().optional(),
  /** Authoring position (default 0). For PUT, omit to use the array index. */
  position: z.number().int().optional(),
});

/** Body for `POST /v1/collections/:slug/members`. */
export const AddCollectionMemberRequestSchema = CollectionMemberInputSchema;

/**
 * Body for `PUT /v1/collections/:slug/members`. Replaces the full membership
 * atomically. The field is still named `orgs` for back-compat — it accepts
 * any `CollectionMemberInput`, org or product.
 */
export const ReplaceCollectionMembersRequestSchema = z.object({
  orgs: z.array(CollectionMemberInputSchema),
});

/**
 * Resolved member returned by `PUT /v1/collections/:slug/members` and `POST
 * /v1/collections/:slug/members`. `kind` discriminates which id field is
 * populated. `orgId` is also set on legacy callers that only used org
 * membership — for clean dispatch, dispatch on `kind`.
 */
export const ResolvedCollectionMemberSchema = z.object({
  kind: z.enum(["org", "product"]),
  orgId: z.string().optional(),
  productId: z.string().optional(),
  position: z.number().int(),
});

/** Response from `PUT /v1/collections/:slug/members`. */
export const ReplaceCollectionMembersResponseSchema = z.object({
  collectionSlug: z.string(),
  members: z.array(ResolvedCollectionMemberSchema),
});

/**
 * Response from `POST /v1/collections/:slug/members`. `orgId` stays populated
 * for org-kind members so existing CLI callers don't break; `kind` +
 * `productId` are the canonical fields for new code.
 */
export const AddCollectionMemberResponseSchema = z.object({
  collectionSlug: z.string(),
  kind: z.enum(["org", "product"]),
  orgId: z.string().optional(),
  productId: z.string().optional(),
  position: z.number().int(),
});

/** One daily summary row returned by `GET /v1/collections/:slug/daily-summaries`. */
export const CollectionDailySummarySchema = z.object({
  /** Eastern calendar day, YYYY-MM-DD. */
  date: z.string(),
  title: z.string(),
  summary: z.string(),
  takeaways: z.array(z.string()),
  releaseCount: z.number().int().nonnegative(),
});

/** Response envelope for `GET /v1/collections/:slug/daily-summaries`. */
export const CollectionDailySummariesResponseSchema = z.object({
  summaries: z.array(CollectionDailySummarySchema),
});

// ── Weekly digests ────────────────────────────────────────────────

/** List row on `GET /v1/collections/:slug/digests` — newest-first, no body. */
export const CollectionWeeklyDigestListItemSchema = z.object({
  id: z.string(),
  /** ET Monday starting the covered week, YYYY-MM-DD. */
  weekStart: z.string(),
  title: z.string(),
  intro: z.string(),
  releaseCount: z.number().int().nonnegative(),
  generatedAt: z.string(),
});

/** Cursor pagination shape matches the other paginated list surfaces. */
export const CollectionWeeklyDigestsResponseSchema = z.object({
  digests: z.array(CollectionWeeklyDigestListItemSchema),
  pagination: z.object({
    nextCursor: z.string().nullable(),
    limit: z.number().int().min(1),
  }),
});

/** Minimal, server-resolved release info for a digest's "Releases covered" list. */
export const DigestCoveredReleaseSchema = z.object({
  id: z.string(),
  title: z.string(),
  path: z.string(),
  org: z.object({ slug: z.string(), name: z.string() }),
});

/** Full row returned by `GET /v1/collections/:slug/digests/:weekStart`. */
export const CollectionWeeklyDigestDetailSchema = z.object({
  id: z.string(),
  weekStart: z.string(),
  title: z.string(),
  intro: z.string(),
  body: z.string(),
  releaseIds: z.array(z.string()),
  releaseCount: z.number().int().nonnegative(),
  generatedAt: z.string(),
  /** Server-resolved minimal release info for every id in `releaseIds` that
   *  still resolves — a release deleted/suppressed after generation is
   *  dropped rather than surfaced as a dead link. */
  releases: z.array(DigestCoveredReleaseSchema),
});
