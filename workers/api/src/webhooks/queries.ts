import { eq, and, inArray } from "drizzle-orm";
import { webhookSubscriptions, type WebhookSubscription } from "@buildinternet/releases-core/schema";
import type { D1Db } from "../db.js";

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
