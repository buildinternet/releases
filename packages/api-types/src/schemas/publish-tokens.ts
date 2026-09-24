import { z } from "zod";

/**
 * Owner-minted publish tokens (#2373): a verified domain owner mints a `relk_`
 * token bound to ONE source, usable only on that source's
 * `POST …/releases/batch` route (e.g. from the publish-changelog GitHub Action).
 * Served by the session-only `/v1/me/publish-tokens` routes.
 */

/** POST /v1/me/publish-tokens request body. */
export const CreatePublishTokenBodySchema = z.strictObject({
  sourceId: z.string().min(1).max(64),
  name: z.string().trim().min(1).max(200),
});
export type CreatePublishTokenBody = z.infer<typeof CreatePublishTokenBodySchema>;

/** POST /v1/me/publish-tokens 201 response. `token` is shown exactly once. */
export const CreatedPublishTokenSchema = z.strictObject({
  token: z.string(),
  id: z.string(),
  sourceId: z.string(),
  name: z.string(),
  createdAt: z.string(),
});
export type CreatedPublishToken = z.infer<typeof CreatedPublishTokenSchema>;

/** One publish token as listed back to its owner — never the secret. */
export const PublishTokenSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  sourceId: z.string(),
  sourceSlug: z.string().nullable(),
  orgSlug: z.string().nullable(),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
});
export type PublishToken = z.infer<typeof PublishTokenSchema>;

/** GET /v1/me/publish-tokens response. */
export const ListPublishTokensResponseSchema = z.strictObject({
  publishTokens: z.array(PublishTokenSchema),
});
export type ListPublishTokensResponse = z.infer<typeof ListPublishTokensResponseSchema>;

/** DELETE /v1/me/publish-tokens/:id response. */
export const RevokePublishTokenResponseSchema = z.strictObject({
  id: z.string(),
  revokedAt: z.string(),
});
export type RevokePublishTokenResponse = z.infer<typeof RevokePublishTokenResponseSchema>;
