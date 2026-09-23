import { sqliteTable, text, integer, index, uniqueIndex } from "drizzle-orm/sqlite-core";
import { authOrganization } from "./schema-auth.js";

/**
 * Workspace-scoped third-party OAuth connections (uploads.sh today).
 *
 * Worker-local schema island — user-tenancy data the OSS CLI has no business
 * with, same split as `schema-follows.ts`. Tokens are AES-256-GCM encrypted
 * before insert (see `lib/workspaces/oauth-token-crypto.ts`); this table never stores
 * plaintext access/refresh tokens or the PKCE verifier.
 *
 * Paired migrations: 20260915183000_add_workspace_integrations.sql,
 * 20260915193000_add_workspace_integrations_provider_workspace.sql.
 */
export const WORKSPACE_INTEGRATION_PROVIDERS = ["uploads"] as const;
export type WorkspaceIntegrationProvider = (typeof WORKSPACE_INTEGRATION_PROVIDERS)[number];

export const WORKSPACE_INTEGRATION_STATUSES = ["pending", "connected"] as const;
export type WorkspaceIntegrationStatus = (typeof WORKSPACE_INTEGRATION_STATUSES)[number];

export const workspaceIntegrations = sqliteTable(
  "workspace_integrations",
  {
    id: text("id").primaryKey(),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => authOrganization.id, { onDelete: "cascade" }),
    provider: text("provider", { enum: WORKSPACE_INTEGRATION_PROVIDERS }).notNull(),
    status: text("status", { enum: WORKSPACE_INTEGRATION_STATUSES }).notNull(),
    oauthState: text("oauth_state"),
    codeVerifierEnc: text("code_verifier_enc"),
    redirectUri: text("redirect_uri"),
    pendingExpiresAt: integer("pending_expires_at"),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenType: text("token_type"),
    scope: text("scope"),
    accessTokenExpiresAt: integer("access_token_expires_at"),
    /** Remote provider workspace slug (uploads.sh JWT `workspace` claim). */
    providerWorkspace: text("provider_workspace"),
    connectedAt: integer("connected_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    uniqueIndex("idx_workspace_integrations_unique").on(t.workspaceId, t.provider),
    index("idx_workspace_integrations_state").on(t.oauthState),
    index("idx_workspace_integrations_workspace").on(t.workspaceId),
  ],
);

export type WorkspaceIntegration = typeof workspaceIntegrations.$inferSelect;
export type NewWorkspaceIntegration = typeof workspaceIntegrations.$inferInsert;
