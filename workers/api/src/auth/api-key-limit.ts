/**
 * Per-user ceiling on the number of *active* `relu_` user API keys, enforced at
 * the Better Auth `/api-key/create` chokepoint (see the `hooks.before` in
 * `auth/index.ts`) so it covers BOTH our `/v1/api-keys` mint route AND Better
 * Auth's own native `/api/auth/api-key/create` endpoint. Anti-sprawl, not a
 * security control — a user can only ever mint read-only keys (see
 * `api-key-scope.ts`); the cap just stops one account from minting hundreds.
 */
import { and, eq, gt, isNull, or } from "drizzle-orm";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { apikey } from "../db/schema-auth.js";

/**
 * Max active keys per user. "Active" = enabled AND not past its expiry. Start
 * conservative — plenty for a CLI login plus a couple of integrations, tight
 * enough that runaway minting trips the cap fast.
 */
export const USER_API_KEY_MAX_ACTIVE = 5;

/**
 * Error code + caller-facing message for a tripped cap, shared by the Better
 * Auth before-hook (which throws an APIError carrying this code) and the
 * `/v1/api-keys` route (which matches the code to map that throw — and its own
 * pre-check — to a clean 409). One source so wording and the cap value can't
 * drift across the three call sites.
 */
export const API_KEY_LIMIT_CODE = "API_KEY_LIMIT_REACHED";
export const API_KEY_LIMIT_MESSAGE = `API key limit reached (max ${USER_API_KEY_MAX_ACTIVE} active keys). Revoke one and try again.`;

/**
 * Count a user's active keys: NOT disabled AND not past expiry. `enabled` is
 * nullable and `null` means enabled (Better Auth writes `true` on create, but
 * the column's documented default is "treat null as on"), so the predicate is
 * `(enabled IS NULL OR enabled = true)` — a plain `enabled = true` would
 * undercount default-enabled rows and silently weaken the cap. Revoked keys are
 * hard-deleted (both our DELETE route and Better Auth's own delete remove the
 * row), so they never count. `now` is injectable for deterministic tests.
 */
export async function countActiveUserKeys(
  // oxlint-disable-next-line no-explicit-any -- matches CreateAuthDeps.db (D1 in prod, BunSQLite in tests)
  db: BaseSQLiteDatabase<any, any, any, any>,
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  const rows = await db
    .select({ id: apikey.id })
    .from(apikey)
    .where(
      and(
        eq(apikey.referenceId, userId),
        or(isNull(apikey.enabled), eq(apikey.enabled, true)),
        or(isNull(apikey.expiresAt), gt(apikey.expiresAt, now)),
      ),
    )
    .all();
  return rows.length;
}
