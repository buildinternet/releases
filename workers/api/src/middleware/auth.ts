import type { Context, MiddlewareHandler } from "hono";
import { FLAGS, flag } from "@releases/lib/flags";
import { getSecret, getSecretWithFallback } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import {
  type ApiScope,
  isApiTokenShaped,
  isUserApiKeyShaped,
  ROOT_SCOPE,
  scopeSatisfies,
  USER_API_KEY_PREFIX,
} from "@buildinternet/releases-core/api-token";
import { createDb } from "../db.js";
import { touchLastUsed, verifyApiToken } from "./token-store.js";
import type { Env } from "../index.js";
import { createAuth } from "../auth/index.js";
import { apiScopesFromPermissions } from "../auth/api-key-scope.js";

export const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Custom header carrying the trusted-proxy shared secret. */
export const PROXY_KEY_HEADER = "X-Releases-Proxy-Key";

/** Resolved identity attached to the Hono context for downstream handlers. */
export type AuthContext =
  | { kind: "root"; scopes: string[] }
  | { kind: "token"; tokenId: string; scopes: string[] };

type ResolvedAuth =
  | { kind: "root"; scopes: string[] }
  | { kind: "token"; tokenId: string; scopes: string[] }
  | { kind: "rate_limited" }
  // skip=true means "local dev, no secret configured" — preserve open access.
  | { kind: "none"; skip: boolean };

function bearer(c: Context<Env>): string {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
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
): Promise<{ ok: true; scopes: string[]; keyId: string } | { ok: false; rateLimited: boolean }> {
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }
  try {
    const auth = await createAuth(c.env, waitUntil);
    // apiKey() is registered conditionally (flag-gated), so betterAuth's inferred
    // `api` type doesn't statically expose verifyApiKey. We only reach here when the
    // flag is on (checked in resolveAuthUncached), so the endpoint is mounted; assert
    // its shape with a precise (non-any) structural cast.
    const verifyApiKey = (
      auth.api as {
        verifyApiKey?: (a: { body: { key: string } }) => Promise<{
          valid: boolean;
          error?: { code?: string | null } | null;
          key?: { id?: string; permissions?: Record<string, string[]> | null } | null;
        }>;
      }
    ).verifyApiKey;
    if (!verifyApiKey) return { ok: false, rateLimited: false };
    const result = await verifyApiKey({ body: { key: presented } });
    if (result.valid && result.key) {
      const scopes = apiScopesFromPermissions(result.key.permissions);
      if (scopes.length > 0)
        return { ok: true, scopes, keyId: result.key.id ?? presented.slice(0, 12) };
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
    if (v.ok) return { kind: "token", tokenId: USER_API_KEY_PREFIX + v.keyId, scopes: v.scopes };
    return v.rateLimited ? { kind: "rate_limited" } : { kind: "none", skip: false };
  }

  if (isApiTokenShaped(presented)) {
    if (await flag(c.env.FLAGS, c.env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled))
      return { kind: "none", skip: false };
    const result = await verifyApiToken(createDb(c.env.DB), presented);
    if (result.ok) return { kind: "token", tokenId: result.tokenId, scopes: result.scopes };
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
 * Attach the resolved identity to the request context and, for DB tokens,
 * record usage (throttled, fire-and-forget). In tests there's no executionCtx,
 * so fall back to an un-awaited promise.
 */
function recordAuth(
  c: Context<Env>,
  auth: Extract<ResolvedAuth, { kind: "root" | "token" }>,
): void {
  c.set("auth", auth);
  if (auth.kind !== "token") return;
  const tokenId = auth.tokenId;
  // User API keys (relu_) are metered by Better Auth's apikey table, not the
  // api_tokens last_used path; skip the (zero-row) machine-lane UPDATE for them.
  if (isUserApiKeyShaped(tokenId)) return;
  try {
    c.executionCtx.waitUntil(touchLastUsed(createDb(c.env.DB), tokenId).catch(() => undefined));
  } catch {
    // No executionCtx in tests — fire-and-forget without waitUntil.
    touchLastUsed(createDb(c.env.DB), tokenId).catch(() => undefined);
  }
}

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
      return c.json({ error: "rate_limited", message: "API key rate limit exceeded" }, 429);
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
        return c.json({ error: "unauthorized", message: "Invalid API key" }, 401);
      }
      c.header("WWW-Authenticate", 'Bearer realm="releases-api"');
      return c.json({ error: "unauthorized", message: "Missing API key" }, 401);
    }

    if (!scopeSatisfies(auth.scopes, opts.requiredScope)) {
      return c.json(
        { error: "insufficient_scope", message: `Requires '${opts.requiredScope}' scope` },
        403,
      );
    }

    recordAuth(c, auth);
    await next();
  };
}
