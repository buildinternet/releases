import { z } from "zod";
import { RECOMMENDATION_TYPES } from "@buildinternet/releases-core/schema";

/**
 * `POST /v1/admin/recommendations/:id/notify-added` body.
 *
 * Resolves a live registry listing (org required, source optional) and
 * emails the submitter's `contactEmail` that their suggestion was added.
 * Opt-in only — triage / close / archive never send this.
 */
export const RecommendationNotifyAddedBodySchema = z.object({
  orgSlug: z
    .string()
    .min(1)
    .describe(
      "Org slug or `org_…` id of the onboarded listing. Required so the email can link a live registry URL.",
    ),
  sourceSlug: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional source slug or `src_…` id under that org. When set, the email links the source page.",
    ),
});

/**
 * `POST /v1/admin/recommendations/:id/notify-added` success body.
 *
 * `sent: false` + `reason: "already_notified"` is the idempotent replay —
 * a second call does not email again.
 */
export const RecommendationNotifyAddedResultSchema = z.object({
  ok: z.literal(true),
  sent: z.boolean(),
  reason: z.enum(["already_notified"]).optional(),
  notifiedAt: z.number().nullable(),
  registryUrl: z.string().optional(),
  contactEmail: z.string().optional(),
});

/**
 * `POST /v1/recommendations` body — suggest a changelog the registry should
 * track. `note` and `contactEmail` are optional; a contact email gets an
 * acknowledgement and, later, an opt-in "it's been added" notice.
 */
export const RecommendationSubmitBodySchema = z.object({
  type: z.enum(RECOMMENDATION_TYPES),
  url: z.string().max(2048).describe("http(s) URL of the changelog or project."),
  note: z.string().max(4000).optional(),
  contactEmail: z.string().max(200).optional(),
  surface: z.string().max(32).optional(),
});

/** `POST /v1/recommendations` 202 response. */
export const RecommendationSubmitResponseSchema = z.object({
  ok: z.literal(true),
  id: z.string(),
});
