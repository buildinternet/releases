/**
 * Better Auth organization plugin — user-tenancy "Workspaces". NOT the registry
 * `organizations` table (@buildinternet/releases-core), which is the indexed vendors.
 *
 * Personal-workspace provisioning + the Stripe org-billing authorization gate.
 */
import { and, eq } from "drizzle-orm";
import type { AnyDb } from "../db.js";
import { authOrganization, authMember, user } from "../db/schema-auth.js";

/**
 * `AnyDb` (BaseSQLiteDatabase) doesn't type `.batch` — it's a D1-dialect method
 * (shimmed onto the bun:sqlite test handle by `ensureBatchShim`). Narrow cast so the
 * atomic org+member insert below stays typed without widening the param to `any`.
 */
type Batchable = { batch: (ops: ReadonlyArray<unknown>) => Promise<unknown[]> };

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

const OWNER_ADMIN_ROLES = new Set(["owner", "admin"]);

/** True when the user is an owner or admin of the given workspace. */
export async function isOrgOwnerOrAdmin(
  db: AnyDb,
  userId: string,
  organizationId: string,
): Promise<boolean> {
  const rows = await db
    .select({ role: authMember.role })
    .from(authMember)
    .where(and(eq(authMember.userId, userId), eq(authMember.organizationId, organizationId)))
    .limit(1);
  const role = rows[0]?.role;
  return role != null && OWNER_ADMIN_ROLES.has(role);
}

/**
 * Resolve the user's active workspace, creating a personal one if they have none.
 * Lazy provisioning called from the `session.create.before` hook — backfills existing
 * users on next sign-in. NEVER throws to the caller (returns null on failure) so a
 * provisioning hiccup can't block sign-in. Returns the active workspace org id.
 *
 *   - 0 memberships → create org + owner member (atomic batch) with a deterministic
 *     slug. On a UNIQUE(slug) race (a concurrent first-login for the SAME user — the
 *     slug is namespaced by user id) the batch fails; adopt the winner's org and
 *     ensure this user has a membership in it.
 *   - 1 membership → return it.
 *   - >1 → prefer `user.lastActiveOrganizationId` if still a membership, else the oldest.
 */
export async function ensureActiveWorkspace(db: AnyDb, userId: string): Promise<string | null> {
  try {
    const memberships = await db
      .select({ organizationId: authMember.organizationId, createdAt: authMember.createdAt })
      .from(authMember)
      .where(eq(authMember.userId, userId));

    if (memberships.length === 1) return memberships[0]!.organizationId;

    if (memberships.length > 1) {
      const userRows = await db
        .select({ lastActive: user.lastActiveOrganizationId })
        .from(user)
        .where(eq(user.id, userId))
        .limit(1);
      const lastActive = userRows[0]?.lastActive ?? null;
      if (lastActive && memberships.some((m) => m.organizationId === lastActive)) return lastActive;
      const oldest = [...memberships].sort(
        (a, b) => (a.createdAt?.getTime() ?? 0) - (b.createdAt?.getTime() ?? 0),
      )[0];
      return oldest?.organizationId ?? null;
    }

    // 0 memberships → provision the personal workspace.
    const userRows = await db
      .select({ name: user.name, email: user.email })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    if (userRows.length === 0) return null; // no user row → nothing sensible to create

    const slug = personalWorkspaceSlug(userId);
    const name = deriveWorkspaceName(userRows[0]!);
    const orgId = crypto.randomUUID();
    const memberId = crypto.randomUUID();

    try {
      await (db as unknown as Batchable).batch([
        db.insert(authOrganization).values({ id: orgId, name, slug }),
        db
          .insert(authMember)
          .values({ id: memberId, organizationId: orgId, userId, role: "owner" }),
      ]);
      return orgId;
    } catch {
      // Race: the slug already exists (a concurrent first-login for this user won the
      // atomic batch, so its org AND owner member are both committed). Adopt it; the
      // membership is already present, but ensure it defensively.
      const existing = await db
        .select({ id: authOrganization.id })
        .from(authOrganization)
        .where(eq(authOrganization.slug, slug))
        .limit(1);
      const winnerId = existing[0]?.id;
      if (!winnerId) return null;
      const mine = await db
        .select({ id: authMember.id })
        .from(authMember)
        .where(and(eq(authMember.userId, userId), eq(authMember.organizationId, winnerId)))
        .limit(1);
      if (mine.length === 0) {
        await db
          .insert(authMember)
          .values({ id: crypto.randomUUID(), organizationId: winnerId, userId, role: "owner" });
      }
      return winnerId;
    }
  } catch {
    return null;
  }
}
