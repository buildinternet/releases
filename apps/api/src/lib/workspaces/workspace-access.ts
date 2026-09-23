import { and, eq } from "drizzle-orm";
import { authMember, authOrganization } from "../../db/schema-auth.js";
import type { createDb } from "../../db.js";
import { ForbiddenError, NotFoundError, type ReleasesError } from "@releases/lib/releases-error";

const MANAGER_ROLES = new Set(["owner", "admin"]);

export async function requireWorkspaceMember(
  db: ReturnType<typeof createDb>,
  userId: string,
  workspaceId: string,
): Promise<{ ok: true; role: string } | { ok: false; status: 404 }> {
  const [row] = await db
    .select({ role: authMember.role })
    .from(authMember)
    .innerJoin(authOrganization, eq(authMember.organizationId, authOrganization.id))
    .where(and(eq(authMember.organizationId, workspaceId), eq(authMember.userId, userId)))
    .limit(1);
  if (!row) return { ok: false, status: 404 };
  return { ok: true, role: row.role ?? "member" };
}

export async function requireWorkspaceManager(
  db: ReturnType<typeof createDb>,
  userId: string,
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; status: 403 | 404 }> {
  const member = await requireWorkspaceMember(db, userId, workspaceId);
  if (!member.ok) return member;
  if (!MANAGER_ROLES.has(member.role)) return { ok: false, status: 403 };
  return { ok: true };
}

export function workspaceGateError(gate: { ok: false; status: 403 | 404 }): ReleasesError {
  return gate.status === 403
    ? new ForbiddenError("Owner or admin required")
    : new NotFoundError("Workspace not found");
}
