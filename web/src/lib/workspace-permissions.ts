// web/src/lib/workspace-permissions.ts
/**
 * Pure role helpers for the Workspaces (Better Auth organization) UI. `role` here is the
 * workspace membership role (owner/admin/member), NOT the Better Auth `user.role` that
 * drives the OAuth scope ceiling. See docs/architecture/workspaces.md.
 */
export type WorkspaceRole = "owner" | "admin" | "member";

const MANAGER_ROLES = new Set<string>(["owner", "admin"]);

/** Owners and admins can manage members + invitations. */
export function isManager(role: string | null | undefined): boolean {
  return role != null && MANAGER_ROLES.has(role);
}

/**
 * The role a member/admin would be toggled to in the one-click role switch. Owners are
 * not toggled in v1 (no ownership transfer) → null; unknown roles → null.
 */
export function roleToggleTarget(role: string): WorkspaceRole | null {
  if (role === "member") return "admin";
  if (role === "admin") return "member";
  return null;
}

/**
 * Whether the viewer may remove / change the role of a given member row. Managers may act
 * on non-owner members other than themselves. The viewer's own row uses "Leave"; owners
 * are not managed in v1. Better Auth's structural guards (sole owner, etc.) still apply
 * server-side and surface as inline errors.
 */
export function canActOnMember(
  viewerRole: string | null | undefined,
  targetRole: string,
  isSelf: boolean,
): boolean {
  return isManager(viewerRole) && !isSelf && targetRole !== "owner";
}
