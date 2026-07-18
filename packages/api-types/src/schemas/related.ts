import { z } from "zod";
import { AppStoreSourceInfoSchema, ImportanceScoreSchema } from "./shared.js";

/**
 * Anchor scope for related-* lookups. `org` filters the Vectorize query by
 * the anchor's org id; `global` (default) runs unscoped.
 */
export const RelatedScopeSchema = z.enum(["org", "global"]);

/** Thumbnail picked from the release's first image-like media entry. */
export const RelatedReleaseThumbnailSchema = z.object({
  url: z.string(),
  alt: z.string().optional(),
});

/** Owning source rollup attached to each related-release row. */
export const RelatedReleaseSourceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  /** Parent product name, when the source belongs to one — preferred over the
   * bare source/feed name for display. Null for sources with no product. */
  productName: z.string().nullable(),
  orgSlug: z.string().nullable(),
  orgName: z.string().nullable(),
  orgAvatarUrl: z.string().nullable(),
  /**
   * Source fetch type (`appstore`, `github`, `feed`, …). Additive — older API
   * responses omit it; consumers must degrade gracefully (treat `undefined` as
   * "not a special-cased type"). Loose `z.string()` to match the other related
   * source rollup (`RelatedSourceItemSchema.type`). Lets the rail render the
   * lean mobile-app card for `appstore` releases. #mobile-app-release-cards
   */
  type: z.string().optional(),
  /**
   * App Store platform + icon, present only for `type === "appstore"` sources.
   * Same block the org/product/ticker read paths already resolve; lets the
   * related rail show the app icon + "iOS/macOS" cue instead of the standard
   * headline/thumbnail. Additive/optional for mid-deploy pin tolerance.
   */
  appStore: AppStoreSourceInfoSchema.optional(),
});

/**
 * One neighbor returned by `GET /v1/related/releases`. `score` is the
 * Vectorize cosine similarity from the underlying query.
 */
export const RelatedReleaseItemSchema = z.object({
  id: z.string(),
  title: z.string(),
  version: z.string().nullable(),
  url: z.string().nullable(),
  publishedAt: z.string().nullable(),
  summary: z.string(),
  titleGenerated: z.string().nullable(),
  titleShort: z.string().nullable(),
  /**
   * AI-scored importance 1–5 (5=landmark, 1=housekeeping). Null when
   * unscored; optional for older servers / mid-deploy pin tolerance.
   */
  importance: ImportanceScoreSchema,
  thumbnail: RelatedReleaseThumbnailSchema.nullable(),
  score: z.number(),
  source: RelatedReleaseSourceSchema,
});

/**
 * One neighbor returned by `GET /v1/related/sources`. Carries enough
 * source + org + recent-release stats for the rail card to render without
 * a follow-up request.
 */
export const RelatedSourceItemSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: z.string(),
  url: z.string().nullable(),
  score: z.number(),
  orgSlug: z.string().nullable(),
  orgName: z.string().nullable(),
  orgAvatarUrl: z.string().nullable(),
  releaseCount: z.number().int().min(0),
  latestDate: z.string().nullable(),
  latestTitle: z.string().nullable(),
  latestVersion: z.string().nullable(),
  /** Total releases published in the last 30 days (includes the latest). */
  recentCount: z.number().int().min(0),
});

/**
 * Successful response from `GET /v1/related/releases`. The handler returns
 * `{scope, items}` when Vectorize is reachable and the anchor has a vector.
 */
export const RelatedReleasesOkResponseSchema = z.object({
  scope: RelatedScopeSchema,
  items: z.array(RelatedReleaseItemSchema),
});

/**
 * Degraded response from `GET /v1/related/releases`. Returned (HTTP 200) when
 * Vectorize bindings are missing, the anchor hasn't been embedded yet, or a
 * downstream call errored. Callers render nothing in this case rather than
 * surfacing a hard failure. `degradedReason` is human-readable, not stable.
 */
export const RelatedReleasesDegradedResponseSchema = z.object({
  degraded: z.literal(true),
  degradedReason: z.string(),
  items: z.array(RelatedReleaseItemSchema),
});

export const RelatedReleasesResponseSchema = z.union([
  RelatedReleasesOkResponseSchema,
  RelatedReleasesDegradedResponseSchema,
]);

/** Successful response from `GET /v1/related/sources`. */
export const RelatedSourcesOkResponseSchema = z.object({
  scope: RelatedScopeSchema,
  items: z.array(RelatedSourceItemSchema),
});

/** Degraded response from `GET /v1/related/sources`. Same semantics as the releases variant. */
export const RelatedSourcesDegradedResponseSchema = z.object({
  degraded: z.literal(true),
  degradedReason: z.string(),
  items: z.array(RelatedSourceItemSchema),
});

export const RelatedSourcesResponseSchema = z.union([
  RelatedSourcesOkResponseSchema,
  RelatedSourcesDegradedResponseSchema,
]);
