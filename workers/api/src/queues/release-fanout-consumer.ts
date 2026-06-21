import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import { expandAndEnqueue } from "../webhooks/expand-and-enqueue.js";
import {
  loadFollowTargetsForUsers,
  matchFollowsScopedWebhookSubscriptions,
  matchWebhookSubscriptions,
} from "../webhooks/queries.js";
import type { ReleaseFanoutMessage } from "./types.js";
import type { WebhookEventOwner } from "../webhooks/subscription-match.js";

export interface ReleaseFanoutConsumerEnv {
  DB: D1Database;
  WEBHOOK_DELIVERY_QUEUE?: Queue<unknown>;
}

function ownersFromMessage(msg: ReleaseFanoutMessage): Map<string, WebhookEventOwner> {
  const map = new Map<string, WebhookEventOwner>();
  for (const o of msg.owners) {
    map.set(o.releaseId, {
      orgId: o.orgId,
      sourceId: o.sourceId,
      productId: o.productId,
      releaseType: o.releaseType,
    });
  }
  return map;
}

/**
 * Expand a release fan-out message into per-subscription webhook-delivery
 * queue messages. Never throws — failures are logged for queue retry.
 */
export async function processReleaseFanoutMessage(
  env: ReleaseFanoutConsumerEnv,
  body: ReleaseFanoutMessage,
): Promise<void> {
  if (!env.WEBHOOK_DELIVERY_QUEUE) {
    logEvent("warn", {
      component: "release-events-queue",
      event: "delivery-queue-missing",
      eventCount: body.events.length,
    });
    throw new Error("WEBHOOK_DELIVERY_QUEUE binding missing");
  }
  if (!env.DB) {
    logEvent("warn", {
      component: "release-events-queue",
      event: "db-missing",
      eventCount: body.events.length,
    });
    throw new Error("DB binding missing");
  }
  if (body.events.length === 0) return;

  const db = createDb(env.DB);
  await expandAndEnqueue({
    events: body.events,
    eventOwners: ownersFromMessage(body),
    loadOrgSubscriptions: (orgIds) => matchWebhookSubscriptions(db, orgIds),
    loadFollowsSubscriptions: () => matchFollowsScopedWebhookSubscriptions(db),
    loadFollowTargetsForUsers: (userIds) => loadFollowTargetsForUsers(db, userIds),
    queue: env.WEBHOOK_DELIVERY_QUEUE,
  });
}
