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
import { createAuth } from "./index.js";
import { execWaitUntil } from "../middleware/auth.js";
import type { Env } from "../index.js";

export function oauthSelfServiceGuard(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const auth = c.get("betterAuth") ?? (await createAuth(c.env, execWaitUntil(c)));
    let role: string | null | undefined;
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      role = (session?.user as { role?: string | null } | undefined)?.role;
    } catch {
      role = undefined; // fail closed on any session-resolution error
    }
    if (role !== "admin") {
      return c.json({ error: "oauth_self_service_admin_only" }, 403);
    }
    return next();
  };
}
