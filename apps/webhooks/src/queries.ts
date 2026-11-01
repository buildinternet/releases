/**
 * Worker-local copies of webhook subscription helpers from src/db/queries.ts.
 * Cannot import from src/db/queries.ts because that module pulls in bun:sqlite
 * via ./connection.js, which doesn't exist in the Cloudflare Workers runtime.
 * See apps/api/src/webhooks/queries.ts for the same pattern on the API side.
 *
 * When these helpers diverge or grow, the eventual fix is to extract them to a
 * shared worker-safe package (tracked under task #24, packages/core reconciliation).
 * For now, duplicate cleanly here and in apps/api/src/webhooks/queries.ts.
 */

import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  organizations,
  webhookSubscriptions,
  type WebhookSubscription,
} from "@buildinternet/releases-core/schema";
import type { SubscriptionLabel } from "@releases/core-internal/webhook-alert-format";
import type { D1Db } from "./db.js";

export type SummaryUpdate =
  | { kind: "success"; at: string }
  | { kind: "error"; at: string; message: string };

export async function getWebhookSubscriptionById(
  db: D1Db,
  id: string,
): Promise<WebhookSubscription | null> {
  const rows = await db
    .select()
    .from(webhookSubscriptions)
    .where(eq(webhookSubscriptions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** D1 caps prepared statements at 100 bound params; chunk the IN list. */
const IN_LOOKUP_CHUNK = 90;

/**
 * Resolve subscription id → url + description + owning org so the DLQ alert
 * can name the integration instead of an opaque id. Missing ids are simply
 * absent from the result (caller falls back to the bare id).
 */
export async function getWebhookSubscriptionLabels(
  db: D1Db,
  ids: string[],
): Promise<SubscriptionLabel[]> {
  if (ids.length === 0) return [];
  const chunks: Promise<SubscriptionLabel[]>[] = [];
  for (let i = 0; i < ids.length; i += IN_LOOKUP_CHUNK) {
    const slice = ids.slice(i, i + IN_LOOKUP_CHUNK);
    chunks.push(
      db
        .select({
          id: webhookSubscriptions.id,
          url: webhookSubscriptions.url,
          description: webhookSubscriptions.description,
          orgName: organizations.name,
          orgSlug: organizations.slug,
        })
        .from(webhookSubscriptions)
        .leftJoin(organizations, eq(webhookSubscriptions.orgId, organizations.id))
        .where(inArray(webhookSubscriptions.id, slice)),
    );
  }
  return (await Promise.all(chunks)).flat();
}

/** Resolve a single org id → name + slug for the auto-disable alert. */
export async function getOrgLabelById(
  db: D1Db,
  orgId: string,
): Promise<{ name: string; slug: string } | null> {
  const rows = await db
    .select({ name: organizations.name, slug: organizations.slug })
    .from(organizations)
    .where(eq(organizations.id, orgId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Record one delivery outcome. Failure increments `consecutive_failures` in
 * the UPDATE itself (a read-modify-write drops or double-counts when two
 * queue consumers finish the same subscription together) and starts the
 * failure streak only when the pre-update count is 0. Returns the row after
 * the write, or null when the subscription is gone.
 */
export async function updateWebhookSubscriptionSummary(
  db: D1Db,
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
  db: D1Db,
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
