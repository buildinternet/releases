/**
 * Per-user OAuth scope entitlement. A plain scope map keyed by the Better Auth
 * `admin`-plugin `role` — NOT the access-control (`createAccessControl`) system,
 * which governs admin-plugin endpoints, not OAuth scopes. This module is the
 * single security boundary for "which scopes may this user consent to / hold":
 * the consent gate (`hooks.before`) and the token-issuance backstop
 * (`customAccessTokenClaims`) both route through it. Pure + dependency-free so it
 * is exhaustively unit-testable. Fail-closed: an unknown/missing role → read-only.
 * A web-display mirror lives in web/src/lib/entitlement.ts — keep them in sync.
 */

/** Identity scopes everyone who signs in may grant. */
export const IDENTITY_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/** API scope ladder per role. Cumulative (read ⊂ write ⊂ admin). */
export const ROLE_LADDER: Readonly<Record<string, readonly string[]>> = {
  user: ["read"],
  curator: ["read", "write"],
  admin: ["read", "write", "admin"],
};

/** Scopes a user with `role` may consent to / hold. Unknown/null → read-only (fail-closed). */
export function entitledScopes(role: string | null | undefined): string[] {
  // `role` may be a comma-separated multi-role string (admin-plugin convention).
  const roles = (role || "user")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const ladder = new Set<string>();
  for (const r of roles) for (const s of ROLE_LADDER[r] ?? ROLE_LADDER.user) ladder.add(s);
  if (ladder.size === 0) for (const s of ROLE_LADDER.user) ladder.add(s); // unreachable belt-and-suspenders (role || "user" guarantees ≥1 known role)
  return [...IDENTITY_SCOPES, ...ladder];
}

/** Throws if any requested scope exceeds the role's entitlement. */
export function assertScopesEntitled(role: string | null | undefined, requested: string[]): void {
  const allowed = new Set(entitledScopes(role));
  const forbidden = requested.filter((s) => !allowed.has(s));
  if (forbidden.length) {
    throw new Error(`scopes not entitled for role ${role ?? "user"}: ${forbidden.join(", ")}`);
  }
}

/**
 * `oauthProvider.customAccessTokenClaims` body. Runs at every JWT access-token
 * issuance (authorization_code, refresh_token re-issue, client_credentials) and
 * introspection. For a user-bound token it re-asserts the live entitlement
 * ceiling — covering skip_consent clients, refresh replay, and role downgrades —
 * and stamps the role claim. `user === undefined` means M2M (client_credentials),
 * where no per-user ceiling applies → skip. `user === null` means a deleted user
 * → falls through to the read-only ceiling (fail-closed).
 */
export function oauthAccessTokenClaims(info: {
  user?: { role?: string | null } | null;
  scopes?: string[];
}): Record<string, string> {
  const { user, scopes } = info;
  if (user !== undefined) assertScopesEntitled(user?.role, scopes ?? []);
  return user ? { "https://releases.sh/role": user.role ?? "user" } : {};
}

/**
 * True when a `/oauth2/consent` submission grants scopes beyond the user's
 * entitlement. Best-effort early gate: a deny (`accept !== true`) or an omitted
 * `scope` (the plugin then grants all originally-requested scopes) returns false
 * — the token-issuance backstop above is the authoritative guarantee.
 */
export function consentScopeViolation(
  role: string | null | undefined,
  body: { accept?: unknown; scope?: unknown } | undefined,
): boolean {
  if (!body || body.accept !== true) return false;
  const scope = typeof body.scope === "string" ? body.scope : "";
  if (!scope) return false;
  const requested = scope.split(/\s+/).filter(Boolean);
  try {
    assertScopesEntitled(role, requested);
    return false;
  } catch {
    return true;
  }
}
