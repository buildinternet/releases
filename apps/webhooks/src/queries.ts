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

import { eq, inArray } from "drizzle-orm";
import {
  organizations,
  webhookSubscriptions,
  type WebhookSubscription,
} from "@buildinternet/releases-core/schema";
import type { SubscriptionLabel } from "@releases/core-internal/webhook-alert-format";
import type { D1Db } from "./db.js";

export type { SummaryUpdate } from "@releases/core-internal/webhook-delivery-state";
export {
  setWebhookSubscriptionEnabled,
  updateWebhookSubscriptionSummary,
} from "@releases/core-internal/webhook-delivery-state";

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
