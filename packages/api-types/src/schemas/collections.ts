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
 * Row on `GET /v1/collections`. `previewMembers` is the first few visible
 * members (capped at 3) so the list page can render inline avatars without a
 * second round trip.
 */
export const CollectionListItemSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  memberCount: z.number().int().min(0),
  previewMembers: z.array(CollectionMemberOrgSchema).optional(),
});

export const CollectionListResponseSchema = z.array(CollectionListItemSchema);

/** Returned by `GET /v1/collections/:slug`. */
export const CollectionDetailSchema = z.object({
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  orgs: z.array(CollectionMemberOrgSchema),
});

/**
 * Cross-org release feed row on `GET /v1/collections/:slug/releases`. Same
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
});

/**
 * One member entry accepted by the member-write endpoints. Either `orgId`
 * (`org_…`) or `orgSlug` is required; when both are given, `orgId` wins.
 */
export const CollectionMemberInputSchema = z.object({
  orgId: z.string().optional(),
  orgSlug: z.string().optional(),
  /** Authoring position (default 0). For PUT, omit to use the array index. */
  position: z.number().int().optional(),
});

/** Body for `POST /v1/collections/:slug/members`. */
export const AddCollectionMemberRequestSchema = CollectionMemberInputSchema;

/** Body for `PUT /v1/collections/:slug/members`. Replaces the full membership atomically. */
export const ReplaceCollectionMembersRequestSchema = z.object({
  orgs: z.array(CollectionMemberInputSchema),
});

/** Resolved member returned by `PUT /v1/collections/:slug/members`. */
export const ResolvedCollectionMemberSchema = z.object({
  orgId: z.string(),
  position: z.number().int(),
});

/** Response from `PUT /v1/collections/:slug/members`. */
export const ReplaceCollectionMembersResponseSchema = z.object({
  collectionSlug: z.string(),
  members: z.array(ResolvedCollectionMemberSchema),
});

/** Response from `POST /v1/collections/:slug/members`. */
export const AddCollectionMemberResponseSchema = z.object({
  collectionSlug: z.string(),
  orgId: z.string(),
  position: z.number().int(),
});
