import { z } from "zod";

export const UploadsIntegrationStatusSchema = z.object({
  provider: z.literal("uploads"),
  connected: z.boolean(),
  /** False when the token-encryption key is missing. */
  configured: z.boolean(),
  connectedAt: z.string().nullable(),
  scope: z.string().nullable(),
  /** uploads.sh workspace slug from the access-token JWT (`workspace`, else `workspaces[]`). */
  uploadsWorkspace: z.string().nullable(),
  /**
   * True while a reconnect is in progress on a row that still has tokens.
   * The previous grant stays connected until the new callback finishes.
   */
  reconnecting: z.boolean(),
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
