import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import {
  UploadsOAuthCallbackBodySchema,
  type UploadsIntegrationStatus,
} from "@buildinternet/releases-api-types";
import {
  ServiceUnavailableError,
  UnauthorizedError,
  ValidationError,
  NotFoundError,
} from "@releases/lib/releases-error";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import { workspaceIntegrations } from "../db/schema-integrations.js";
import { encryptOAuthSecret, decryptOAuthSecret } from "../lib/workspaces/oauth-token-crypto.js";
import { persistUploadsTokenGrant } from "../lib/workspaces/uploads-oauth-tokens.js";
import {
  codeChallengeS256,
  generateCodeVerifier,
  generateOAuthState,
} from "../lib/workspaces/pkce.js";
import {
  UPLOADS_OAUTH_PENDING_TTL_MS,
  UPLOADS_OAUTH_PROVIDER,
  buildUploadsAuthorizeUrl,
  exchangeAuthorizationCode,
  resolveUploadsOAuthConfig,
  revokeUploadsToken,
  uploadsOAuthConfigured,
  uploadsOAuthRedirectUri,
} from "../lib/workspaces/uploads-oauth.js";
import {
  requireWorkspaceManager,
  requireWorkspaceMember,
  workspaceGateError,
} from "../lib/workspaces/workspace-access.js";
import { validateJson } from "../lib/validate.js";
import { respondError } from "../lib/error-response.js";
import type { Env } from "../index.js";

function newIntegrationId(): string {
  return `wsi_${crypto.randomUUID()}`;
}

function projectStatus(
  row:
    | {
        status: string;
        scope: string | null;
        connectedAt: number | null;
        providerWorkspace?: string | null;
      }
    | undefined,
  configured: boolean,
): UploadsIntegrationStatus {
  const connected = row?.status === "connected";
  return {
    provider: "uploads",
    connected,
    configured,
    connectedAt:
      connected && row?.connectedAt != null ? new Date(row.connectedAt).toISOString() : null,
    scope: connected ? (row?.scope ?? null) : null,
    uploadsWorkspace: connected ? (row?.providerWorkspace ?? null) : null,
  };
}

export const workspaceIntegrationHandlers = new Hono<Env>();

workspaceIntegrationHandlers.get("/workspaces/:workspaceId/integrations/uploads", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const workspaceId = c.req.param("workspaceId");
  const db = createDb(c.env.DB);
  const member = await requireWorkspaceMember(db, session.user.id, workspaceId);
  if (!member.ok) return respondError(c, workspaceGateError({ ok: false, status: 404 }));

  const [row] = await db
    .select({
      status: workspaceIntegrations.status,
      scope: workspaceIntegrations.scope,
      connectedAt: workspaceIntegrations.connectedAt,
      providerWorkspace: workspaceIntegrations.providerWorkspace,
    })
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.provider, UPLOADS_OAUTH_PROVIDER),
      ),
    )
    .limit(1);

  return c.json(projectStatus(row, await uploadsOAuthConfigured(c.env)));
});

workspaceIntegrationHandlers.post(
  "/workspaces/:workspaceId/integrations/uploads/connect",
  async (c) => {
    const session = c.get("session");
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
    const workspaceId = c.req.param("workspaceId");
    const db = createDb(c.env.DB);
    const gate = await requireWorkspaceManager(db, session.user.id, workspaceId);
    if (!gate.ok) return respondError(c, workspaceGateError(gate));

    const cfg = await resolveUploadsOAuthConfig(c.env);
    if (!cfg) {
      return respondError(
        c,
        new ServiceUnavailableError("uploads OAuth is not configured", {
          code: "service_unavailable",
        }),
      );
    }

    const redirectUri = uploadsOAuthRedirectUri(c.env, c.req.header("Origin") ?? null);
    const state = generateOAuthState();
    const codeVerifier = generateCodeVerifier();
    const codeChallenge = await codeChallengeS256(codeVerifier);
    const now = Date.now();
    const verifierEnc = await encryptOAuthSecret(codeVerifier, cfg.encryptionKey, {
      workspaceId,
      provider: UPLOADS_OAUTH_PROVIDER,
      field: "code_verifier",
    });

    const [existing] = await db
      .select({ id: workspaceIntegrations.id })
      .from(workspaceIntegrations)
      .where(
        and(
          eq(workspaceIntegrations.workspaceId, workspaceId),
          eq(workspaceIntegrations.provider, UPLOADS_OAUTH_PROVIDER),
        ),
      )
      .limit(1);

    if (existing) {
      await db
        .update(workspaceIntegrations)
        .set({
          oauthState: state,
          codeVerifierEnc: verifierEnc,
          redirectUri,
          pendingExpiresAt: now + UPLOADS_OAUTH_PENDING_TTL_MS,
          updatedAt: now,
        })
        .where(eq(workspaceIntegrations.id, existing.id));
    } else {
      await db.insert(workspaceIntegrations).values({
        id: newIntegrationId(),
        workspaceId,
        provider: UPLOADS_OAUTH_PROVIDER,
        status: "pending",
        oauthState: state,
        codeVerifierEnc: verifierEnc,
        redirectUri,
        pendingExpiresAt: now + UPLOADS_OAUTH_PENDING_TTL_MS,
        createdAt: now,
        updatedAt: now,
      });
    }

    const authorizeUrl = buildUploadsAuthorizeUrl({
      authorizeUrl: cfg.authorizeUrl,
      clientId: cfg.clientId,
      redirectUri,
      scopes: cfg.scopes,
      state,
      codeChallenge,
    });

    logEvent("info", {
      component: "uploads-oauth",
      event: "connect-started",
      workspaceId,
    });

    return c.json({ authorizeUrl, redirectUri });
  },
);

workspaceIntegrationHandlers.delete("/workspaces/:workspaceId/integrations/uploads", async (c) => {
  const session = c.get("session");
  if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
  const workspaceId = c.req.param("workspaceId");
  const db = createDb(c.env.DB);
  const gate = await requireWorkspaceManager(db, session.user.id, workspaceId);
  if (!gate.ok) return respondError(c, workspaceGateError(gate));

  const [row] = await db
    .select()
    .from(workspaceIntegrations)
    .where(
      and(
        eq(workspaceIntegrations.workspaceId, workspaceId),
        eq(workspaceIntegrations.provider, UPLOADS_OAUTH_PROVIDER),
      ),
    )
    .limit(1);

  if (row) {
    const cfg = await resolveUploadsOAuthConfig(c.env);
    if (cfg && (row.refreshTokenEnc || row.accessTokenEnc)) {
      try {
        const tokenEnc = row.refreshTokenEnc ?? row.accessTokenEnc;
        const field = row.refreshTokenEnc ? "refresh_token" : "access_token";
        if (tokenEnc) {
          const token = await decryptOAuthSecret(tokenEnc, cfg.encryptionKey, {
            workspaceId,
            provider: UPLOADS_OAUTH_PROVIDER,
            field,
          });
          await revokeUploadsToken(
            cfg,
            token,
            field === "refresh_token" ? "refresh_token" : "access_token",
          );
        }
      } catch (err) {
        logEvent("warn", {
          component: "uploads-oauth",
          event: "revoke-failed",
          workspaceId,
          err,
        });
      }
    }
    await db.delete(workspaceIntegrations).where(eq(workspaceIntegrations.id, row.id));
  }

  logEvent("info", {
    component: "uploads-oauth",
    event: "disconnected",
    workspaceId,
  });

  return c.json(projectStatus(undefined, await uploadsOAuthConfigured(c.env)));
});

workspaceIntegrationHandlers.post(
  "/integrations/uploads/callback",
  validateJson(UploadsOAuthCallbackBodySchema),
  async (c) => {
    const session = c.get("session");
    if (!session) return respondError(c, new UnauthorizedError("Sign in required"));
    const { code, state } = c.req.valid("json");
    const db = createDb(c.env.DB);

    const [row] = await db
      .select()
      .from(workspaceIntegrations)
      .where(eq(workspaceIntegrations.oauthState, state))
      .limit(1);
    if (!row || !row.codeVerifierEnc || !row.redirectUri) {
      return respondError(
        c,
        new ValidationError("Unknown or expired OAuth state", { code: "bad_request" }),
      );
    }
    if (row.pendingExpiresAt != null && row.pendingExpiresAt < Date.now()) {
      return respondError(
        c,
        new ValidationError("OAuth state expired — start connect again", { code: "bad_request" }),
      );
    }

    const gate = await requireWorkspaceManager(db, session.user.id, row.workspaceId);
    if (!gate.ok) {
      return respondError(
        c,
        gate.status === 404 ? new NotFoundError("Workspace not found") : workspaceGateError(gate),
      );
    }

    const cfg = await resolveUploadsOAuthConfig(c.env);
    if (!cfg) {
      return respondError(
        c,
        new ServiceUnavailableError("uploads OAuth is not configured", {
          code: "service_unavailable",
        }),
      );
    }

    let codeVerifier: string;
    try {
      codeVerifier = await decryptOAuthSecret(row.codeVerifierEnc, cfg.encryptionKey, {
        workspaceId: row.workspaceId,
        provider: UPLOADS_OAUTH_PROVIDER,
        field: "code_verifier",
      });
    } catch {
      return respondError(
        c,
        new ServiceUnavailableError("Could not read stored OAuth state", {
          code: "service_unavailable",
        }),
      );
    }

    let tokens;
    try {
      tokens = await exchangeAuthorizationCode(cfg, {
        code,
        codeVerifier,
        redirectUri: row.redirectUri,
      });
    } catch (err) {
      logEvent("error", {
        component: "uploads-oauth",
        event: "token-exchange-failed",
        workspaceId: row.workspaceId,
        err,
      });
      return respondError(
        c,
        new ValidationError(err instanceof Error ? err.message : "Token exchange failed", {
          code: "bad_request",
        }),
      );
    }

    const now = Date.now();
    const { uploadsWorkspace } = await persistUploadsTokenGrant(db, {
      rowId: row.id,
      workspaceId: row.workspaceId,
      tokens,
      encryptionKey: cfg.encryptionKey,
      mode: "connect",
      now,
    });

    logEvent("info", {
      component: "uploads-oauth",
      event: "connected",
      workspaceId: row.workspaceId,
      uploadsWorkspace,
    });

    return c.json({
      provider: "uploads",
      connected: true,
      configured: true,
      connectedAt: new Date(now).toISOString(),
      scope: tokens.scope,
      uploadsWorkspace,
      workspaceId: row.workspaceId,
    });
  },
);
