import { z } from "zod";
import { API_SCOPES } from "@buildinternet/releases-core/api-token";

/** User-owned API keys (`relu_`) — the self-serve surface served by `/v1/api-keys`. */

/** A user-owned API key (relu_) as returned by GET /v1/api-keys. */
export const UserApiKeySchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  start: z.string().nullable(),
  scope: z.enum(API_SCOPES).nullable(),
  enabled: z.boolean().nullable(),
  remaining: z.number().int().nullable(),
  lastRequest: z.string().nullable(),
  createdAt: z.string(),
  expiresAt: z.string().nullable(),
});
export type UserApiKey = z.infer<typeof UserApiKeySchema>;

/** POST /v1/api-keys create response — includes the full key string exactly once. */
export const CreatedUserApiKeySchema = UserApiKeySchema.omit({
  enabled: true,
  lastRequest: true,
}).extend({ key: z.string() });
export type CreatedUserApiKey = z.infer<typeof CreatedUserApiKeySchema>;

/** GET /v1/api-keys response envelope. */
export const ListUserApiKeysResponseSchema = z.object({
  apiKeys: z.array(UserApiKeySchema),
});
export type ListUserApiKeysResponse = z.infer<typeof ListUserApiKeysResponseSchema>;

/** POST /v1/api-keys request body. Self-serve mints are capped at `read` server-side. */
export const CreateUserApiKeyBodySchema = z.object({
  name: z.string().min(1).describe("Display name, at most 200 bytes."),
  scope: z.enum(API_SCOPES).optional().describe("Defaults to `read`, the self-serve ceiling."),
  expiresInDays: z.number().int().min(1).max(365).optional(),
});
export type CreateUserApiKeyBody = z.infer<typeof CreateUserApiKeyBodySchema>;

/** DELETE /v1/api-keys/:id response. */
export const RevokeUserApiKeyResponseSchema = z.object({ success: z.literal(true) });
export type RevokeUserApiKeyResponse = z.infer<typeof RevokeUserApiKeyResponseSchema>;
