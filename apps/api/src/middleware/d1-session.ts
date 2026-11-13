import type { MiddlewareHandler } from "hono";
import { openD1Session, parseD1Bookmark, type D1SessionConstraint } from "@releases/lib/db";

/** Request/response header carrying a D1 Sessions API bookmark. */
export const D1_BOOKMARK_HEADER = "x-d1-bookmark";

/**
 * Path prefixes that always stay on the primary, even for a credential-less
 * GET: auth flows read right after their own writes, and `/v1/me` / `/v1/admin`
 * are signed-in surfaces anyway.
 */
const PRIMARY_ONLY_PREFIXES = ["/api/auth", "/oauth2", "/v1/me", "/v1/admin"];

/**
 * Decide whether a request may read from a D1 replica, and from what start.
 * Returns `null` when it must stay on the primary (the plain binding).
 *
 * Replica-eligible = an anonymous read: GET/HEAD with no Authorization, no
 * cookie, no web proxy key, outside the primary-only prefixes. Everything else
 * keeps today's behavior. Kept deliberately conservative:
 * - writes and their follow-up reads stay sequential on the primary;
 * - authenticated reads must see a just-revoked token / just-changed role;
 * - the web frontend (proxy key) stays on the primary so an ingest-triggered
 *   ISR revalidation never re-renders from a lagging replica and pins stale
 *   content until the next revalidate.
 *
 * A valid inbound `x-d1-bookmark` replaces the unconstrained start, so a client
 * that just wrote can read its own write from a replica.
 */
export function chooseD1SessionConstraint(req: Request): D1SessionConstraint | null {
  if (req.method !== "GET" && req.method !== "HEAD") return null;
  const h = req.headers;
  if (h.has("authorization") || h.has("cookie") || h.has("x-releases-proxy-key")) return null;
  const { pathname } = new URL(req.url);
  if (PRIMARY_ONLY_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return null;
  }
  return parseD1Bookmark(h.get(D1_BOOKMARK_HEADER)) ?? "first-unconstrained";
}

/**
 * Opt anonymous reads into D1 read replication via the Sessions API.
 *
 * For a replica-eligible request (see {@link chooseD1SessionConstraint}) this
 * swaps `c.env.DB` for a session handle on a per-request copy of `env`, so the
 * ~300 `createDb(c.env.DB)` call sites need no change. Any write the handler
 * makes still goes to the primary, and the session stays sequentially
 * consistent. The session's latest bookmark is returned in `x-d1-bookmark`.
 *
 * A no-op when the binding has no `withSession` (test shims) and, in effect,
 * when replication is disabled on the database — sessions then always hit the
 * primary. Disabling replication in the dashboard is the kill switch.
 */
export function d1ReadSession(): MiddlewareHandler<{ Bindings: { DB: D1Database } }> {
  return async (c, next) => {
    const constraint = chooseD1SessionConstraint(c.req.raw);
    const session = constraint ? openD1Session(c.env.DB, constraint) : null;
    if (!session) return next();

    c.env = { ...c.env, DB: session as unknown as D1Database };
    await next();

    if (c.res.status === 101) return;
    const bookmark = session.getBookmark();
    if (!bookmark) return;
    try {
      c.res.headers.set(D1_BOOKMARK_HEADER, bookmark);
    } catch {
      // Immutable headers (e.g. a Response served straight from a cache) — the
      // bookmark is advisory, so skip it rather than fail the request.
    }
  };
}
