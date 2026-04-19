import { eq, and, inArray } from "drizzle-orm";
import { webhookSubscriptions, type WebhookSubscription } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../db.js";

export type WebhookSubscriptionUpdates = Partial<{
  url: string;
  description: string | null;
  enabled: boolean;
  disabledReason: string | null;
  consecutiveFailures: number;
}>;

/**
 * Worker-local copy of `matchWebhookSubscriptions` from src/db/queries.ts.
 * Cannot import from src/db/queries.ts because that module pulls in bun:sqlite
 * via ./connection.js, which doesn't exist in the Worker runtime.
 *
 * Returns enabled subscriptions for any of the given orgIds. The publisher
 * then matches each event against these in memory using sourceId.
 */
export async function matchWebhookSubscriptions(
  db: D1Db,
  orgIds: string[],
): Promise<WebhookSubscription[]> {
  if (orgIds.length === 0) return [];
  return db.select().from(webhookSubscriptions)
    .where(and(
      eq(webhookSubscriptions.enabled, true),
      inArray(webhookSubscriptions.orgId, orgIds),
    ));
}

/**
 * Worker-local copy of `insertWebhookSubscription` from src/db/queries.ts.
 * Cannot import from src/db/queries.ts because that module pulls in bun:sqlite
 * via ./connection.js, which doesn't exist in the Worker runtime.
 */
export async function insertWebhookSubscription(
  db: D1Db,
  input: { orgId: string; url: string; sourceId: string | null; description: string | null },
): Promise<WebhookSubscription> {
  const [row] = await db.insert(webhookSubscriptions).values(input).returning();
  return row;
}

/**
 * Worker-local copy of `getWebhookSubscriptionById` from src/db/queries.ts.
 * Cannot import from src/db/queries.ts because that module pulls in bun:sqlite
 * via ./connection.js, which doesn't exist in the Worker runtime.
 */
export async function getWebhookSubscriptionById(
  db: D1Db,
  id: string,
): Promise<WebhookSubscription | null> {
  const rows = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Worker-local copy of `listWebhookSubscriptionsByOrg` from src/db/queries.ts.
 * Cannot import from src/db/queries.ts because that module pulls in bun:sqlite
 * via ./connection.js, which doesn't exist in the Worker runtime.
 */
export async function listWebhookSubscriptionsByOrg(
  db: D1Db,
  orgId: string,
  opts?: { enabledOnly?: boolean },
): Promise<WebhookSubscription[]> {
  if (opts?.enabledOnly) {
    return db.select().from(webhookSubscriptions)
      .where(and(eq(webhookSubscriptions.orgId, orgId), eq(webhookSubscriptions.enabled, true)));
  }
  return db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.orgId, orgId));
}

/**
 * Worker-local partial update. Returns null when id matches no row.
 * D1 UPDATE on a missing row is a no-op, so re-fetching tells us both
 * "current state" and "did the row exist" in one round-trip.
 */
export async function updateWebhookSubscription(
  db: D1Db,
  id: string,
  updates: WebhookSubscriptionUpdates,
): Promise<WebhookSubscription | null> {
  await db.update(webhookSubscriptions).set(updates).where(eq(webhookSubscriptions.id, id));
  return getWebhookSubscriptionById(db, id);
}

/** Worker-local delete. Idempotent — no error if id missing. */
export async function deleteWebhookSubscription(db: D1Db, id: string): Promise<void> {
  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
}

/**
 * Bump secret_version via read-modify-write. Returns the new version, or
 * null when the subscription is missing. Not atomic — concurrent rotations
 * could collide on the same version (admin endpoint, low contention).
 */
export async function bumpWebhookSecretVersion(db: D1Db, id: string): Promise<number | null> {
  const cur = await getWebhookSubscriptionById(db, id);
  if (!cur) return null;
  const newVersion = cur.secretVersion + 1;
  await db.update(webhookSubscriptions)
    .set({ secretVersion: newVersion })
    .where(eq(webhookSubscriptions.id, id));
  return newVersion;
}
