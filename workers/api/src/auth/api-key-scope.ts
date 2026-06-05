/**
 * Pure shim between the Releases scope ladder (`read ⊂ write ⊂ admin`) and the
 * Better Auth API-key permission model (a flat `resource → actions` map checked
 * for all-present membership). We encode the ladder as CUMULATIVE actions on one
 * `api` resource, so the stored array is itself a valid `scopes` array for
 * `scopeSatisfies`. Worker-local on purpose — keeps the BA-permission shape out
 * of the runtime-neutral, OSS-shared `core` package.
 */
import { type ApiScope } from "@buildinternet/releases-core/api-token";

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
