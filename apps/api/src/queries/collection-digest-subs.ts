import { and, desc, eq, isNull, lt, or } from "drizzle-orm";
import { isDigestTokenShaped } from "@buildinternet/releases-core/api-token";
import { collections } from "@buildinternet/releases-core/schema";
import type { CollectionDigestSubscription } from "@buildinternet/releases-api-types";
import type { AnyDb } from "../db.js";
import { userCollectionDigestSubs } from "../db/schema-collection-digest-subs.js";
import { userDigestPrefs } from "../db/schema-digest-prefs.js";
import { user } from "../db/schema-auth.js";
import { ensureDigestPrefs, nowSeconds } from "./digest-prefs.js";

/**
 * Per-collection weekly digest email subscriptions (#2459). Subscribing reuses
 * the follows digest's `reld_` manage token (minted via `ensureDigestPrefs`) so
 * every digest email has one unsubscribe lane; a collection link carries the
 * collection slug and removes only that subscription.
 */

/** A collection a reader can subscribe to: it exists and generates weekly digests. */
async function findDigestCollection(
  db: AnyDb,
  slug: string,
): Promise<{ id: string; slug: string; name: string } | null> {
  const [row] = await db
    .select({ id: collections.id, slug: collections.slug, name: collections.name })
    .from(collections)
    .where(and(eq(collections.slug, slug), eq(collections.weeklyDigestEnabled, true)));
  return row ?? null;
}

/** The caller's subscriptions, newest first. */
export async function listCollectionDigestSubs(
  db: AnyDb,
  userId: string,
): Promise<CollectionDigestSubscription[]> {
  const rows = await db
    .select({
      collectionSlug: collections.slug,
      collectionName: collections.name,
      createdAt: userCollectionDigestSubs.createdAt,
    })
    .from(userCollectionDigestSubs)
    .innerJoin(collections, eq(collections.id, userCollectionDigestSubs.collectionId))
    .where(eq(userCollectionDigestSubs.userId, userId))
    .orderBy(desc(userCollectionDigestSubs.createdAt));
  return rows.map((r) => ({
    collectionSlug: r.collectionSlug,
    collectionName: r.collectionName,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Subscribe the user to a collection's weekly digest. Idempotent. Returns null
 * when the collection doesn't exist or doesn't generate weekly digests.
 */
export async function subscribeCollectionDigest(
  db: AnyDb,
  userId: string,
  slug: string,
): Promise<{ collectionSlug: string } | null> {
  const col = await findDigestCollection(db, slug);
  if (!col) return null;
  await ensureDigestPrefs(db, userId);
  await db
    .insert(userCollectionDigestSubs)
    .values({
      id: `ucd_${crypto.randomUUID()}`,
      userId,
      collectionId: col.id,
      createdAt: nowSeconds(),
    })
    .onConflictDoNothing();
  return { collectionSlug: col.slug };
}

/** Remove the user's subscription to a collection by slug. Idempotent. */
export async function unsubscribeCollectionDigest(
  db: AnyDb,
  userId: string,
  slug: string,
): Promise<void> {
  const [col] = await db
    .select({ id: collections.id })
    .from(collections)
    .where(eq(collections.slug, slug));
  if (!col) return;
  await db
    .delete(userCollectionDigestSubs)
    .where(
      and(
        eq(userCollectionDigestSubs.userId, userId),
        eq(userCollectionDigestSubs.collectionId, col.id),
      ),
    );
}

/**
 * One-click unsubscribe from one collection's digest, authenticated by the
 * user's `reld_` manage token. Leaves the follows digest cadence alone. Returns
 * false on an unknown or malformed token; true otherwise (idempotent, including
 * when the user had no such subscription).
 */
export async function unsubscribeCollectionDigestByToken(
  db: AnyDb,
  raw: string,
  slug: string,
): Promise<boolean> {
  if (!isDigestTokenShaped(raw)) return false;
  const [prefs] = await db
    .select({ userId: userDigestPrefs.userId })
    .from(userDigestPrefs)
    .where(eq(userDigestPrefs.manageToken, raw));
  if (!prefs) return false;
  await unsubscribeCollectionDigest(db, prefs.userId, slug);
  return true;
}

/**
 * Users who should get this collection's digest for `weekStart`: subscribed,
 * email verified, and not yet sent this week (or a later one).
 */
export async function listCollectionDigestRecipientIds(
  db: AnyDb,
  collectionId: string,
  weekStart: string,
): Promise<string[]> {
  const rows = await db
    .select({ userId: userCollectionDigestSubs.userId })
    .from(userCollectionDigestSubs)
    .innerJoin(user, eq(user.id, userCollectionDigestSubs.userId))
    .where(
      and(
        eq(userCollectionDigestSubs.collectionId, collectionId),
        eq(user.emailVerified, true),
        or(
          isNull(userCollectionDigestSubs.lastSentWeek),
          lt(userCollectionDigestSubs.lastSentWeek, weekStart),
        ),
      ),
    );
  return rows.map((r) => r.userId);
}

/** Address + unsubscribe token for one subscriber, or null if they no longer qualify. */
export async function getCollectionDigestRecipient(
  db: AnyDb,
  userId: string,
  collectionId: string,
): Promise<{
  email: string;
  name: string | null;
  manageToken: string;
  lastSentWeek: string | null;
} | null> {
  const [row] = await db
    .select({
      email: user.email,
      name: user.name,
      manageToken: userDigestPrefs.manageToken,
      lastSentWeek: userCollectionDigestSubs.lastSentWeek,
    })
    .from(userCollectionDigestSubs)
    .innerJoin(user, eq(user.id, userCollectionDigestSubs.userId))
    .innerJoin(userDigestPrefs, eq(userDigestPrefs.userId, userCollectionDigestSubs.userId))
    .where(
      and(
        eq(userCollectionDigestSubs.userId, userId),
        eq(userCollectionDigestSubs.collectionId, collectionId),
        eq(user.emailVerified, true),
      ),
    );
  return row ?? null;
}

/**
 * Claim the send for (user, collection, week) by moving `last_sent_week` forward.
 * Only one caller wins: a queue redelivery or a concurrent consumer finds the
 * week already claimed and must not send. Returns false in that case (or when
 * the subscription is gone).
 */
export async function claimCollectionDigestSend(
  db: AnyDb,
  userId: string,
  collectionId: string,
  weekStart: string,
): Promise<boolean> {
  const updated = await db
    .update(userCollectionDigestSubs)
    .set({ lastSentWeek: weekStart })
    .where(
      and(
        eq(userCollectionDigestSubs.userId, userId),
        eq(userCollectionDigestSubs.collectionId, collectionId),
        or(
          isNull(userCollectionDigestSubs.lastSentWeek),
          lt(userCollectionDigestSubs.lastSentWeek, weekStart),
        ),
      ),
    )
    .returning({ id: userCollectionDigestSubs.id });
  return updated.length > 0;
}

/** Undo a claim after a failed send, so a retry can send. No-op if it moved on. */
export async function releaseCollectionDigestSend(
  db: AnyDb,
  userId: string,
  collectionId: string,
  weekStart: string,
  previous: string | null,
): Promise<void> {
  await db
    .update(userCollectionDigestSubs)
    .set({ lastSentWeek: previous })
    .where(
      and(
        eq(userCollectionDigestSubs.userId, userId),
        eq(userCollectionDigestSubs.collectionId, collectionId),
        eq(userCollectionDigestSubs.lastSentWeek, weekStart),
      ),
    );
}
