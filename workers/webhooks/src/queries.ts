/**
 * Worker-local copies of webhook subscription helpers from src/db/queries.ts.
 * Cannot import from src/db/queries.ts because that module pulls in bun:sqlite
 * via ./connection.js, which doesn't exist in the Cloudflare Workers runtime.
 * See workers/api/src/webhooks/queries.ts for the same pattern on the API side.
 *
 * When these helpers diverge or grow, the eventual fix is to extract them to a
 * shared worker-safe package (tracked under task #24, packages/core reconciliation).
 * For now, duplicate cleanly here and in workers/api/src/webhooks/queries.ts.
 */

import { eq } from "drizzle-orm";
import { webhookSubscriptions, type WebhookSubscription } from "@buildinternet/releases-core/schema";
import type { D1Db } from "./db.js";

export type SummaryUpdate =
  | { kind: "success"; at: string }
  | { kind: "error"; at: string; message: string };

export async function getWebhookSubscriptionById(
  db: D1Db,
  id: string,
): Promise<WebhookSubscription | null> {
  const rows = await db.select().from(webhookSubscriptions).where(eq(webhookSubscriptions.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function updateWebhookSubscriptionSummary(
  db: D1Db,
  id: string,
  update: SummaryUpdate,
): Promise<void> {
  if (update.kind === "success") {
    await db.update(webhookSubscriptions)
      .set({ lastSuccessAt: update.at, consecutiveFailures: 0 })
      .where(eq(webhookSubscriptions.id, id));
  } else {
    // Read-modify-write: not atomic. Concurrent retries may double-increment.
    const cur = await getWebhookSubscriptionById(db, id);
    if (!cur) return;
    await db.update(webhookSubscriptions)
      .set({
        lastErrorAt: update.at,
        lastErrorMsg: update.message,
        consecutiveFailures: cur.consecutiveFailures + 1,
      })
      .where(eq(webhookSubscriptions.id, id));
  }
}

export async function setWebhookSubscriptionEnabled(
  db: D1Db,
  id: string,
  enabled: boolean,
  reason: string | null,
): Promise<void> {
  await db.update(webhookSubscriptions)
    .set({ enabled, disabledReason: enabled ? null : reason })
    .where(eq(webhookSubscriptions.id, id));
}
