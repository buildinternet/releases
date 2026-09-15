/**
 * uploads.sh OAuth client config + token endpoints.
 *
 * Discovery (live): https://uploads.sh/.well-known/oauth-authorization-server
 * Authorize is on uploads.sh; token + revoke stay on auth.uploads.sh.
 * Defaults match that document so a missing override still talks to the
 * registered `releases-sh` client. Gated on client id + secret resolving —
 * absence is the off switch (no feature flag).
 */
import { getSecret, type SecretBinding } from "@releases/lib/secrets";
import { isTrustedCorsOrigin } from "../auth/index.js";
import { releaseWebBase } from "@buildinternet/releases-core/release-slug";

export const UPLOADS_OAUTH_CALLBACK_PATH = "/integrations/uploads/callback";
export const UPLOADS_OAUTH_PROVIDER = "uploads" as const;
export const UPLOADS_OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

export const DEFAULT_UPLOADS_OAUTH = {
  clientId: "releases-sh",
  authorizeUrl: "https://uploads.sh/api/auth/oauth2/authorize",
  tokenUrl: "https://auth.uploads.sh/api/auth/oauth2/token",
  revokeUrl: "https://auth.uploads.sh/api/auth/oauth2/revoke",
  scopes: "files:read offline_access",
} as const;

type SecretLike = SecretBinding | string | undefined;

export interface UploadsOAuthEnv {
  UPLOADS_OAUTH_CLIENT_ID?: SecretLike;
  UPLOADS_OAUTH_CLIENT_SECRET?: SecretLike;
  UPLOADS_OAUTH_AUTHORIZE_URL?: string;
  UPLOADS_OAUTH_TOKEN_URL?: string;
  UPLOADS_OAUTH_REVOKE_URL?: string;
  UPLOADS_OAUTH_SCOPES?: string;
  UPLOADS_OAUTH_REDIRECT_URI?: string;
  WEB_BASE_URL?: string;
  ENVIRONMENT?: string;
  BETTER_AUTH_TRUSTED_ORIGINS?: string;
  IDEMPOTENCY_ENCRYPTION_KEY?: SecretBinding | string;
}

export interface UploadsOAuthConfig {
  clientId: string;
  clientSecret: string;
  authorizeUrl: string;
  tokenUrl: string;
  revokeUrl: string;
  scopes: string;
  encryptionKey: string;
}

async function resolveSecretLike(value: SecretLike): Promise<string | null> {
  if (value == null) return null;
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  try {
    const resolved = await getSecret(value);
    const trimmed = resolved?.trim();
    return trimmed && trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export async function resolveUploadsOAuthConfig(
  env: UploadsOAuthEnv,
): Promise<UploadsOAuthConfig | null> {
  const [clientId, clientSecret, encryptionKey] = await Promise.all([
    resolveSecretLike(env.UPLOADS_OAUTH_CLIENT_ID),
    resolveSecretLike(env.UPLOADS_OAUTH_CLIENT_SECRET),
    resolveSecretLike(env.IDEMPOTENCY_ENCRYPTION_KEY),
  ]);
  const resolvedClientId = clientId ?? DEFAULT_UPLOADS_OAUTH.clientId;
  if (!clientSecret || !encryptionKey) return null;
  return {
    clientId: resolvedClientId,
    clientSecret,
    authorizeUrl: env.UPLOADS_OAUTH_AUTHORIZE_URL?.trim() || DEFAULT_UPLOADS_OAUTH.authorizeUrl,
    tokenUrl: env.UPLOADS_OAUTH_TOKEN_URL?.trim() || DEFAULT_UPLOADS_OAUTH.tokenUrl,
    revokeUrl: env.UPLOADS_OAUTH_REVOKE_URL?.trim() || DEFAULT_UPLOADS_OAUTH.revokeUrl,
    scopes: env.UPLOADS_OAUTH_SCOPES?.trim() || DEFAULT_UPLOADS_OAUTH.scopes,
    encryptionKey,
  };
}

/** True when client secret + encryption key are both resolvable (connect can run). */
export async function uploadsOAuthConfigured(env: UploadsOAuthEnv): Promise<boolean> {
  return (await resolveUploadsOAuthConfig(env)) != null;
}

/**
 * Redirect URI the uploads client must allow-list.
 *
 * Order: explicit `UPLOADS_OAUTH_REDIRECT_URI` → trusted request Origin →
 * `WEB_BASE_URL` (prod fallback `https://releases.sh`). Origin-first keeps
 * local portless (`https://releases.localhost`) and preview
 * (`http://localhost:3000`) working without a wrangler override.
 */
export function uploadsOAuthRedirectUri(
  env: UploadsOAuthEnv,
  requestOrigin: string | null,
): string {
  const override = env.UPLOADS_OAUTH_REDIRECT_URI?.trim();
  if (override) return override.replace(/\/+$/, "");
  if (requestOrigin && isTrustedCorsOrigin(requestOrigin, env)) {
    return `${requestOrigin.replace(/\/+$/, "")}${UPLOADS_OAUTH_CALLBACK_PATH}`;
  }
  return `${releaseWebBase(env)}${UPLOADS_OAUTH_CALLBACK_PATH}`;
}

export function buildUploadsAuthorizeUrl(opts: {
  authorizeUrl: string;
  clientId: string;
  redirectUri: string;
  scopes: string;
  state: string;
  codeChallenge: string;
}): string {
  const url = new URL(opts.authorizeUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", opts.clientId);
  url.searchParams.set("redirect_uri", opts.redirectUri);
  url.searchParams.set("scope", opts.scopes);
  url.searchParams.set("state", opts.state);
  url.searchParams.set("code_challenge", opts.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface UploadsTokenResponse {
  accessToken: string;
  refreshToken: string | null;
  tokenType: string;
  scope: string | null;
  expiresAt: number | null;
}

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

export async function exchangeAuthorizationCode(
  cfg: UploadsOAuthConfig,
  params: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<UploadsTokenResponse> {
  const res = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: formBody({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      code_verifier: params.codeVerifier,
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    access_token?: unknown;
    refresh_token?: unknown;
    token_type?: unknown;
    scope?: unknown;
    expires_in?: unknown;
    error?: unknown;
    error_description?: unknown;
  } | null;
  if (!res.ok || !body || typeof body.access_token !== "string" || !body.access_token) {
    const detail =
      (typeof body?.error_description === "string" && body.error_description) ||
      (typeof body?.error === "string" && body.error) ||
      `token exchange failed (${res.status})`;
    throw new Error(detail);
  }
  const expiresIn = typeof body.expires_in === "number" ? body.expires_in : null;
  return {
    accessToken: body.access_token,
    refreshToken: typeof body.refresh_token === "string" ? body.refresh_token : null,
    tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
    scope: typeof body.scope === "string" ? body.scope : null,
    expiresAt: expiresIn != null ? Date.now() + expiresIn * 1000 : null,
  };
}

/** RFC 7009 revoke — fail-open. Local disconnect still proceeds if this throws. */
export async function revokeUploadsToken(
  cfg: UploadsOAuthConfig,
  token: string,
  tokenTypeHint: "access_token" | "refresh_token",
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const res = await fetchImpl(cfg.revokeUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: formBody({
      token,
      token_type_hint: tokenTypeHint,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
    }),
  });
  if (!res.ok && res.status !== 200) {
    // RFC 7009: invalid tokens still 200. A 4xx/5xx is the only hard miss.
    throw new Error(`token revoke failed (${res.status})`);
  }
}
