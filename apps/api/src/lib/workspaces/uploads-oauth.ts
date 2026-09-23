/**
 * uploads.sh OAuth client config + token endpoints.
 *
 * Discovery (live): https://uploads.sh/.well-known/oauth-authorization-server
 * Authorize is on uploads.sh; token + revoke stay on auth.uploads.sh.
 * Official public PKCE client `releases-sh` is hardcoded (no secret;
 * `token_endpoint_auth_method: none`). Seeded in prod uploads D1 (uploads#984).
 * Gated on the encryption key resolving — absence is the off switch (no flag).
 */
import { getSecret, type SecretBinding } from "@releases/lib/secrets";
import { isTrustedCorsOrigin } from "../auth/index.js";
import { releaseWebBase } from "@buildinternet/releases-core/release-slug";

export const UPLOADS_OAUTH_CALLBACK_PATH = "/integrations/uploads/callback";
export const UPLOADS_OAUTH_PROVIDER = "uploads" as const;
export const UPLOADS_OAUTH_PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Callbacks the `releases-sh` client must allow-list. Web origin only —
 * never `localhost:8788` (that's uploads-auth / Releases MCP preview).
 */
export const UPLOADS_OAUTH_REGISTERED_REDIRECT_URIS = [
  "https://releases.sh/integrations/uploads/callback",
  "http://localhost:3000/integrations/uploads/callback",
  "http://127.0.0.1:3000/integrations/uploads/callback",
  "https://releases.localhost/integrations/uploads/callback",
] as const;

/** MCP preview (`preview:mcp`) — trusted for CORS, never an uploads redirect. */
const MCP_PREVIEW_PORTS = new Set(["8788"]);

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
  const [clientId, encryptionKey] = await Promise.all([
    resolveSecretLike(env.UPLOADS_OAUTH_CLIENT_ID),
    resolveSecretLike(env.IDEMPOTENCY_ENCRYPTION_KEY),
  ]);
  if (!encryptionKey) return null;
  return {
    clientId: clientId ?? DEFAULT_UPLOADS_OAUTH.clientId,
    authorizeUrl: env.UPLOADS_OAUTH_AUTHORIZE_URL?.trim() || DEFAULT_UPLOADS_OAUTH.authorizeUrl,
    tokenUrl: env.UPLOADS_OAUTH_TOKEN_URL?.trim() || DEFAULT_UPLOADS_OAUTH.tokenUrl,
    revokeUrl: env.UPLOADS_OAUTH_REVOKE_URL?.trim() || DEFAULT_UPLOADS_OAUTH.revokeUrl,
    scopes: env.UPLOADS_OAUTH_SCOPES?.trim() || DEFAULT_UPLOADS_OAUTH.scopes,
    encryptionKey,
  };
}

/** True when the encryption key is resolvable (connect can run). */
export async function uploadsOAuthConfigured(env: UploadsOAuthEnv): Promise<boolean> {
  return (await resolveUploadsOAuthConfig(env)) != null;
}

/**
 * Redirect URI the uploads client must allow-list.
 *
 * Order: explicit `UPLOADS_OAUTH_REDIRECT_URI` → trusted request Origin →
 * `WEB_BASE_URL` (prod fallback `https://releases.sh`). Origin-first keeps
 * local portless (`https://releases.localhost`) and preview
 * (`http://localhost:3000`, `http://127.0.0.1:3000`) working without a
 * wrangler override. MCP preview (`:8788`) is trusted for CORS but is not
 * a web callback — it falls through to `WEB_BASE_URL`.
 */
export function uploadsOAuthRedirectUri(
  env: UploadsOAuthEnv,
  requestOrigin: string | null,
): string {
  const override = env.UPLOADS_OAUTH_REDIRECT_URI?.trim();
  if (override) return override.replace(/\/+$/, "");
  if (requestOrigin && isUploadsOAuthRedirectOrigin(requestOrigin, env)) {
    return `${requestOrigin.replace(/\/+$/, "")}${UPLOADS_OAUTH_CALLBACK_PATH}`;
  }
  return `${releaseWebBase(env)}${UPLOADS_OAUTH_CALLBACK_PATH}`;
}

function isUploadsOAuthRedirectOrigin(origin: string, env: UploadsOAuthEnv): boolean {
  if (!isTrustedCorsOrigin(origin, env)) return false;
  try {
    return !MCP_PREVIEW_PORTS.has(new URL(origin).port);
  } catch {
    return false;
  }
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

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    let b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed == null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function slugFromUnknown(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (value != null && typeof value === "object" && "slug" in value) {
    return slugFromUnknown((value as { slug: unknown }).slug);
  }
  return null;
}

/**
 * uploads.sh access tokens are JWTs. The primary workspace slug is `workspace`;
 * some grants also carry `workspaces[]` (strings or `{ slug }`). Decode only —
 * no extra API call, no signature check (we just received this from the token
 * endpoint).
 */
export function uploadsWorkspaceFromAccessToken(accessToken: string): string | null {
  const payload = decodeJwtPayload(accessToken);
  if (!payload) return null;
  const primary = slugFromUnknown(payload.workspace);
  if (primary) return primary;
  if (!Array.isArray(payload.workspaces)) return null;
  for (const item of payload.workspaces) {
    const slug = slugFromUnknown(item);
    if (slug) return slug;
  }
  return null;
}

function formBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

type TokenJson = {
  access_token?: unknown;
  refresh_token?: unknown;
  token_type?: unknown;
  scope?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
};

async function postToken(
  cfg: UploadsOAuthConfig,
  params: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<UploadsTokenResponse> {
  const res = await fetchImpl(cfg.tokenUrl, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: formBody(params),
  });
  const body = (await res.json().catch(() => null)) as TokenJson | null;
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

export async function exchangeAuthorizationCode(
  cfg: UploadsOAuthConfig,
  params: { code: string; codeVerifier: string; redirectUri: string },
  fetchImpl: typeof fetch = fetch,
): Promise<UploadsTokenResponse> {
  return postToken(
    cfg,
    {
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: params.redirectUri,
      client_id: cfg.clientId,
      code_verifier: params.codeVerifier,
    },
    fetchImpl,
  );
}

/** Refresh grant. The AS only mints a refresh token when `offline_access` was on authorize. */
export async function refreshUploadsAccessToken(
  cfg: UploadsOAuthConfig,
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<UploadsTokenResponse> {
  return postToken(
    cfg,
    {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: cfg.clientId,
    },
    fetchImpl,
  );
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
    }),
  });
  if (!res.ok && res.status !== 200) {
    // RFC 7009: invalid tokens still 200. A 4xx/5xx is the only hard miss.
    throw new Error(`token revoke failed (${res.status})`);
  }
}
