import { z } from "zod";
import { OrgFeedPaginationSchema } from "./orgs.js";
import { ReleaseLatestItemSchema } from "./releases.js";

/** Follows and the personalized feed, served under `/v1/me/follows` and `/v1/me/feed`. */

/** What a user can follow. */
export const FollowTargetSchema = z.enum(["org", "product"]);

/** A user's follow, enriched for rendering (returned by GET /v1/me/follows). */
export const FollowSchema = z.object({
  targetType: FollowTargetSchema,
  targetId: z.string(),
  name: z.string(),
  slug: z.string(),
  avatarUrl: z.string().nullable(),
  /** Owning org slug for product follows (null for org follows). */
  orgSlug: z.string().nullable(),
  createdAt: z.string(),
});

/** GET /v1/me/follows response. */
export const FollowsListResponseSchema = z.object({
  follows: z.array(FollowSchema),
});

/** POST /v1/me/follows request body. Following an org also follows its products. */
export const FollowRequestSchema = z.object({
  targetType: FollowTargetSchema,
  targetId: z.string().min(1).describe("The org or product id (`org_…` / `prod_…`)."),
});

/** POST/DELETE /v1/me/follows response. */
export const FollowMutationResponseSchema = z.object({
  success: z.literal(true),
  following: z.boolean(),
});

/** Cursor pagination shape for GET /v1/me/feed (same as other release feeds). */
export const PersonalizedFeedPaginationSchema = OrgFeedPaginationSchema;

/**
 * GET /v1/me/feed response — the personalized release feed. Reuses the same item
 * shape as /v1/releases/latest (ReleaseLatestItem); cursor-paginated like other
 * feed-shaped surfaces.
 */
export const PersonalizedFeedResponseSchema = z.object({
  items: z.array(ReleaseLatestItemSchema),
  pagination: PersonalizedFeedPaginationSchema,
});

export type FollowTarget = z.infer<typeof FollowTargetSchema>;
export type Follow = z.infer<typeof FollowSchema>;
export type FollowsListResponse = z.infer<typeof FollowsListResponseSchema>;
export type FollowRequest = z.infer<typeof FollowRequestSchema>;
export type FollowMutationResponse = z.infer<typeof FollowMutationResponseSchema>;
export type PersonalizedFeedPagination = z.infer<typeof PersonalizedFeedPaginationSchema>;
export type PersonalizedFeedResponse = z.infer<typeof PersonalizedFeedResponseSchema>;
