/**
 * Origin guard for `GET /api/auth/token`, the jwt() plugin endpoint that turns
 * a cookie session into a role-clamped JWT (an admin's carries `admin` scope).
 *
 * The only first-party caller is the web server (`apps/web/src/lib/admin-action.ts`),
 * which forwards the cookie server-side and sends no `Origin`. The worker-wide
 * CORS layer reflects credentials to every `https://*.releases.sh` host, so a
 * script on any sibling subdomain could otherwise read a victim's JWT. A
 * browser request is refused unless it comes from the exact web origin, the
 * same rule the publish-token mint uses (#2373). Register in index.ts BEFORE
 * the `/api/auth/*` handler.
 */
import type { MiddlewareHandler } from "hono";
import { logEvent } from "@releases/lib/log-event";
import { ForbiddenError } from "@releases/lib/releases-error";
import { respondError } from "../lib/error-response.js";
import { isExactWebOrigin } from "./index.js";
import type { Env } from "../index.js";

export const SESSION_JWT_PATH = "/api/auth/token";

export function sessionJwtOriginGuard(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    if (origin !== undefined && !isExactWebOrigin(origin, c.env)) {
      logEvent("warn", { component: "auth", event: "session-jwt-origin-refused", origin });
      return respondError(c, new ForbiddenError("Origin not allowed"));
    }
    await next();
  };
}
