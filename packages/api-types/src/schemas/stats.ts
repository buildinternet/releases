import { z } from "zod";
import { StatsSchema } from "./shared.js";

/**
 * Per-source activity row in `GET /v1/stats`. `orgName` is nullable because
 * the source-to-org JOIN is left-joined (legacy orphan sources still exist).
 */
export const StatsSourceActivitySchema = z.object({
  sourceName: z.string(),
  sourceSlug: z.string(),
  sourceType: z.string(),
  orgName: z.string().nullable(),
  lastFetchedAt: z.string().nullable(),
  totalReleases: z.number(),
  recentReleases: z.number(),
});

/**
 * Recent fetch-log row, joined with source + org for display. `durationMs`
 * and `error` are nullable on the underlying table; `orgName` is nullable
 * for the same orphan-source reason as above.
 */
export const StatsRecentActivitySchema = z.object({
  sourceName: z.string(),
  sourceSlug: z.string(),
  orgName: z.string().nullable(),
  releasesFound: z.number(),
  releasesInserted: z.number(),
  totalReleases: z.number(),
  status: z.string(),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
});

/**
 * Response shape for `GET /v1/stats`. The handler returns a hybrid payload —
 * the flat `Stats` counts (legacy `orgs/sources/releases/products` fields used
 * by the web homepage banner) merged with the richer `StatsSummary` shape
 * (period window + totals + sourceHealth + sourceActivity + recentActivity).
 * Modelled with `z.object` over the union of both shapes; consumers may
 * pick either subset.
 */
export const StatsResponseSchema = StatsSchema.extend({
  period: z.object({
    days: z.number().int().min(1),
    cutoff: z.string(),
  }),
  totals: z.object({
    organizations: z.number().int().min(0),
    sources: z.number().int().min(0),
    releases: z.number().int().min(0),
    releasesInPeriod: z.number().int().min(0),
  }),
  sourceHealth: z.object({
    upToDate: z.number().int().min(0),
    stale: z.number().int().min(0),
    neverFetched: z.number().int().min(0),
  }),
  sourceActivity: z.array(StatsSourceActivitySchema),
  recentActivity: z.array(StatsRecentActivitySchema),
});
