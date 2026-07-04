import type { MiddlewareHandler } from "hono";
import { getSecret } from "@releases/lib/secrets";
import { UnauthorizedError } from "@releases/lib/releases-error";
import { respondError } from "../lib/error-response.js";

/** Custom header carrying the staging shared secret. */
export const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

/**
 * Paths the staging gate must never block, even when `STAGING_ACCESS_KEY` is
 * bound. JWKS is public key material (prod serves it openly) fetched
 * server-to-server: a resource server verifying a "Sign in with Releases" OAuth
 * JWT (#1483) resolves `${issuer}/api/auth/jwks`, and that outbound fetch can't
 * carry the staging key. Gating it would break OAuth JWT verification on staging
 * while protecting nothing (the keys are public by design). See AGENTS.md → Staging.
 */
const STAGING_GATE_EXEMPT_PATHS = new Set<string>(["/api/auth/jwks"]);

/** True for a path the staging access gate leaves open (public, secret-free). */
export function isStagingGateExemptPath(pathname: string): boolean {
  return STAGING_GATE_EXEMPT_PATHS.has(pathname);
}

/**
 * Interim access gate for the staging hostname. When `STAGING_ACCESS_KEY` is
 * bound (only in `[env.staging]`), every request must carry a matching
 * `X-Releases-Staging-Key` header or receive a 401, except for
 * `STAGING_GATE_EXEMPT_PATHS` (public, secret-free endpoints). CORS preflight is
 * handled earlier by `cors()`, so OPTIONS never reaches this middleware.
 *
 * Holdover until Cloudflare Access is in front of `*-staging.releases.sh`
 * (see issue #444). Skipping the binding in prod/local leaves behavior unchanged.
 */
export function stagingAccessGate(): MiddlewareHandler<{
  Bindings: { STAGING_ACCESS_KEY?: { get(): Promise<string> } };
}> {
  return async (c, next) => {
    if (!c.env.STAGING_ACCESS_KEY) {
      await next();
      return;
    }
    // Let public, secret-free paths (JWKS) through before touching the secret so
    // server-to-server OAuth JWT verification works on staging.
    if (isStagingGateExemptPath(new URL(c.req.url).pathname)) {
      await next();
      return;
    }
    const secret = await getSecret(c.env.STAGING_ACCESS_KEY);
    if (!secret) {
      await next();
      return;
    }
    if (c.req.header(STAGING_KEY_HEADER) !== secret) {
      return respondError(c, new UnauthorizedError("Missing or invalid staging access key"));
    }
    await next();
  };
}
