import { and, eq, isNull, lt, or } from "drizzle-orm";
import {
  FEED_TOKEN_PREFIX,
  generateFeedToken,
  parseFeedToken,
  constantTimeEqual,
} from "@buildinternet/releases-core/api-token";
import type { AnyDb } from "../db.js";
import { userFeedTokens, type UserFeedToken } from "../db/schema-feed-tokens.js";

// Fixed-length dummy secret (matches the 32-char SECRET_LEN) so a missing
// lookupId still incurs one constant-time comparison — uniform timing across
// "unknown token" and "wrong secret", mirroring api-token-store.ts.
const DUMMY_FEED_SECRET = "0".repeat(32);

/** How long after a successful feed-token auth before we rewrite last_used_at again. */
const FEED_TOKEN_TOUCH_THROTTLE_MS = 60_000;

function newFeedTokenId(): string {
  return `uft_${crypto.randomUUID()}`;
}

export interface MintedFeedToken {
  /** Full `relf_…` token — shown to the caller; reconstructable from the row. */
  token: string;
  lookupId: string;
  createdAt: Date;
}

/** Build the full `relf_<lookupId>_<secret>` token string from a stored row. */
export function feedTokenString(row: Pick<UserFeedToken, "lookupId" | "secret">): string {
  return `${FEED_TOKEN_PREFIX}${row.lookupId}_${row.secret}`;
}

/** The canonical public Atom feed URL for a token, given the serving origin. */
export function feedAtomUrl(origin: string, token: string): string {
  return `${origin}/v1/feed/${token}.atom`;
}

/**
 * Mint-or-rotate the caller's single feed token. Atomically upserts on the
 * unique userId index, so rotation replaces lookupId+secret+createdAt and
 * clears lastUsedAt in a single statement.
 */
export async function upsertFeedToken(db: AnyDb, userId: string): Promise<MintedFeedToken> {
  const { token, lookupId, secret } = generateFeedToken();
  const createdAt = new Date();
  await db
    .insert(userFeedTokens)
    .values({ id: newFeedTokenId(), userId, lookupId, secret, createdAt, lastUsedAt: null })
    .onConflictDoUpdate({
      target: userFeedTokens.userId,
      set: { lookupId, secret, createdAt, lastUsedAt: null },
    });
  return { token, lookupId, createdAt };
}

/** Fetch the user's token row (without forcing the caller to know the secret). */
export async function getFeedToken(db: AnyDb, userId: string): Promise<UserFeedToken | null> {
  const row = await db.select().from(userFeedTokens).where(eq(userFeedTokens.userId, userId)).get();
  return row ?? null;
}

/** Revoke: delete the user's token row. Idempotent. */
export async function deleteFeedToken(db: AnyDb, userId: string): Promise<void> {
  await db.delete(userFeedTokens).where(eq(userFeedTokens.userId, userId));
}

/**
 * Resolve a presented `relf_…` token to its owning user + lookupId, or null.
 * Looks up by the non-secret lookupId, then constant-time compares the secret.
 * Never throws.
 */
export async function resolveFeedToken(
  db: AnyDb,
  raw: string,
): Promise<{ userId: string; lookupId: string } | null> {
  const parsed = parseFeedToken(raw);
  if (!parsed) return null;
  const row = await db
    .select()
    .from(userFeedTokens)
    .where(eq(userFeedTokens.lookupId, parsed.lookupId))
    .get();
  if (!row) {
    constantTimeEqual(parsed.secret, DUMMY_FEED_SECRET);
    return null;
  }
  if (!constantTimeEqual(parsed.secret, row.secret)) return null;
  return { userId: row.userId, lookupId: row.lookupId };
}

/**
 * Record last-used, throttled: only rewrites if the previous value is null or
 * older than the throttle window. Single conditional UPDATE — safe to call
 * fire-and-forget via waitUntil on the hot path.
 */
export async function touchFeedTokenLastUsed(
  db: AnyDb,
  lookupId: string,
  now: Date = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - FEED_TOKEN_TOUCH_THROTTLE_MS);
  await db
    .update(userFeedTokens)
    .set({ lastUsedAt: now })
    .where(
      and(
        eq(userFeedTokens.lookupId, lookupId),
        or(isNull(userFeedTokens.lastUsedAt), lt(userFeedTokens.lastUsedAt, cutoff)),
      ),
    );
}
