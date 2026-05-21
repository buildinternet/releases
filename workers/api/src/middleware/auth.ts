import type { Context, MiddlewareHandler } from "hono";
import { getSecret } from "@releases/lib/secrets";
import {
  type ApiScope,
  isApiTokenShaped,
  ROOT_SCOPE,
  scopeSatisfies,
} from "@buildinternet/releases-core/api-token";
import { createDb } from "../db.js";
import { touchLastUsed, verifyApiToken } from "./token-store.js";
import type { Env } from "../index.js";

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
  // skip=true means "local dev, no secret configured" — preserve open access.
  | { kind: "none"; skip: boolean };

function bearer(c: Context<Env>): string {
  const header = c.req.header("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Resolve a presented credential to an identity. `relk_…` tokens go to the DB
 * path only; everything else compares to the static RELEASED_API_KEY (root).
 * No credential is eligible for both paths.
 */
async function resolveAuth(c: Context<Env>, presented: string): Promise<ResolvedAuth> {
  if (isApiTokenShaped(presented)) {
    if (c.env.API_TOKENS_DISABLED === "true") return { kind: "none", skip: false };
    const result = await verifyApiToken(createDb(c.env.DB), presented);
    if (result.ok) return { kind: "token", tokenId: result.tokenId, scopes: result.scopes };
    return { kind: "none", skip: false };
  }

  const secret = await getSecret(c.env.RELEASED_API_KEY);
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
  const auth = await resolveAuth(c, presented);
  return auth.kind === "none" ? null : auth;
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
  const auth = await resolveAuth(c, presented);
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
        const auth = await resolveAuth(c, presented);
        if (auth.kind !== "none") recordAuth(c, auth);
      }
      await next();
      return;
    }

    const auth = await resolveAuth(c, bearer(c));

    if (auth.kind === "none") {
      if (auth.skip) {
        await next();
        return;
      }
      // RFC 7235: 401 carries a WWW-Authenticate challenge so clients (incl.
      // AI agents) can discover the scheme without docs.
      c.header("WWW-Authenticate", 'Bearer realm="releases-api"');
      return c.json({ error: "unauthorized", message: "Invalid or missing API key" }, 401);
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
