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
