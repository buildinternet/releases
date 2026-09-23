import { Hono } from "hono";

type Env = { Bindings: { DB: D1Database } };

/**
 * GET /health — liveness + cheap D1 readiness probe for uptime monitoring
 * (status.releases.sh). A single `SELECT 1` confirms the worker is up and D1
 * is reachable — far cheaper than pointing a monitor at a full read endpoint
 * like /v1/releases/latest. Returns 503 when D1 is unreachable so a plain
 * status-check monitor goes red on database failure with no keyword needed.
 *
 * Mounted at the top level (outside /v1) so it skips the per-route public-read
 * auth + rate-limit middleware. Always carries `X-Robots-Tag: noindex`.
 */
export const healthRoutes = new Hono<Env>();

healthRoutes.get("/health", async (c) => {
  c.header("X-Robots-Tag", "noindex, nofollow");
  c.header("Cache-Control", "no-store");
  try {
    await c.env.DB.prepare("SELECT 1").first();
    return c.json({ ok: true, service: "releases-api", db: "ok" });
  } catch {
    return c.json({ ok: false, service: "releases-api", db: "error" }, 503);
  }
});
