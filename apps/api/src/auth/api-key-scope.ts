/**
 * Pure shim between the Releases scope ladder (`read ⊂ write ⊂ admin`) and the
 * Better Auth API-key permission model (a flat `resource → actions` map checked
 * for all-present membership). We encode the ladder as CUMULATIVE actions on one
 * `api` resource, so the stored array is itself a valid `scopes` array for
 * `scopeSatisfies`. Worker-local on purpose — keeps the BA-permission shape out
 * of the runtime-neutral, OSS-shared `core` package.
 */
import { type ApiScope, isApiScope } from "@buildinternet/releases-core/api-token";

/** The single permission resource the scope ladder maps onto. */
export const API_PERMISSION_RESOURCE = "api";

const LADDER: Record<ApiScope, string[]> = {
  read: ["read"],
  write: ["read", "write"],
  admin: ["read", "write", "admin"],
};

/** Expand a ladder scope to cumulative permissions. Used at key creation. */
export function scopeToPermissions(scope: ApiScope): Record<string, string[]> {
  return { [API_PERMISSION_RESOURCE]: [...LADDER[scope]] };
}

/**
 * Policy ceiling for self-serve user (`relu_`) keys: read-only. The ladder above
 * still supports write/admin for machine (`relk_`) tokens and the static root
 * key; user keys are clamped to this ceiling at BOTH the mint route
 * (`routes/user-api-keys.ts`) and the auth resolver (`middleware/auth.ts`), so
 * write is unreachable for the user lane even if a write-permissioned `relu_`
 * key exists or is granted out-of-band.
 */
export const USER_API_KEY_MAX_SCOPE: ApiScope = "read";

/**
 * Cumulative permission actions allowed at the user-key ceiling. The ceiling is
 * a module constant, so this set never changes — built once and reused by both
 * the mint admission check (`isWithinUserKeyCeiling`) and the per-request auth
 * clamp (`clampUserKeyScopes`), which keeps those two layers consistent.
 */
const USER_KEY_CEILING_ACTIONS = new Set(LADDER[USER_API_KEY_MAX_SCOPE]);

/**
 * True iff `scope` is a ladder scope at or below the user-key ceiling — i.e.
 * every action it would grant is permitted by the ceiling. The mint route uses
 * this to admit a requested scope. Treats USER_API_KEY_MAX_SCOPE as a `≤ ceiling`
 * bound (not exact-match), so raising the ceiling keeps lower scopes mintable.
 */
export function isWithinUserKeyCeiling(scope: unknown): scope is ApiScope {
  return (
    typeof scope === "string" &&
    isApiScope(scope) &&
    LADDER[scope].every((a) => USER_KEY_CEILING_ACTIONS.has(a))
  );
}

/**
 * Clamp a verified user-key's scopes to the user-key ceiling — keep only the
 * held actions the ceiling permits. For the read ceiling that's `["read"]` when
 * the key carries read (every minted user key does, since the ladder is
 * cumulative), else `[]` so the caller denies. An empty-scope identity must
 * never authenticate.
 */
export function clampUserKeyScopes(scopes: string[]): string[] {
  return scopes.filter((s) => USER_KEY_CEILING_ACTIONS.has(s));
}

/**
 * Read a verified key's permissions back into a scopes array. Defensive: a
 * missing map, a non-`api` resource, or a non-array yields `[]` so the caller
 * denies (an empty-scope identity must never authenticate).
 */
export function apiScopesFromPermissions(
  permissions: Record<string, string[]> | null | undefined,
): string[] {
  const actions = permissions?.[API_PERMISSION_RESOURCE];
  return Array.isArray(actions) ? actions.filter((a): a is string => typeof a === "string") : [];
}
