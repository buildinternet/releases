import { z } from "zod";

export const UploadsIntegrationStatusSchema = z.object({
  provider: z.literal("uploads"),
  connected: z.boolean(),
  /** False when the token-encryption key is missing. */
  configured: z.boolean(),
  connectedAt: z.string().nullable(),
  scope: z.string().nullable(),
});

export const UploadsOAuthConnectResponseSchema = z.object({
  authorizeUrl: z.string(),
  redirectUri: z.string(),
});

export const UploadsOAuthCallbackBodySchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const UploadsOAuthCallbackResponseSchema = UploadsIntegrationStatusSchema.extend({
  workspaceId: z.string(),
});
