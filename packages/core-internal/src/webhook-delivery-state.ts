/**
 * Delivery-health transitions for a webhook subscription.
 *
 * The queue consumer can finish several messages for one subscription at
 * once. A read-modify-write of `consecutive_failures` drops or double-counts
 * those, and a disable decided from a stale snapshot can pause a webhook
 * that has already recovered. Both writes are a single conditional UPDATE.
 */
import { and, eq, isNull, sql } from "drizzle-orm";
import {
  webhookSubscriptions,
  type WebhookSubscription,
} from "@buildinternet/releases-core/schema";
import type { AnyDb } from "@releases/lib/db";

export type SummaryUpdate =
  | { kind: "success"; at: string }
  | { kind: "error"; at: string; message: string };

/**
 * Record one delivery outcome. A failure increments `consecutive_failures`
 * in the UPDATE and starts the failure streak only when the pre-update count
 * is 0. Returns the row after the write, or null when the subscription is gone.
 */
export async function updateWebhookSubscriptionSummary(
  db: AnyDb,
  id: string,
  update: SummaryUpdate,
): Promise<WebhookSubscription | null> {
  if (update.kind === "success") {
    const [row] = await db
      .update(webhookSubscriptions)
      .set({
        lastSuccessAt: update.at,
        consecutiveFailures: 0,
        failureStreakStartedAt: null,
      })
      .where(eq(webhookSubscriptions.id, id))
      .returning();
    return row ?? null;
  }
  const [row] = await db
    .update(webhookSubscriptions)
    .set({
      lastErrorAt: update.at,
      lastErrorMsg: update.message,
      consecutiveFailures: sql`${webhookSubscriptions.consecutiveFailures} + 1`,
      failureStreakStartedAt: sql`CASE WHEN ${webhookSubscriptions.consecutiveFailures} = 0 THEN ${update.at} ELSE ${webhookSubscriptions.failureStreakStartedAt} END`,
    })
    .where(eq(webhookSubscriptions.id, id))
    .returning();
  return row ?? null;
}

/**
 * Flip `enabled`. Returns true only when this call changed the row.
 *
 * Disable is compare-and-set on the failure snapshot the caller just
 * observed. A success (or a manual re-enable) that lands in between clears
 * the counter and this UPDATE matches nothing, so a stale decision cannot
 * pause a webhook that has recovered — and two consumers crossing the
 * threshold together send one auto-disable, not two.
 */
export async function setWebhookSubscriptionEnabled(
  db: AnyDb,
  id: string,
  enabled: boolean,
  reason: string | null,
  observed?: { consecutiveFailures: number; failureStreakStartedAt: string | null },
): Promise<boolean> {
  const conditions = [eq(webhookSubscriptions.id, id), eq(webhookSubscriptions.enabled, !enabled)];
  if (!enabled && observed) {
    conditions.push(eq(webhookSubscriptions.consecutiveFailures, observed.consecutiveFailures));
    conditions.push(
      observed.failureStreakStartedAt == null
        ? isNull(webhookSubscriptions.failureStreakStartedAt)
        : eq(webhookSubscriptions.failureStreakStartedAt, observed.failureStreakStartedAt),
    );
  }
  const [row] = await db
    .update(webhookSubscriptions)
    .set({ enabled, disabledReason: enabled ? null : reason })
    .where(and(...conditions))
    .returning({ id: webhookSubscriptions.id });
  return row != null;
}
