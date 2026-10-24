import { z } from "zod";

/** Semantic alerts (#2304): saved interests matched against followed releases. */

/** Hard cap on saved semantic alerts per account. Enforced on create. */
export const SEMANTIC_ALERT_MAX_PER_USER = 5;

/** Freeform interest text, after trim. User-private — never an analytics label. */
export const SEMANTIC_ALERT_QUERY_MAX_CHARS = 500;

/** Default selected-choice probability, used unless an alert overrides it. */
export const SEMANTIC_ALERT_THRESHOLD_DEFAULT = 0.8;

export const SEMANTIC_ALERT_THRESHOLD_MIN = 0.5;
export const SEMANTIC_ALERT_THRESHOLD_MAX = 1;

/**
 * v1 candidate pool. Matching scores only releases that already hit
 * the caller's follow graph. Not a per-alert setting.
 */
export const SEMANTIC_ALERT_CANDIDATE_POOL = "follows" as const;

/**
 * POST /v1/me/semantic-alerts body. Documentation shape: the handler parses
 * each field itself. Omitted `enabled` defaults to true, `threshold` to
 * {@link SEMANTIC_ALERT_THRESHOLD_DEFAULT}, `deliverEmail` to true and
 * `deliverWebhook` to false.
 */
export const SemanticAlertCreateBodySchema = z.object({
  query: z
    .string()
    .max(SEMANTIC_ALERT_QUERY_MAX_CHARS)
    .describe("Freeform interest. Trimmed. User-private."),
  enabled: z.boolean().optional(),
  threshold: z
    .number()
    .min(SEMANTIC_ALERT_THRESHOLD_MIN)
    .max(SEMANTIC_ALERT_THRESHOLD_MAX)
    .optional(),
  deliverEmail: z.boolean().optional(),
  deliverWebhook: z.boolean().optional(),
  webhookSubscriptionId: z
    .string()
    .nullable()
    .optional()
    .describe("One of the caller's webhook subscriptions. `null` clears the link on update."),
});
export type SemanticAlertCreateBody = z.infer<typeof SemanticAlertCreateBodySchema>;

/** PATCH /v1/me/semantic-alerts/:id body — any subset of the create fields. */
export const SemanticAlertUpdateBodySchema = SemanticAlertCreateBodySchema.partial();
export type SemanticAlertUpdateBody = z.infer<typeof SemanticAlertUpdateBodySchema>;
