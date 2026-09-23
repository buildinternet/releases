import { eq } from "drizzle-orm";
import type { AnyDb } from "../db.js";
import { authMember, authOrganization, user } from "../db/schema-auth.js";

/** One workspace membership row for `GET /v1/me/workspaces`. */
export interface MemberWorkspaceRow {
  id: string;
  name: string;
  slug: string;
  logo: string | null;
  role: string;
  createdAt: Date;
}

/**
 * List every workspace the caller belongs to, ordered by name. One query:
 * `member` joined to `organization`, filtered to the caller's user id.
 */
export async function listMemberWorkspaces(
  db: AnyDb,
  userId: string,
): Promise<MemberWorkspaceRow[]> {
  const rows = await db
    .select({
      id: authOrganization.id,
      name: authOrganization.name,
      slug: authOrganization.slug,
      logo: authOrganization.logo,
      role: authMember.role,
      createdAt: authOrganization.createdAt,
    })
    .from(authMember)
    .innerJoin(authOrganization, eq(authMember.organizationId, authOrganization.id))
    .where(eq(authMember.userId, userId))
    .orderBy(authOrganization.name);
  return rows;
}

/**
 * The caller's active workspace id, or null. Backed by `user.lastActiveOrganizationId`,
 * which the Better Auth session hooks (auth/index.ts) keep in sync with the live
 * session's `activeOrganizationId` on BOTH session create (first sign-in / new device)
 * and session update (an explicit workspace switch via the org plugin's `setActive`
 * endpoint) — so this column reflects the current active workspace without a second
 * `getSession()` call, and it works for Bearer principals (`relu_` key / OAuth JWT)
 * too, which have no session row to read `activeOrganizationId` from at all.
 */
export async function getActiveWorkspaceId(db: AnyDb, userId: string): Promise<string | null> {
  const rows = await db
    .select({ lastActive: user.lastActiveOrganizationId })
    .from(user)
    .where(eq(user.id, userId))
    .limit(1);
  return rows[0]?.lastActive ?? null;
}
