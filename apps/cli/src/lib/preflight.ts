import { resolveCredential } from "./mode.js";

const SCOPE_RANK: Record<string, number> = { read: 1, write: 2, admin: 3 };

// Inlined rather than imported from @buildinternet/releases-core/api-token because the CLI's pinned core@0.22.0 predates that export.
/**
 * True if the held scopes satisfy the required scope level. The wildcard `*`
 * grants everything; otherwise any held scope of equal-or-higher rank satisfies
 * the requirement (admin ⊇ write ⊇ read).
 */
function scopeSatisfies(tokenScopes: string[], required: string): boolean {
  if (tokenScopes.includes("*")) return true;
  const reqRank = SCOPE_RANK[required] ?? Number.POSITIVE_INFINITY;
  return tokenScopes.some((s) => (SCOPE_RANK[s] ?? 0) >= reqRank);
}

/**
 * Coarse pre-flight check for the admin subtree. Returns a warning string when a
 * file-sourced token's cached scopes don't satisfy `write` (so an admin command
 * is likely to 403), or null. Env-sourced tokens have unknown scopes → no
 * warning; the server stays authoritative either way.
 */
export function preflightScopeWarning(): string | null {
  const cred = resolveCredential();
  if (cred.source === "file" && cred.scopes && !scopeSatisfies(cred.scopes, "write")) {
    return `Your stored token's scopes (${cred.scopes.join(", ")}) may not cover this command. Trying anyway…`;
  }
  return null;
}
