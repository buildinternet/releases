import { z } from "zod";

/**
 * Admin interest-alert quality (`GET /v1/admin/semantic-alerts/summary`).
 * Decisions live in the classifications Analytics Engine dataset with
 * `blob4 = semantic-alert`. This is the hydrated read model. Alert query
 * text is not a field — it is not stored on the points.
 */

const ProbabilityBinSchema = z.object({
  /** Inclusive. Width is 0.1. `0.8` is the start of the default-threshold bin. */
  start: z.number(),
  /** Exclusive, except the last bin (`0.9`–`1`) which includes `1`. */
  end: z.number(),
  count: z.number(),
});

const SemanticAlertDispositionCountsSchema = z.object({
  matched: z.number(),
  belowThreshold: z.number(),
  failed: z.number(),
});

/**
 * `GET /v1/admin/semantic-alerts/summary`.
 *
 * `scored` is matched + below threshold (a probability came back).
 * `matchRate` is matched / scored, or null when nothing was scored.
 * `failed` is fail-closed and stays out of the rate.
 * Cost is not on these points; `meta.costLane` names the `ai_usage` lane.
 */
export const SemanticAlertSummarySchema = z.object({
  after: z.string(),
  before: z.string(),
  bucket: z.enum(["hour", "day"]),
  totals: SemanticAlertDispositionCountsSchema.extend({
    scored: z.number(),
    matchRate: z.number().nullable(),
  }),
  series: z.array(
    SemanticAlertDispositionCountsSchema.extend({
      t: z.string(),
    }),
  ),
  failures: z.array(
    z.object({
      category: z.enum(["provider_error", "invalid_probability", "unknown"]),
      count: z.number(),
    }),
  ),
  probability: z.object({
    /** Default alert threshold. Each point stores its own threshold separately. */
    defaultThreshold: z.literal(0.8),
    bins: z.array(ProbabilityBinSchema),
    /** Sampled rows whose probability double is `< 0` (the absent sentinel). */
    missing: z.number(),
  }),
  meta: z.object({
    dataset: z.string(),
    retentionDays: z.literal(90),
    sampled: z.literal(true),
    /** `ai_usage` lane that carries JEV cost. Not summed from these points. */
    costLane: z.literal("semantic-alert-match"),
  }),
});
