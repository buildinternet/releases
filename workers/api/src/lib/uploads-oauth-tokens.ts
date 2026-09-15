/**
 * Persist / rotate an uploads.sh token grant on `workspace_integrations`.
 *
 * Callback uses {@link persistUploadsTokenGrant}. Later file reads should call
 * {@link ensureFreshUploadsAccessToken}, which refreshes via the
 * `refresh_token` grant when `offline_access` minted a refresh token.
 */
import { eq } from "drizzle-orm";
import type { AnyDb } from "../db.js";
import {
  workspaceIntegrations,
  type WorkspaceIntegration,
} from "../db/schema-integrations.js";
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
    /** `connect` writes refresh=null when the AS omitted one; `refresh` keeps the stored RT. */
    mode: "connect" | "refresh";
    existingWorkspace?: string | null;
    now?: number;
  },
): Promise<{ uploadsWorkspace: string | null }> {
  const now = opts.now ?? Date.now();
  const decoded = uploadsWorkspaceFromAccessToken(opts.tokens.accessToken);
  const uploadsWorkspace = decoded ?? opts.existingWorkspace ?? null;

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
    patch.refreshTokenEnc = await encryptOAuthSecret(
      opts.tokens.refreshToken,
      opts.encryptionKey,
      {
        workspaceId: opts.workspaceId,
        provider: UPLOADS_OAUTH_PROVIDER,
        field: "refresh_token",
      },
    );
  }

  await db
    .update(workspaceIntegrations)
    .set(patch)
    .where(eq(workspaceIntegrations.id, opts.rowId));

  return { uploadsWorkspace };
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
  const { uploadsWorkspace } = await persistUploadsTokenGrant(db, {
    rowId: row.id,
    workspaceId: row.workspaceId,
    tokens,
    encryptionKey: cfg.encryptionKey,
    mode: "refresh",
    existingWorkspace: row.providerWorkspace,
  });
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
