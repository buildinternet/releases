/**
 * Bearer auth for first-party backend callers of web's internal endpoints —
 * today that means the API worker, on the API-worker → web direction.
 *
 * This is the mirror image of `RELEASES_PROXY_KEY`, which authenticates web →
 * API. It is a **channel** credential, not a per-feature one: any future
 * internal endpoint the worker needs (cache busting, warmup, invalidation of a
 * new surface) reuses this rather than minting its own secret. One credential
 * per trust boundary, not one per use case — a pile of feature-specific secrets
 * is real operational cost and nobody ever rotates them.
 *
 * Deliberately NOT the root `RELEASES_API_KEY`. That key is admin over the
 * whole API; accepting it here would mean a leak escalates from "someone can
 * bust caches" to "someone is API root". Scope the credential to one trust
 * boundary — just not to one endpoint.
 *
 * The corollary: everything behind this key shares a blast radius. Adding an
 * endpoint that can do materially more damage than cache invalidation is a
 * reason to revisit the boundary, not to quietly widen this one.
 */

export type ServiceAuthResult =
  | { ok: true }
  | { ok: false; reason: "not_configured" | "unauthorized" };

const BEARER = "Bearer ";

/** Length-checked constant-time compare, so a wrong token leaks no timing signal. */
function matches(provided: string, expected: string): boolean {
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) {
    diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return diff === 0;
}

export function verifyServiceKey(req: Request, key: string | undefined): ServiceAuthResult {
  // Fail closed: an unconfigured key must never degrade to an open endpoint.
  if (!key) return { ok: false, reason: "not_configured" };

  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith(BEARER)) return { ok: false, reason: "unauthorized" };

  const token = header.slice(BEARER.length);
  if (!token || !matches(token, key)) return { ok: false, reason: "unauthorized" };

  return { ok: true };
}
