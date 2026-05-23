import { z } from "zod";
import { FEEDBACK_TYPES, FEEDBACK_STATUSES } from "@buildinternet/releases-core/schema";

/** Feedback category — mirrors `FEEDBACK_TYPES` in `@buildinternet/releases-core/schema`. */
export const FeedbackTypeSchema = z.enum(FEEDBACK_TYPES);

/** Triage lifecycle — mirrors `FEEDBACK_STATUSES` in `@buildinternet/releases-core/schema`. */
export const FeedbackStatusSchema = z.enum(FEEDBACK_STATUSES);

/**
 * One submitted feedback row, as returned by `GET /v1/admin/feedback` and by
 * the triage write-path (`PATCH /v1/feedback/:id` echoes the updated row).
 * `archived` soft-removes the row from the default admin read view and is
 * orthogonal to triage `status` — a row can be `closed` and visible, or `new`
 * and archived. `createdAt` is epoch milliseconds.
 */
export const FeedbackItemSchema = z.object({
  id: z.string(),
  createdAt: z.number(),
  message: z.string(),
  contact: z.string().nullable(),
  type: FeedbackTypeSchema,
  status: FeedbackStatusSchema,
  archived: z.boolean(),
  cliVersion: z.string().nullable(),
  clientKind: z.string(),
  anonId: z.string().nullable(),
  os: z.string().nullable(),
  arch: z.string().nullable(),
  runtime: z.string().nullable(),
  surface: z.string(),
});

/**
 * `GET /v1/admin/feedback` — cursor-paginated, newest-first. Archived rows are
 * hidden unless the request passes `?includeArchived=true`.
 */
export const FeedbackListResponseSchema = z.object({
  items: z.array(FeedbackItemSchema),
  nextCursor: z.string().nullable(),
});

/**
 * `PATCH /v1/feedback/:id` body — partial triage update. At least one field
 * must be present; the response echoes the updated `FeedbackItem`.
 */
export const FeedbackUpdateBodySchema = z.object({
  status: FeedbackStatusSchema.optional(),
  archived: z.boolean().optional(),
});

/** `DELETE /v1/feedback/:id` response — hard delete of a single row. */
export const FeedbackDeleteResponseSchema = z.object({
  deleted: z.literal(true),
  id: z.string(),
});
