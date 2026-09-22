import { z } from "zod";

export const MARKETING_THRESHOLD_MIN = 0.5;
export const MARKETING_THRESHOLD_MAX = 0.99;

/** PUT /v1/admin/marketing-classifier — set the suppression threshold. */
export const MarketingClassifierThresholdPutSchema = z
  .object({
    threshold: z.number().min(MARKETING_THRESHOLD_MIN).max(MARKETING_THRESHOLD_MAX),
  })
  .strict();

export const MarketingFilteredSourceSchema = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  type: z.string(),
  orgSlug: z.string().nullable(),
  hint: z.string().nullable(),
  recentReleaseCount: z.number(),
});

/** GET/PUT /v1/admin/marketing-classifier response. */
export const MarketingClassifierStateSchema = z.object({
  threshold: z.number(),
  defaultThreshold: z.number(),
  updatedAt: z.string().nullable(),
  sources: z.array(MarketingFilteredSourceSchema),
});
