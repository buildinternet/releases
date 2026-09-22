import { z } from "zod";

/**
 * Admin classification analytics (`GET /v1/admin/classifications/summary`
 * and `/recent`). Decisions live in Analytics Engine; these shapes are the
 * hydrated read model, not the positional point schema.
 */

const ClassificationOriginSchema = z.enum(["ingest", "manual", "eval"]);
const ClassificationOriginFilterSchema = z.enum(["ingest", "manual", "eval", "all"]);
const ClassificationDispositionSchema = z.enum(["kept", "suppressed", "failed", "skipped"]);

const ProbabilityBinSchema = z.object({
  /** Inclusive. Width is 0.1. See `probability.threshold` for the current
   *  effective suppression threshold and which bin it falls in. */
  start: z.number(),
  /** Exclusive, except the last bin (`0.9`–`1`) which includes `1`. */
  end: z.number(),
  count: z.number(),
});

const ProbabilityHistogramSchema = z.object({
  bins: z.array(ProbabilityBinSchema),
  /** Sampled rows whose double is `< 0` (the absent sentinel). */
  missing: z.number(),
});

/** `GET /v1/admin/classifications/summary`. */
export const ClassificationSummarySchema = z.object({
  after: z.string(),
  before: z.string(),
  bucket: z.enum(["hour", "day"]),
  origin: ClassificationOriginFilterSchema,
  totals: z.object({
    classified: z.number(),
    kept: z.number(),
    suppressed: z.number(),
    failed: z.number(),
    skipped: z.number(),
    costUsd: z.number(),
    /** `suppressed / (kept + suppressed)`, or null when the denominator is 0. */
    suppressionRate: z.number().nullable(),
  }),
  series: z.array(
    z.object({
      t: z.string(),
      kept: z.number(),
      suppressed: z.number(),
      failed: z.number(),
      skipped: z.number(),
    }),
  ),
  choices: z.array(z.object({ choice: z.string(), count: z.number() })),
  choiceSeries: z.array(
    z.object({
      t: z.string(),
      choices: z.record(z.string(), z.number()),
    }),
  ),
  models: z.array(
    z.object({
      provider: z.string(),
      model: z.string(),
      count: z.number(),
      costUsd: z.number(),
    }),
  ),
  probability: z.object({
    /** Current effective suppression threshold (operator override, else the
     *  code default) — no longer a fixed literal now that it's editable via
     *  `GET/PUT /v1/admin/marketing-classifier`. */
    threshold: z.number(),
    selected: ProbabilityHistogramSchema,
    confidence: ProbabilityHistogramSchema,
  }),
  meta: z.object({
    dataset: z.string(),
    retentionDays: z.literal(90),
    sampled: z.literal(true),
  }),
});

/** One sampled decision from `GET /v1/admin/classifications/recent`. */
export const ClassificationRecentItemSchema = z.object({
  timestamp: z.string(),
  origin: ClassificationOriginSchema,
  sourceId: z.string().nullable(),
  sourceName: z.string().nullable(),
  sourceSlug: z.string().nullable(),
  orgSlug: z.string().nullable(),
  releaseId: z.string().nullable(),
  releaseTitle: z.string().nullable(),
  provider: z.string(),
  model: z.string(),
  choice: z.string(),
  selectedChoiceProbability: z.number().nullable(),
  providerConfidence: z.number().nullable(),
  disposition: ClassificationDispositionSchema,
  reason: z.string(),
  failureCategory: z.string(),
  costUsd: z.number().nullable(),
  durationMs: z.number().nullable(),
});

/** `GET /v1/admin/classifications/recent` — newest sampled rows, not weighted. */
export const ClassificationRecentResponseSchema = z.object({
  items: z.array(ClassificationRecentItemSchema),
  nextCursor: z.string().nullable(),
});
