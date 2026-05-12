import { z } from "zod";

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
  orgSlug: z.string().nullable(),
  orgName: z.string().nullable(),
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
