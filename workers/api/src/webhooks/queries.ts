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
 * Worker-local partial update for a webhook subscription.
 * Returns the updated subscription row, or null if id not found before update.
 */
export async function updateWebhookSubscription(
  db: D1Db,
  id: string,
  updates: WebhookSubscriptionUpdates,
): Promise<WebhookSubscription | null> {
  const existing = await getWebhookSubscriptionById(db, id);
  if (!existing) return null;
  await db.update(webhookSubscriptions).set(updates).where(eq(webhookSubscriptions.id, id));
  // Re-fetch fresh to return the updated state.
  return getWebhookSubscriptionById(db, id);
}

/**
 * Worker-local delete for a webhook subscription. Idempotent — no error if id missing.
 */
export async function deleteWebhookSubscription(db: D1Db, id: string): Promise<void> {
  await db.delete(webhookSubscriptions).where(eq(webhookSubscriptions.id, id));
}

/**
 * Worker-local bump of secret_version. Throws if subscription not found.
 * Returns the new version number.
 */
export async function bumpWebhookSecretVersion(db: D1Db, id: string): Promise<number> {
  const cur = await getWebhookSubscriptionById(db, id);
  if (!cur) throw new Error(`subscription not found: ${id}`);
  const newVersion = cur.secretVersion + 1;
  await db.update(webhookSubscriptions)
    .set({ secretVersion: newVersion })
    .where(eq(webhookSubscriptions.id, id));
  return newVersion;
}
