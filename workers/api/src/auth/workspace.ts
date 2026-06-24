/**
 * Better Auth organization plugin — user-tenancy "Workspaces". NOT the registry
 * `organizations` table (@buildinternet/releases-core), which is the indexed vendors.
 *
 * Personal-workspace provisioning + the Stripe org-billing authorization gate.
 */

/** A human-friendly default name for a user's personal workspace. Pure. */
export function deriveWorkspaceName(
  input: { name?: string | null; email?: string | null } | null,
): string {
  const name = input?.name?.trim();
  if (name) {
    const first = name.split(/\s+/)[0];
    if (first) return `${first}'s Workspace`;
  }
  const local = input?.email?.split("@")[0]?.trim();
  if (local) return `${local}'s Workspace`;
  return "Personal Workspace";
}

/**
 * Deterministic slug for a user's personal workspace, namespaced by user id so two
 * concurrent first-logins for the same user collide on the org table's UNIQUE(slug)
 * and the loser adopts the winner's row (see ensureActiveWorkspace). Pure.
 */
export function personalWorkspaceSlug(userId: string): string {
  return `ws-${userId}`;
}
