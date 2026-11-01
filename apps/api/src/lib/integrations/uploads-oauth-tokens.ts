/**
 * Persist / rotate an uploads.sh token grant on `workspace_integrations`.
 *
 * Callback uses {@link persistUploadsTokenGrant}. Later file reads should call
 * {@link ensureFreshUploadsAccessToken}, which refreshes via the
 * `refresh_token` grant when `offline_access` minted a refresh token.
 */
import { and, eq } from "drizzle-orm";
import type { AnyDb } from "../../db.js";
import { workspaceIntegrations, type WorkspaceIntegration } from "../../db/schema-integrations.js";
import { decryptOAuthSecret, encryptOAuthSecret } from "./oauth-token-crypto.js";
import {
  UPLOADS_OAUTH_PROVIDER,
  refreshUploadsAccessToken,
  uploadsWorkspaceFromAccessToken,
  type UploadsOAuthConfig,
  type UploadsTokenResponse,
} from "./uploads-oauth.js";

/** Refresh this many ms before `expires_at` so a just-loaded token isn't already stale. */
export const UPLOADS_ACCESS_TOKEN_REFRESH_SKEW_MS = 60_000;

export function accessTokenNeedsRefresh(
  expiresAt: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (expiresAt == null) return false;
  return expiresAt <= now + UPLOADS_ACCESS_TOKEN_REFRESH_SKEW_MS;
}

export async function persistUploadsTokenGrant(
  db: AnyDb,
  opts: {
    rowId: string;
    workspaceId: string;
    tokens: UploadsTokenResponse;
    encryptionKey: string;
    now?: number;
  } & (
    | {
        /** Connect commits only while `oauth_state` is still the state this callback read. */
        mode: "connect";
        expectedOAuthState: string;
      }
    | {
        /** `refresh` keeps the stored refresh token when the AS omits a new one. */
        mode: "refresh";
        existingWorkspace?: string | null;
        /** Ciphertext this refresh decrypted. A connect that replaced it wins. */
        expectedRefreshTokenEnc: string;
      }
  ),
): Promise<{ uploadsWorkspace: string | null; persisted: boolean }> {
  const now = opts.now ?? Date.now();
  const decoded = uploadsWorkspaceFromAccessToken(opts.tokens.accessToken);
  const existingWorkspace = opts.mode === "refresh" ? opts.existingWorkspace : null;
  const uploadsWorkspace = decoded ?? existingWorkspace ?? null;

  const accessTokenEnc = await encryptOAuthSecret(opts.tokens.accessToken, opts.encryptionKey, {
    workspaceId: opts.workspaceId,
    provider: UPLOADS_OAUTH_PROVIDER,
    field: "access_token",
  });

  const patch: {
    status: "connected";
    oauthState: null;
    codeVerifierEnc: null;
    redirectUri: null;
    pendingExpiresAt: null;
    accessTokenEnc: string;
    refreshTokenEnc?: string | null;
    tokenType: string;
    scope: string | null;
    accessTokenExpiresAt: number | null;
    providerWorkspace: string | null;
    connectedAt?: number;
    updatedAt: number;
  } = {
    status: "connected",
    oauthState: null,
    codeVerifierEnc: null,
    redirectUri: null,
    pendingExpiresAt: null,
    accessTokenEnc,
    tokenType: opts.tokens.tokenType,
    scope: opts.tokens.scope,
    accessTokenExpiresAt: opts.tokens.expiresAt,
    providerWorkspace: uploadsWorkspace,
    updatedAt: now,
  };

  if (opts.mode === "connect") {
    patch.connectedAt = now;
    patch.refreshTokenEnc = opts.tokens.refreshToken
      ? await encryptOAuthSecret(opts.tokens.refreshToken, opts.encryptionKey, {
          workspaceId: opts.workspaceId,
          provider: UPLOADS_OAUTH_PROVIDER,
          field: "refresh_token",
        })
      : null;
  } else if (opts.tokens.refreshToken) {
    patch.refreshTokenEnc = await encryptOAuthSecret(opts.tokens.refreshToken, opts.encryptionKey, {
      workspaceId: opts.workspaceId,
      provider: UPLOADS_OAUTH_PROVIDER,
      field: "refresh_token",
    });
  }

  // Connect is compare-and-set on the oauth state captured before the token
  // exchange. A newer connect (or a disconnect) that landed meanwhile must
  // win; this callback's grant is not stored.
  const where =
    opts.mode === "connect"
      ? and(
          eq(workspaceIntegrations.id, opts.rowId),
          eq(workspaceIntegrations.oauthState, opts.expectedOAuthState),
        )
      : and(
          eq(workspaceIntegrations.id, opts.rowId),
          eq(workspaceIntegrations.refreshTokenEnc, opts.expectedRefreshTokenEnc),
        );
  const updated = await db
    .update(workspaceIntegrations)
    .set(patch)
    .where(where)
    .returning({ id: workspaceIntegrations.id });

  return { uploadsWorkspace, persisted: updated.length > 0 };
}

export async function refreshStoredUploadsGrant(
  db: AnyDb,
  row: WorkspaceIntegration,
  cfg: UploadsOAuthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ tokens: UploadsTokenResponse; uploadsWorkspace: string | null }> {
  if (!row.refreshTokenEnc) {
    throw new Error("uploads grant has no refresh token");
  }
  const refreshToken = await decryptOAuthSecret(row.refreshTokenEnc, cfg.encryptionKey, {
    workspaceId: row.workspaceId,
    provider: UPLOADS_OAUTH_PROVIDER,
    field: "refresh_token",
  });
  const tokens = await refreshUploadsAccessToken(cfg, refreshToken, fetchImpl);
  const { uploadsWorkspace, persisted } = await persistUploadsTokenGrant(db, {
    rowId: row.id,
    workspaceId: row.workspaceId,
    tokens,
    encryptionKey: cfg.encryptionKey,
    mode: "refresh",
    existingWorkspace: row.providerWorkspace,
    expectedRefreshTokenEnc: row.refreshTokenEnc,
  });
  if (!persisted) {
    // A connect callback replaced this grant while the refresh was in flight.
    // Hand back the token we just minted for this call; leave the stored row
    // on the newer grant.
    return { tokens, uploadsWorkspace };
  }
  return { tokens, uploadsWorkspace };
}

/**
 * Decrypt a usable access token, refreshing via `refresh_token` when expired.
 * Callers that read uploads files should use this rather than the stored
 * ciphertext directly.
 */
export async function ensureFreshUploadsAccessToken(
  db: AnyDb,
  row: WorkspaceIntegration,
  cfg: UploadsOAuthConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accessToken: string; uploadsWorkspace: string | null }> {
  if (row.accessTokenEnc && !accessTokenNeedsRefresh(row.accessTokenExpiresAt)) {
    const accessToken = await decryptOAuthSecret(row.accessTokenEnc, cfg.encryptionKey, {
      workspaceId: row.workspaceId,
      provider: UPLOADS_OAUTH_PROVIDER,
      field: "access_token",
    });
    return {
      accessToken,
      uploadsWorkspace: row.providerWorkspace ?? uploadsWorkspaceFromAccessToken(accessToken),
    };
  }
  const refreshed = await refreshStoredUploadsGrant(db, row, cfg, fetchImpl);
  return {
    accessToken: refreshed.tokens.accessToken,
    uploadsWorkspace: refreshed.uploadsWorkspace,
  };
}
