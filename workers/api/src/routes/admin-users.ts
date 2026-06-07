/**
 * Admin-only user-role provisioning. Writes the Better Auth `user.role` column —
 * the durable source of truth the OAuth scope entitlement reads
 * (auth/entitlement.ts). Gated by `authMiddleware` (static root key) via the
 * `admin/users` entry in route-namespaces.ts. Replaces the brittle
 * `OAUTH_ADMIN_USER_IDS` env bootstrap (#1484).
 *
 * The settable role set is derived from `ROLE_LADDER` so this route can never
 * drift from the entitlement boundary. Fail-closed: unknown role → 400, missing
 * user → 404, never defaults to admin. "Revoke" = set role back to `user`.
 */
import { Hono } from "hono";
import { eq, inArray, type SQL } from "drizzle-orm";
import { logEvent } from "@releases/lib/log-event";
import { ROLE_LADDER } from "../auth/entitlement.js";
import { user } from "../db/schema-auth.js";
import { createDb } from "../db.js";
import type { Env } from "../index.js";

export const adminUsersRoutes = new Hono<Env>();

// oxlint-disable-next-line no-explicit-any
function getDb(c: any): ReturnType<typeof createDb> {
  return c.get("db") ?? createDb(c.env.DB);
}

/** Settable roles, taken from the entitlement ladder (user | curator | admin). */
const VALID_ROLES = new Set(Object.keys(ROLE_LADDER));

/** Exactly one of email/userId → a Drizzle predicate, or null when the pair is invalid. */
function identifierWhere(email: string | undefined, userId: string | undefined): SQL | null {
  if ((!email && !userId) || (email && userId)) return null;
  return userId ? eq(user.id, userId) : eq(user.email, email as string);
}

adminUsersRoutes.get("/admin/users/role", async (c) => {
  const db = getDb(c);
  const where = identifierWhere(c.req.query("email"), c.req.query("userId"));
  if (!where) return c.json({ error: "exactly one of email or userId required" }, 400);
  const [row] = await db
    .select({ id: user.id, email: user.email, role: user.role })
    .from(user)
    .where(where);
  if (!row) return c.json({ error: "user_not_found" }, 404);
  return c.json({ userId: row.id, email: row.email, role: row.role });
});

adminUsersRoutes.get("/admin/users/roles", async (c) => {
  const db = getDb(c);
  const rows = await db
    .select({ id: user.id, email: user.email, role: user.role })
    .from(user)
    .where(inArray(user.role, ["curator", "admin"]));
  return c.json({ users: rows.map((r) => ({ userId: r.id, email: r.email, role: r.role })) });
});

adminUsersRoutes.patch("/admin/users/role", async (c) => {
  const db = getDb(c);
  let body: { email?: unknown; userId?: unknown; role?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  const email = typeof body.email === "string" ? body.email : undefined;
  const userId = typeof body.userId === "string" ? body.userId : undefined;
  const role = typeof body.role === "string" ? body.role : undefined;

  const where = identifierWhere(email, userId);
  if (!where) return c.json({ error: "exactly one of email or userId required" }, 400);
  if (!role || !VALID_ROLES.has(role)) {
    return c.json({ error: "invalid_role", allowed: [...VALID_ROLES] }, 400);
  }

  const [existing] = await db
    .select({ id: user.id, email: user.email, role: user.role })
    .from(user)
    .where(where);
  if (!existing) return c.json({ error: "user_not_found" }, 404);

  await db.update(user).set({ role, updatedAt: new Date() }).where(eq(user.id, existing.id));

  logEvent("info", {
    component: "auth",
    event: "role-changed",
    targetUserId: existing.id,
    targetEmail: existing.email,
    fromRole: existing.role ?? null,
    toRole: role,
    actor: "root-key",
  });

  return c.json({
    userId: existing.id,
    email: existing.email,
    previousRole: existing.role ?? null,
    role,
  });
});
