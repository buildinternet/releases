/**
 * Locks the oauth-provider plugin's user self-service *write* client endpoints
 * to admins (#1482). The plugin auto-mounts these session-gated endpoints over
 * HTTP, letting any logged-in user mint OAuth clients; this keeps the AS
 * fail-closed / first-party-only by routing all provisioning through the
 * root-key admin route. Read/public endpoints (public-client(-prelogin),
 * get-client(s)) are intentionally NOT guarded — the consent flow reads them.
 * Register on the four write paths in index.ts BEFORE the /api/auth/* handler.
 */
import type { MiddlewareHandler } from "hono";
import { ForbiddenError } from "@releases/lib/releases-error";
import { getOrCreateAuth } from "../middleware/auth.js";
import { respondError } from "../lib/error-response.js";
import type { Env } from "../index.js";

/**
 * The oauth-provider plugin's user self-service *write* client endpoints —
 * the surface this guard locks to admins. Register the guard on exactly these
 * in index.ts. Read/public endpoints are intentionally excluded.
 */
export const OAUTH_SELF_SERVICE_WRITE_PATHS = [
  "/api/auth/oauth2/create-client",
  "/api/auth/oauth2/update-client",
  "/api/auth/oauth2/delete-client",
  "/api/auth/oauth2/client/rotate-secret",
] as const;

export function oauthSelfServiceGuard(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const auth = await getOrCreateAuth(c);
    let role: string | null | undefined;
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      role = (session?.user as { role?: string | null } | undefined)?.role;
    } catch {
      role = undefined; // fail closed on any session-resolution error
    }
    if (role !== "admin") {
      // Standardized `forbidden` envelope. The former one-off `error:
      // "oauth_self_service_admin_only"` discriminant is preserved in
      // `details.reason` rather than promoted into ERROR_CODES — this guard is a
      // first-party admin surface, not a code a public client branches on.
      return respondError(
        c,
        new ForbiddenError("OAuth client self-service is restricted to admins", {
          details: { reason: "oauth_self_service_admin_only" },
        }),
      );
    }
    return next();
  };
}
