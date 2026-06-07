/**
 * Display-only mirror of the API worker's scope entitlement
 * (workers/api/src/auth/entitlement.ts). Used by the consent page to show only
 * the scopes the signed-in user may grant. NOT a security boundary — the API
 * gates (consent hook + token backstop) are authoritative; this just avoids
 * offering a scope the AS will refuse. Keep ROLE_LADDER/IDENTITY_SCOPES in sync
 * with the worker copy (both are tiny constants; the web app is a separate build
 * and cannot import the worker module).
 */
export const IDENTITY_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

export const ROLE_LADDER: Readonly<Record<string, readonly string[]>> = {
  user: ["read"],
  curator: ["read", "write"],
  admin: ["read", "write", "admin"],
};

/** Human-readable labels for the consent screen. */
export const SCOPE_LABELS: Record<string, { title: string; desc: string }> = {
  openid: { title: "Verify your identity", desc: "Confirm who you are." },
  profile: { title: "Basic profile", desc: "Your name and avatar." },
  email: { title: "Email address", desc: "Your account email." },
  offline_access: {
    title: "Stay connected",
    desc: "Keep access when you're away (refresh tokens).",
  },
  read: { title: "Read catalog data", desc: "View organizations, sources, and releases." },
  write: { title: "Manage catalog data", desc: "Create and edit catalog entries on your behalf." },
  admin: { title: "Full admin access", desc: "Administrative operations on your behalf." },
};

export function entitledScopes(role: string | null | undefined): string[] {
  // `role` may be a comma-separated multi-role string (admin-plugin convention).
  const roles = (role || "user")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const ladder = new Set<string>();
  for (const r of roles) for (const s of ROLE_LADDER[r] ?? ROLE_LADDER.user) ladder.add(s);
  // Fail closed to user/read when `role` is truthy but empties after filter
  // (whitespace- or comma-only, e.g. " " or ","), which `role || "user"` doesn't catch.
  if (ladder.size === 0) for (const s of ROLE_LADDER.user) ladder.add(s);
  return [...IDENTITY_SCOPES, ...ladder];
}

/** Requested scopes intersected with what `role` may grant (preserves request order). */
export function displayScopes(role: string | null | undefined, requested: string[]): string[] {
  const allowed = new Set(entitledScopes(role));
  return requested.filter((s) => allowed.has(s));
}
