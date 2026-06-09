import { eq } from "drizzle-orm";
import {
  generateFeedToken,
  parseFeedToken,
  constantTimeEqual,
} from "@buildinternet/releases-core/api-token";
import type { AnyDb } from "../db.js";
import { userFeedTokens, type UserFeedToken } from "../db/schema-feed-tokens.js";

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
  return `relf_${row.lookupId}_${row.secret}`;
}

/**
 * Mint-or-rotate the caller's single feed token. Deletes any existing row for
 * the user, then inserts a fresh one (so rotation invalidates the old secret).
 */
export async function upsertFeedToken(db: AnyDb, userId: string): Promise<MintedFeedToken> {
  const { token, lookupId, secret } = generateFeedToken();
  const createdAt = new Date();
  await db.delete(userFeedTokens).where(eq(userFeedTokens.userId, userId));
  await db.insert(userFeedTokens).values({
    id: newFeedTokenId(),
    userId,
    lookupId,
    secret,
    createdAt,
    lastUsedAt: null,
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
 * Resolve a presented `relf_…` token to its owning userId, or null. Looks up by
 * the non-secret lookupId, then constant-time compares the secret. Never throws.
 */
export async function resolveFeedToken(db: AnyDb, raw: string): Promise<string | null> {
  const parsed = parseFeedToken(raw);
  if (!parsed) return null;
  const row = await db
    .select()
    .from(userFeedTokens)
    .where(eq(userFeedTokens.lookupId, parsed.lookupId))
    .get();
  if (!row) return null;
  if (!constantTimeEqual(parsed.secret, row.secret)) return null;
  return row.userId;
}

/** Best-effort: stamp last_used_at. Caller should not await on the hot path. */
export async function touchFeedTokenLastUsed(db: AnyDb, lookupId: string): Promise<void> {
  await db
    .update(userFeedTokens)
    .set({ lastUsedAt: new Date() })
    .where(eq(userFeedTokens.lookupId, lookupId));
}
