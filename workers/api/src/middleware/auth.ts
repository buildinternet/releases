import type { Context, MiddlewareHandler } from "hono";
import { FLAGS, flag, type FlagDef } from "@releases/lib/flags";
import { getSecret, getSecretWithFallback } from "@releases/lib/secrets";
import {
  buildConsumptionPayload,
  type ConsumptionIdentity,
  OAUTH_JWT_TOKEN_PREFIX,
} from "@releases/lib/consumption-ref";
import { logEvent } from "@releases/lib/log-event";
import {
  type ApiScope,
  isApiTokenShaped,
  isUserApiKeyShaped,
  ROOT_SCOPE,
  scopeSatisfies,
  USER_API_KEY_PREFIX,
  type PrincipalType,
} from "@buildinternet/releases-core/api-token";
import {
  isJwtShaped,
  verifyOAuthJwt,
  localKeyResolver,
  type OAuthJwtConfig,
  type JWTVerifyGetKey,
  type VerifiedOAuthToken,
} from "@releases/lib/oauth-jwt";
import {
  UnauthorizedError,
  NotFoundError,
  RateLimitedError,
  InsufficientScopeError,
} from "@releases/lib/releases-error";
import { createDb } from "../db.js";
import { touchLastUsed, verifyApiToken } from "./token-store.js";
import type { Env } from "../index.js";
import { createAuth } from "../auth/index.js";
import { apiScopesFromPermissions, clampUserKeyScopes } from "../auth/api-key-scope.js";
import { respondError } from "../lib/error-response.js";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Custom header carrying the trusted-proxy shared secret. */
export const PROXY_KEY_HEADER = "X-Releases-Proxy-Key";

/** Resolved identity attached to the Hono context for downstream handlers. */
export type AuthContext =
  | { kind: "root"; scopes: string[] }
  | {
      kind: "token";
      tokenId: string;
      scopes: string[];
      machinePrincipalType?: PrincipalType;
    };

/** Minimal session shape attached to the Hono context by `requireSession`. */
export type AuthSessionContext = { user: { id: string; email: string; name: string } };

/**
 * The request's `waitUntil` (for handing background work — metering writes, email
 * sends — to the runtime so it outlives the response), or undefined when there's
 * no execution context (tests / non-request callers, where it runs inline).
 */
export function execWaitUntil(c: Context<Env>): ((p: Promise<unknown>) => void) | undefined {
  try {
    return c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    return undefined;
  }
}

/**
 * Resolve the request's Better Auth instance: the injected `betterAuth` test
 * seam if present, else a fresh per-request instance. Mirrors the
 * `c.get("db") ?? createDb(...)` lazy-init + test-injection pattern.
 */
export async function getOrCreateAuth(c: Context<Env>) {
  return c.get("betterAuth") ?? (await createAuth(c.env));
}

type ResolvedAuth =
  | { kind: "root"; scopes: string[] }
  | {
      kind: "token";
      tokenId: string;
      scopes: string[];
      machinePrincipalType?: PrincipalType;
    }
  | { kind: "rate_limited" }
  // skip=true means "local dev, no secret configured" — preserve open access.
  | { kind: "none"; skip: boolean };

function bearer(c: Context<Env>): string {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Resource-server config for verifying "Sign in with Releases" OAuth JWTs
 * (#1483). The API worker is its own audience (the bare `BETTER_AUTH_URL`
 * origin — the resource identifier a client requests via RFC 8707 `resource`),
 * but the `iss` it must match is the AS's canonical issuer: the origin PLUS the
 * `/api/auth` basePath (what the discovery doc advertises and the token `iss`
 * carries). Using the bare origin as issuer rejected every real token (jose
 * exact-match) — #1483 issuer-mismatch fix. Returns null when no origin can be
 * resolved (e.g. local dev without BETTER_AUTH_URL) — the JWT lane is then
 * simply inert. The JWKS URL is derived origin-relative as `${origin}/api/auth/jwks`.
 */
function oauthJwtConfig(env: Env["Bindings"]): OAuthJwtConfig | null {
  if (!env.BETTER_AUTH_URL) return null;
  let origin: string;
  try {
    origin = new URL(env.BETTER_AUTH_URL).origin;
  } catch {
    return null;
  }
  return { issuer: `${origin}/api/auth`, audience: origin };
}

// This worker IS the authorization server, so it verifies its OWN OAuth/session
// JWTs with keys read in-process — never via verifyOAuthJwt's default remote
// fetch of `${origin}/api/auth/jwks`, which is a self-subrequest to this worker's
// own public hostname. On Cloudflare such a self-fetch can be routed to a
// (nonexistent) origin and fail, which would reject every otherwise-valid token
// (the bug behind admin actions 401ing despite a correctly-minted token).
// Cross-worker resource servers (MCP) legitimately keep the remote path.
// Cached module-wide; rebuilt on a verify miss in case the signing key rotated.
let inProcessJwks: JWTVerifyGetKey | null = null;

async function localJwksResolver(env: Env["Bindings"]): Promise<JWTVerifyGetKey | undefined> {
  if (inProcessJwks) return inProcessJwks;
  if (!env.BETTER_AUTH_URL) return undefined;
  try {
    const origin = new URL(env.BETTER_AUTH_URL).origin;
    const auth = await createAuth(env);
    const res = await auth.handler(new Request(`${origin}/api/auth/jwks`, { method: "GET" }));
    if (!res.ok) return undefined;
    inProcessJwks = localKeyResolver(await res.json());
    return inProcessJwks;
  } catch {
    return undefined;
  }
}

/**
 * Verify a presented OAuth/session JWT against this worker's keys. Prefers the
 * in-process JWKS; a context-injected `oauthJwtKeyResolver` (test seam) wins;
 * falls back to verifyOAuthJwt's remote fetch only when neither is available.
 * On a miss with the cached in-process set, rebuilds it once and retries so a
 * key rotation doesn't 401 every caller until the next worker restart.
 */
async function verifyPresentedJwt(
  c: Context<Env>,
  presented: string,
): Promise<VerifiedOAuthToken | null> {
  const cfg = oauthJwtConfig(c.env);
  if (!cfg) return null;
  const injected = c.get("oauthJwtKeyResolver");
  cfg.keyResolver = injected ?? (await localJwksResolver(c.env));
  let verified = await verifyOAuthJwt(presented, cfg);
  if (!verified && !injected && inProcessJwks) {
    inProcessJwks = null;
    cfg.keyResolver = await localJwksResolver(c.env);
    verified = await verifyOAuthJwt(presented, cfg);
  }
  return verified;
}

/**
 * Verify a `relu_` user key via Better Auth. Returns the resolved scopes (the
 * cumulative `api` permission actions) on success. `rateLimited` lets the caller
 * answer 429 instead of a generic 401. Builds a per-request auth instance; the
 * surrounding `resolveAuth` memo ensures this runs (and meters) at most once.
 */
async function verifyUserKey(
  c: Context<Env>,
  presented: string,
): Promise<
  | { ok: true; scopes: string[]; keyId: string; userId: string | null }
  | { ok: false; rateLimited: boolean }
> {
  try {
    const auth = await getOrCreateAuth(c);
    // apiKey() is registered conditionally (flag-gated), so betterAuth's inferred
    // `api` type doesn't statically expose verifyApiKey. We only reach here when the
    // flag is on (checked in resolveAuthUncached), so the endpoint is mounted; assert
    // its shape with a precise (non-any) structural cast.
    const verifyApiKey = (
      auth.api as {
        verifyApiKey?: (a: { body: { key: string } }) => Promise<{
          valid: boolean;
          error?: { code?: string | null } | null;
          key?: {
            id?: string;
            userId?: string | null;
            permissions?: Record<string, string[]> | null;
          } | null;
        }>;
      }
    ).verifyApiKey;
    if (!verifyApiKey) return { ok: false, rateLimited: false };
    const result = await verifyApiKey({ body: { key: presented } });
    if (result.valid && result.key) {
      const scopes = apiScopesFromPermissions(result.key.permissions);
      if (scopes.length > 0)
        return {
          ok: true,
          scopes,
          keyId: result.key.id ?? presented.slice(0, 12),
          userId: result.key.userId ?? null,
        };
      return { ok: false, rateLimited: false };
    }
    const code = result.error?.code ?? "";
    return { ok: false, rateLimited: /rate.?limit/i.test(code) };
  } catch (err) {
    // An UNEXPECTED verify error (transient DB/plugin failure) must not 500 a
    // public read — deny the credential and let the public-read path stay public.
    logEvent("warn", {
      component: "auth",
      event: "user-key-verify-error",
      message: "relu_ key verification threw; denying credential",
      error: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, rateLimited: false };
  }
}

/**
 * Validate a presented `relu_` user key for the RATE-LIMIT account tier only —
 * never for authorization. Returns `{ valid, userId }`. Flag-gated exactly like
 * the metered lane (`API_TOKENS_DISABLED` kill switch + `USER_API_KEYS_ENABLED`
 * rollout): when either gate is closed the key is treated as not-an-account
 * (`{ valid: false }`), so it falls to the anonymous IP rung — matching today's
 * behavior. The limiter calls this behind a ~60s KV cache, so the underlying
 * `verifyUserKey` (which meters) runs at most once per key per window.
 */
export async function validateAccountCredential(
  c: Context<Env>,
  presented: string,
): Promise<{ valid: boolean; userId?: string }> {
  if (!isUserApiKeyShaped(presented)) return { valid: false };
  if (await flag(c.env.FLAGS, c.env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled))
    return { valid: false };
  if (!(await flag(c.env.FLAGS, c.env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled)))
    return { valid: false };
  const v = await verifyUserKey(c, presented);
  if (v.ok && v.userId) return { valid: true, userId: v.userId };
  return { valid: false };
}

const RESOLVE_MEMO_METERED = new WeakMap<Request, Promise<ResolvedAuth>>();
const RESOLVE_MEMO_UNMETERED = new WeakMap<Request, Promise<ResolvedAuth>>();

/**
 * Memoize resolution per request AND per metering mode. `resolveAuth` runs
 * several times per request (rate limiter, auth middleware, isValidBearerAuth);
 * Better Auth's verifyApiKey meters on every call, so memoization keeps a relu_
 * key metered at most once. The mode split lets the limiter / public-read attach
 * resolve a relu_ key WITHOUT metering (they pass `meterUserKeys=false`) while
 * the authenticated authorization point meters once (`true`). Keyed on the
 * underlying Request (stable per request, WeakMap auto-GCs).
 */
function resolveAuth(
  c: Context<Env>,
  presented: string,
  meterUserKeys: boolean,
): Promise<ResolvedAuth> {
  const memo = meterUserKeys ? RESOLVE_MEMO_METERED : RESOLVE_MEMO_UNMETERED;
  const key = c.req.raw;
  const cached = memo.get(key);
  if (cached) return cached;
  const p = resolveAuthUncached(c, presented, meterUserKeys);
  memo.set(key, p);
  return p;
}

/**
 * Resolve a presented credential to an identity. `relu_…` user keys are verified
 * + metered by Better Auth's verifyApiKey ONLY when `meterUserKeys` is true (the
 * authenticated authorization point); otherwise they resolve to anonymous so a
 * public read never burns the key's budget. `relk_…` tokens go to the DB path;
 * everything else compares to the static RELEASES_API_KEY (root).
 */
async function resolveAuthUncached(
  c: Context<Env>,
  presented: string,
  meterUserKeys: boolean,
): Promise<ResolvedAuth> {
  if (isUserApiKeyShaped(presented)) {
    // Exempt path (limiter, public reads): do not verify/meter — read as anonymous.
    if (!meterUserKeys) return { kind: "none", skip: false };
    if (await flag(c.env.FLAGS, c.env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled))
      return { kind: "none", skip: false };
    if (!(await flag(c.env.FLAGS, c.env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled)))
      return { kind: "none", skip: false };
    const v = await verifyUserKey(c, presented);
    if (v.ok) {
      // User keys are read-only. Clamp to the user-key ceiling regardless of the
      // permissions stored on the key, so write/admin is unreachable for the
      // user lane even if a write-permissioned relu_ key was minted or granted
      // out-of-band. An empty result (no read) denies.
      const scopes = clampUserKeyScopes(v.scopes);
      if (scopes.length === 0) return { kind: "none", skip: false };
      return { kind: "token", tokenId: USER_API_KEY_PREFIX + v.keyId, scopes };
    }
    return v.rateLimited ? { kind: "rate_limited" } : { kind: "none", skip: false };
  }

  if (isApiTokenShaped(presented)) {
    if (await flag(c.env.FLAGS, c.env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled))
      return { kind: "none", skip: false };
    const result = await verifyApiToken(createDb(c.env.DB), presented);
    if (result.ok)
      return {
        kind: "token",
        tokenId: result.tokenId,
        scopes: result.scopes,
        machinePrincipalType: result.principalType,
      };
    return { kind: "none", skip: false };
  }

  // "Sign in with Releases" OAuth JWT access tokens (#1483). Verified locally
  // against the AS JWKS (no prefix — the static root key is never JWT-shaped, so
  // this never shadows the root-key compare below). The `scope` claim is already
  // role-clamped at issuance (entitlement.ts), so the resource server trusts it.
  // A verification failure (bad sig / wrong iss|aud / expired) falls through to
  // `none`, identical to an invalid relk_: 401 on a write/admin route, ignored
  // on a public read.
  if (isJwtShaped(presented)) {
    const verified = await verifyPresentedJwt(c, presented);
    if (verified && verified.scopes.length > 0) {
      return {
        kind: "token",
        tokenId: `oauth_${verified.subject ?? "m2m"}`,
        scopes: verified.scopes,
      };
    }
    return { kind: "none", skip: false };
  }

  const secret = await getSecretWithFallback(c.env.RELEASES_API_KEY, c.env.RELEASED_API_KEY);
  if (!secret) return { kind: "none", skip: true }; // local dev — no secret configured
  if (presented && presented === secret) return { kind: "root", scopes: [ROOT_SCOPE] };
  return { kind: "none", skip: false };
}

/**
 * Resolve the caller's identity for callers that need more than a boolean —
 * the rate limiter keys its per-token bucket on `tokenId`. Returns the `root`
 * or `token` identity for a valid credential, else `null` (anonymous, invalid,
 * disabled-token, or local-dev skip). Single resolution path so `hasValidAuth`
 * and the limiter can't drift.
 */
export async function resolveAuthIdentity(c: Context<Env>): Promise<AuthContext | null> {
  const presented = bearer(c);
  if (!presented) return null;
  const auth = await resolveAuth(c, presented, false);
  return auth.kind === "root" || auth.kind === "token" ? auth : null;
}

/**
 * True iff the request carries ANY valid identity — the static root key or an
 * active DB token of any scope. Used by the rate limiter to exempt known
 * callers. Does NOT imply admin-level access.
 */
export async function hasValidAuth(c: Context<Env>): Promise<boolean> {
  return (await resolveAuthIdentity(c)) !== null;
}

/**
 * True iff the request carries ADMIN-level auth — the static root key or a DB
 * token whose scopes satisfy `admin`. Gates writes elsewhere and unlocks
 * internal fields (e.g. org playbook) on public-read routes. A read/write-only
 * token returns false here so it can't escalate to admin-only content.
 */
export async function isValidBearerAuth(c: Context<Env>): Promise<boolean> {
  const presented = bearer(c);
  if (!presented) return false;
  const auth = await resolveAuth(c, presented, false);
  if (auth.kind === "root") return true;
  if (auth.kind === "token") return scopeSatisfies(auth.scopes, "admin");
  return false;
}

/**
 * True iff the request carries an `X-Releases-Proxy-Key` header matching the
 * configured `RELEASES_PROXY_KEY`. Server-trust signal only — exempts the web
 * frontend's server-to-server traffic from the per-IP rate limit. Does NOT
 * unlock admin-gated content.
 */
export async function isTrustedProxy(c: Context<Env>): Promise<boolean> {
  const header = c.req.header(PROXY_KEY_HEADER);
  if (!header) return false;
  const secret = await getSecret(c.env.RELEASES_PROXY_KEY);
  if (!secret) return false;
  return header === secret;
}

/** Requires `admin` scope (or root) for all requests. 401 if no identity, 403 if under-scoped. */
export const authMiddleware: MiddlewareHandler<Env> = createAuthMiddleware({
  allowPublicReads: false,
  requiredScope: "admin",
});

/**
 * GET/HEAD/OPTIONS pass without auth. POST/PATCH/DELETE require `write` scope
 * (or higher / root).
 */
export const publicReadAuthMiddleware: MiddlewareHandler<Env> = createAuthMiddleware({
  allowPublicReads: true,
  requiredScope: "write",
});

/**
 * Requires any valid identity (`read` scope or higher); anonymous/invalid → 401.
 * Used for self-introspection (`GET /v1/tokens/me`), reachable by a read-only
 * token but not by an anonymous caller.
 */
const requireReadAuthMiddleware: MiddlewareHandler<Env> = createAuthMiddleware({
  allowPublicReads: false,
  requiredScope: "read",
});

/**
 * Exact self-introspection paths. The middleware runs inside the `v1` sub-app,
 * which is mounted at `/v1`, so `c.req.path` is the full `/v1/tokens/me` in
 * production; the bare `/tokens/me` form covers direct-mount unit tests. Exact
 * match (not `endsWith`) so no other path under the `/tokens` namespace can ever
 * reach the read-only gate.
 */
const TOKENS_ME_PATHS = new Set(["/v1/tokens/me", "/tokens/me"]);

/**
 * Auth for the `/v1/tokens` namespace. `GET /v1/tokens/me` is self-introspection
 * (any valid identity, read+); every other token route is admin-only. One
 * wrapper guarantees exactly one auth path runs per request — the generic
 * adminRoutes loop in index.ts would otherwise blanket-admin-gate `/me` too.
 */
export const tokensAuthMiddleware: MiddlewareHandler<Env> = (c, next) => {
  if (c.req.method === "GET" && TOKENS_ME_PATHS.has(c.req.path)) {
    return requireReadAuthMiddleware(c, next);
  }
  return authMiddleware(c, next);
};

/**
 * Low-cardinality route family from a `/v1`-prefixed path (the segment after
 * `v1`, e.g. `/v1/orgs/vercel/releases` → `orgs`). Keeps the consumption
 * `operation` dimension bounded and free of ids — never the raw path.
 */
export function apiRouteFamily(path: string): string {
  const segs = path.split("/").filter(Boolean);
  const i = segs.indexOf("v1");
  const family = i >= 0 ? segs[i + 1] : segs[0];
  return family ?? "root";
}

function apiConsumptionIdentity(
  auth: Extract<ResolvedAuth, { kind: "root" | "token" }>,
): ConsumptionIdentity {
  if (auth.kind === "root") return { kind: "root" };
  return {
    kind: "token",
    tokenId: auth.tokenId,
    machinePrincipalType: auth.machinePrincipalType,
  };
}

async function emitApiConsumption(
  c: Context<Env>,
  auth: Extract<ResolvedAuth, { kind: "root" | "token" }>,
): Promise<void> {
  const payload = await buildConsumptionPayload({
    surface: "api",
    identity: apiConsumptionIdentity(auth),
    operation: `${c.req.method} ${apiRouteFamily(c.req.path)}`,
  });
  logEvent("info", payload);
}

/**
 * Attach the resolved identity to the request context and, for DB tokens,
 * record usage (throttled, fire-and-forget). In tests there's no executionCtx,
 * so fall back to an un-awaited promise.
 */
function recordAuth(
  c: Context<Env>,
  auth: Extract<ResolvedAuth, { kind: "root" | "token" }>,
): void {
  c.set("auth", auth);

  // Consumption telemetry (#1700/#1719): one PII-clean event per AUTHENTICATED API
  // request. `consumerRef` is a hashed stable principal id (#1719); principal is
  // the coarse TYPE. Hashing is async (Web Crypto) — fire-and-forget, same as
  // touchLastUsed. Internal MCP→API introspection on `GET /v1/tokens/me` shows
  // up as operation `GET tokens`; filter it out for pure external-consumer counts.
  const emit = emitApiConsumption(c, auth);
  try {
    c.executionCtx.waitUntil(emit);
  } catch {
    void emit;
  }

  if (auth.kind !== "token") return;
  const tokenId = auth.tokenId;
  // User API keys (relu_) are metered by Better Auth's apikey table, and OAuth
  // JWT principals (oauth_) have no api_tokens row at all; skip the (zero-row)
  // machine-lane last_used UPDATE for both.
  if (isUserApiKeyShaped(tokenId) || tokenId.startsWith(OAUTH_JWT_TOKEN_PREFIX)) return;
  try {
    c.executionCtx.waitUntil(touchLastUsed(createDb(c.env.DB), tokenId).catch(() => undefined));
  } catch {
    // No executionCtx in tests — fire-and-forget without waitUntil.
    touchLastUsed(createDb(c.env.DB), tokenId).catch(() => undefined);
  }
}

/**
 * Resolve the Better Auth cookie session and attach a minimal `{ user }` to the
 * context for downstream handlers; 401 when there's no session. No
 * WWW-Authenticate challenge — this is a cookie-session gate, not a Bearer
 * scheme, and "Cookie" is not a registered RFC 7235 auth scheme. The shared
 * session-resolution path for every signed-in self-serve surface.
 */
const requireSessionBase: MiddlewareHandler<Env> = async (c, next) => {
  const auth = await getOrCreateAuth(c);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user?.id) {
    return respondError(c, new UnauthorizedError("Sign in required"));
  }
  c.set("session", {
    user: { id: session.user.id, email: session.user.email, name: session.user.name },
  });
  await next();
};

/**
 * Wrap `requireSessionBase` behind a feature flag — when the flag is off the
 * surface is dark (404). Reserve this for surfaces that genuinely need a runtime
 * rollout gate; a plain session gate (no flag) is the default for shipped
 * features (see AGENTS.md → feature flags).
 */
function requireSessionWithFlag(
  flagDef: FlagDef,
  envValue: (e: Env["Bindings"]) => string | undefined,
): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (!(await flag(c.env.FLAGS, envValue(c.env), flagDef))) {
      return respondError(c, new NotFoundError("Not found"));
    }
    return requireSessionBase(c, next);
  };
}

/** Self-serve API key surface gate (`/v1/api-keys`) — flag-gated rollout. */
export const requireSession: MiddlewareHandler<Env> = requireSessionWithFlag(
  FLAGS.userApiKeysEnabled,
  (e) => e.USER_API_KEYS_ENABLED,
);

/**
 * Resolve a Bearer credential to the user it belongs to (id only — the follows
 * handlers key on `user.id`). Two user-owned lanes:
 *
 *   • `relu_…` user API keys — the key row carries `userId`; gated by the same
 *     flags as the machine path (`apiTokensDisabled` kill switch +
 *     `userApiKeysEnabled` rollout), and metered/rate-limited by Better Auth's
 *     verify. Unlike the catalog API this is NOT scope-gated: a read-only relu_
 *     key still manages its OWNER'S follows, exactly as that user's cookie
 *     session would — follows are personal account state, not a catalog write.
 *   • "Sign in with Releases" OAuth JWTs — the `sub` claim is the user id.
 *
 * `relk_…` machine tokens and the static root key are NOT user principals (no
 * owning user), so they resolve to `none` here and the caller gets a 401 —
 * follows require a real signed-in user. Email/name are left empty: the
 * `/v1/me/*` handlers only read `user.id`, and neither lane hands us the user's
 * profile without an extra lookup we don't need.
 *
 * Outcomes are a three-way union, NOT `user | null`: a `relu_` key that
 * Better Auth rate-limits resolves to `rate_limited` (distinct from `none`) so
 * the caller can answer 429 instead of 401 — mirroring `createAuthMiddleware`.
 * Every other verify failure stays `none` → 401.
 */
type BearerPrincipal =
  | { kind: "user"; user: AuthSessionContext["user"] }
  | { kind: "rate_limited" }
  | { kind: "none" };

async function resolveBearerUser(c: Context<Env>, presented: string): Promise<BearerPrincipal> {
  if (isUserApiKeyShaped(presented)) {
    if (await flag(c.env.FLAGS, c.env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled))
      return { kind: "none" };
    if (!(await flag(c.env.FLAGS, c.env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled)))
      return { kind: "none" };
    const v = await verifyUserKey(c, presented);
    if (v.ok)
      return v.userId
        ? { kind: "user", user: { id: v.userId, email: "", name: "" } }
        : { kind: "none" };
    // Surface a rate-limited key so the caller can 429; other failures → 401.
    return v.rateLimited ? { kind: "rate_limited" } : { kind: "none" };
  }
  if (isJwtShaped(presented)) {
    const verified = await verifyPresentedJwt(c, presented);
    if (verified?.subject)
      return { kind: "user", user: { id: verified.subject, email: "", name: "" } };
    return { kind: "none" };
  }
  return { kind: "none" };
}

/**
 * User follows + feed gate (`/v1/me/*`) — enabled by default, no flag. Resolves a
 * principal from EITHER a Better Auth session (cookie, or a device-login Bearer
 * session token via the `bearer()` plugin) OR a Bearer user credential (`relu_`
 * key / OAuth JWT) so CLI + MCP callers — which authenticate by Bearer, not a
 * cookie — can manage their follows too. Session is tried first; the Bearer-user
 * lanes are the fallback. 401 when neither resolves.
 */
/** Outcome of resolving a `/v1/me/*`-style user principal (session or Bearer). */
type FollowsPrincipalResolution =
  | { kind: "user"; user: AuthSessionContext["user"] }
  | { kind: "rate_limited" }
  | { kind: "invalid_credential" }
  | { kind: "none" };

async function resolveFollowsPrincipal(c: Context<Env>): Promise<FollowsPrincipalResolution> {
  const auth = await getOrCreateAuth(c);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (session?.user?.id) {
    return {
      kind: "user",
      user: { id: session.user.id, email: session.user.email, name: session.user.name },
    };
  }
  const presented = bearer(c);
  if (presented) {
    const resolved = await resolveBearerUser(c, presented);
    if (resolved.kind === "user") return { kind: "user", user: resolved.user };
    if (resolved.kind === "rate_limited") return { kind: "rate_limited" };
    return { kind: "invalid_credential" };
  }
  return { kind: "none" };
}

export const requireFollowsPrincipal: MiddlewareHandler<Env> = async (c, next) => {
  const resolved = await resolveFollowsPrincipal(c);
  if (resolved.kind === "user") {
    c.set("session", { user: resolved.user });
    return next();
  }
  if (resolved.kind === "rate_limited") {
    // A rate-limited user key answers 429 (not 401), matching the catalog API.
    return respondError(c, new RateLimitedError("API key rate limit exceeded"));
  }
  if (resolved.kind === "invalid_credential") {
    // A credential was presented but mapped to no user — mark it invalid so a
    // Bearer client can tell "wrong/expired token" from "no token".
    c.header("WWW-Authenticate", 'Bearer realm="releases-api", error="invalid_token"');
    return respondError(c, new UnauthorizedError("Invalid credential"));
  }
  return respondError(c, new UnauthorizedError("Sign in required"));
};

/**
 * Soft variant of {@link requireFollowsPrincipal} for namespaces that must
 * stay reachable anonymously at the middleware layer (e.g. `/v1/listing/*`,
 * where the flag-off 404 and the per-IP limiter must fire before any auth
 * check, and unauthenticated is a valid outcome the handler itself reports).
 * Sets `session` when a principal resolves; otherwise a no-op passthrough —
 * NEVER 401s or 429s here. The handler is responsible for gating on
 * `c.get("session")`.
 */
export const attachFollowsSession: MiddlewareHandler<Env> = async (c, next) => {
  const resolved = await resolveFollowsPrincipal(c);
  if (resolved.kind === "user") c.set("session", { user: resolved.user });
  return next();
};

function createAuthMiddleware(opts: {
  allowPublicReads: boolean;
  requiredScope: ApiScope;
}): MiddlewareHandler<Env> {
  return async (c, next) => {
    if (opts.allowPublicReads && SAFE_METHODS.has(c.req.method)) {
      // Public reads never require auth. If a caller does present a valid
      // credential we attach the identity and record usage (this is what lets
      // a read-only token record last_used_at), but an absent or invalid token
      // is ignored — never rejected — so the read stays public.
      const presented = bearer(c);
      if (presented) {
        const auth = await resolveAuth(c, presented, false);
        // Don't record a rate_limited result; leave the read public — an
        // over-limit key on a public GET still reads.
        if (auth.kind === "root" || auth.kind === "token") recordAuth(c, auth);
      }
      await next();
      return;
    }

    const presented = bearer(c);
    const auth = await resolveAuth(c, presented, true);

    if (auth.kind === "rate_limited") {
      return respondError(c, new RateLimitedError("API key rate limit exceeded"));
    }

    if (auth.kind === "none") {
      if (auth.skip) {
        await next();
        return;
      }
      // RFC 7235/6750: 401 carries a WWW-Authenticate challenge so clients
      // (incl. AI agents) can discover the scheme without docs. We distinguish
      // "no credential" from "credential presented but rejected" — the latter
      // adds the standard `error="invalid_token"` parameter. We deliberately do
      // NOT leak *why* a token is invalid (expired vs. revoked vs. wrong value).
      if (presented) {
        c.header("WWW-Authenticate", 'Bearer realm="releases-api", error="invalid_token"');
        return respondError(c, new UnauthorizedError("Invalid API key"));
      }
      c.header("WWW-Authenticate", 'Bearer realm="releases-api"');
      return respondError(c, new UnauthorizedError("Missing API key"));
    }

    if (!scopeSatisfies(auth.scopes, opts.requiredScope)) {
      return respondError(c, new InsufficientScopeError(`Requires '${opts.requiredScope}' scope`));
    }

    recordAuth(c, auth);
    await next();
  };
}
