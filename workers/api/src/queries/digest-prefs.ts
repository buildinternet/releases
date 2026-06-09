import { and, eq } from "drizzle-orm";
import { generateDigestToken, isDigestTokenShaped } from "@buildinternet/releases-core/api-token";
import type { AnyDb } from "../db.js";
import {
  userDigestPrefs,
  type UserDigestPrefs,
  type DigestCadence,
} from "../db/schema-digest-prefs.js";
import { user } from "../db/schema-auth.js";

function newDigestPrefsId(): string {
  return `udp_${crypto.randomUUID()}`;
}

/**
 * `new Date` truncated to whole seconds. The Drizzle `mode: "timestamp"` columns
 * store Unix seconds, so a sub-second in-memory Date would not equal a round-tripped
 * DB read. Use this for every timestamp written by this module.
 */
function nowSeconds(): Date {
  return new Date(Math.floor(Date.now() / 1000) * 1000);
}

/** A digest send target: the user's address + their watermark + manage token. */
export interface DigestRecipient {
  userId: string;
  email: string;
  name: string | null;
  lastDigestAt: Date | null;
  manageToken: string;
}

/** Fetch the user's prefs row, or null if they've never set a preference. */
export async function getDigestPrefs(db: AnyDb, userId: string): Promise<UserDigestPrefs | null> {
  const row = await db
    .select()
    .from(userDigestPrefs)
    .where(eq(userDigestPrefs.userId, userId))
    .get();
  return row ?? null;
}

/**
 * Set the caller's cadence. Creates the row (minting a manage token) on first
 * call. Stamps `last_digest_at = now` ONLY on an off→on transition, so re-enabling
 * starts a fresh window (no backlog) while switching daily↔weekly preserves it.
 * Idempotent. Returns the resulting row.
 */
export async function setDigestCadence(
  db: AnyDb,
  userId: string,
  cadence: DigestCadence,
): Promise<UserDigestPrefs> {
  const now = nowSeconds();
  const existing = await getDigestPrefs(db, userId);

  if (!existing) {
    const row: UserDigestPrefs = {
      id: newDigestPrefsId(),
      userId,
      cadence,
      lastDigestAt: cadence === "off" ? null : now,
      manageToken: generateDigestToken(),
      createdAt: now,
      updatedAt: now,
    };
    await db.insert(userDigestPrefs).values(row);
    return row;
  }

  const enabling = existing.cadence === "off" && cadence !== "off";
  await db
    .update(userDigestPrefs)
    .set({ cadence, updatedAt: now, ...(enabling ? { lastDigestAt: now } : {}) })
    .where(eq(userDigestPrefs.userId, userId));

  return {
    ...existing,
    cadence,
    updatedAt: now,
    lastDigestAt: enabling ? now : existing.lastDigestAt,
  };
}

/**
 * Resolve a presented `reld_` manage token and set that user's cadence to `off`.
 * Returns true on a successful (idempotent) unsubscribe, false on an unknown or
 * malformed token. Never throws.
 */
export async function unsubscribeByToken(db: AnyDb, raw: string): Promise<boolean> {
  if (!isDigestTokenShaped(raw)) return false;
  const row = await db
    .select()
    .from(userDigestPrefs)
    .where(eq(userDigestPrefs.manageToken, raw))
    .get();
  if (!row) return false;
  if (row.cadence !== "off") {
    await db
      .update(userDigestPrefs)
      .set({ cadence: "off", updatedAt: nowSeconds() })
      .where(eq(userDigestPrefs.userId, row.userId));
  }
  return true;
}

/**
 * All users due for a digest at the given cadence whose email is verified, joined
 * to their auth address. Capped at `limit` (oldest watermark first so a backlog
 * drains across runs). Unverified addresses are never returned.
 */
export async function listDigestRecipients(
  db: AnyDb,
  cadence: Exclude<DigestCadence, "off">,
  limit: number,
): Promise<DigestRecipient[]> {
  return db
    .select({
      userId: userDigestPrefs.userId,
      email: user.email,
      name: user.name,
      lastDigestAt: userDigestPrefs.lastDigestAt,
      manageToken: userDigestPrefs.manageToken,
    })
    .from(userDigestPrefs)
    .innerJoin(user, eq(user.id, userDigestPrefs.userId))
    .where(and(eq(userDigestPrefs.cadence, cadence), eq(user.emailVerified, true)))
    .orderBy(userDigestPrefs.lastDigestAt)
    .limit(limit)
    .all();
}

/**
 * Ensure a prefs row exists for the user, minting a manage token, WITHOUT
 * changing their cadence. Returns the existing row untouched, or a freshly
 * created `off` row. Used by the admin test-send route so a test email carries a
 * real, working unsubscribe link even for a user who never set a preference.
 */
export async function ensureDigestPrefs(db: AnyDb, userId: string): Promise<UserDigestPrefs> {
  const existing = await getDigestPrefs(db, userId);
  if (existing) return existing;
  const now = nowSeconds();
  const row: UserDigestPrefs = {
    id: newDigestPrefsId(),
    userId,
    cadence: "off",
    lastDigestAt: null,
    manageToken: generateDigestToken(),
    createdAt: now,
    updatedAt: now,
  };
  await db.insert(userDigestPrefs).values(row);
  return row;
}

/**
 * Resolve a digest send target by userId OR email (for the dev/admin test-send
 * route). Looks the user up in the auth table, then ensures a prefs row so the
 * test email has a working unsubscribe link. Returns null if no such user. Does
 * NOT require email verification — a developer testing the path may use an
 * unverified address.
 */
export async function resolveDigestTestRecipient(
  db: AnyDb,
  by: { userId?: string; email?: string },
): Promise<DigestRecipient | null> {
  const where = by.userId ? eq(user.id, by.userId) : by.email ? eq(user.email, by.email) : null;
  if (!where) return null;
  const found = await db
    .select({ id: user.id, email: user.email, name: user.name })
    .from(user)
    .where(where)
    .get();
  if (!found) return null;
  const prefs = await ensureDigestPrefs(db, found.id);
  return {
    userId: found.id,
    email: found.email,
    name: found.name,
    lastDigestAt: prefs.lastDigestAt,
    manageToken: prefs.manageToken,
  };
}

/** Advance a user's watermark to the cron run start after a successful send. */
export async function advanceDigestWatermark(
  db: AnyDb,
  userId: string,
  runStart: Date,
): Promise<void> {
  await db
    .update(userDigestPrefs)
    .set({ lastDigestAt: runStart, updatedAt: runStart })
    .where(eq(userDigestPrefs.userId, userId));
}
