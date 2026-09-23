import { logEvent } from "@releases/lib/log-event";
import { expandAndEnqueue } from "../webhooks/expand-and-enqueue.js";
import {
  loadFollowTargetsForUsers,
  matchFollowsScopedWebhookSubscriptions,
  matchWebhookSubscriptions,
} from "../webhooks/queries.js";
import { createDb } from "../db.js";
import type { ReleaseEvent } from "../events/types.js";
import type { WebhookEventOwner } from "../webhooks/subscription-match.js";
import type { ReleaseFanoutMessage } from "./types.js";

const QUEUE_BATCH_LIMIT = 100;

export function buildReleaseFanoutMessage(
  events: ReleaseEvent[],
  eventOwners: Map<string, WebhookEventOwner>,
): ReleaseFanoutMessage {
  const owners: ReleaseFanoutMessage["owners"] = [];
  for (const event of events) {
    const owner = eventOwners.get(event.release.id);
    if (!owner) continue;
    owners.push({
      releaseId: event.release.id,
      orgId: owner.orgId,
      sourceId: owner.sourceId,
      productId: owner.productId,
      releaseType: owner.releaseType,
    });
  }
  return { events, owners };
}

export interface EnqueueReleaseFanoutArgs {
  events: ReleaseEvent[];
  eventOwners: Map<string, WebhookEventOwner>;
  queue: { send: (message: ReleaseFanoutMessage) => Promise<unknown> };
  /** When queue send fails, inline fan-out via webhook-delivery if bindings present. */
  fallbackEnv?: FanoutWebhookEnv;
}

async function inlineWebhookFanout(
  env: FanoutWebhookEnv,
  events: ReleaseEvent[],
  eventOwners: Map<string, WebhookEventOwner>,
): Promise<void> {
  if (!env.WEBHOOK_DELIVERY_QUEUE || !env.DB) return;
  await expandAndEnqueue({
    events,
    eventOwners,
    loadOrgSubscriptions: (orgIds) => matchWebhookSubscriptions(createDb(env.DB!), orgIds),
    loadFollowsSubscriptions: () => matchFollowsScopedWebhookSubscriptions(createDb(env.DB!)),
    loadFollowTargetsForUsers: (userIds) => loadFollowTargetsForUsers(createDb(env.DB!), userIds),
    queue: env.WEBHOOK_DELIVERY_QUEUE,
  });
}

/**
 * Enqueue one release fan-out message. Never throws — failures are logged.
 */
export async function enqueueReleaseFanout(args: EnqueueReleaseFanoutArgs): Promise<void> {
  if (args.events.length === 0) return;
  try {
    await args.queue.send(buildReleaseFanoutMessage(args.events, args.eventOwners));
  } catch (err) {
    logEvent("warn", {
      component: "release-events",
      event: "enqueue-failed",
      err: err instanceof Error ? err : String(err),
    });
    if (args.fallbackEnv) {
      await inlineWebhookFanout(args.fallbackEnv, args.events, args.eventOwners);
    }
  }
}

export interface FanoutWebhookEnv {
  DB?: D1Database;
  WEBHOOK_DELIVERY_QUEUE?: Queue<unknown>;
}

/**
 * Fan-out webhooks via the release-events queue when bound, else inline
 * expandAndEnqueue (local dev / tests without the queue).
 */
export async function fanoutWebhooks(
  env: FanoutWebhookEnv,
  events: ReleaseEvent[],
  eventOwners: Map<string, WebhookEventOwner>,
  releaseEventsQueue?: { send: (message: ReleaseFanoutMessage) => Promise<unknown> },
): Promise<void> {
  if (events.length === 0) return;

  if (releaseEventsQueue) {
    await enqueueReleaseFanout({
      events,
      eventOwners,
      queue: releaseEventsQueue,
      fallbackEnv: env,
    });
    return;
  }

  await inlineWebhookFanout(env, events, eventOwners);
}

/** Chunked sendBatch for digest cron enqueue. */
export async function sendDigestBatch(
  queue: {
    sendBatch: (
      messages: { body: import("./types.js").DigestDeliveryMessage }[],
    ) => Promise<unknown>;
  },
  messages: import("./types.js").DigestDeliveryMessage[],
): Promise<void> {
  for (let i = 0; i < messages.length; i += QUEUE_BATCH_LIMIT) {
    const chunk = messages.slice(i, i + QUEUE_BATCH_LIMIT);
    // oxlint-disable-next-line no-await-in-loop -- Cloudflare Queue chunked sendBatch
    await queue.sendBatch(chunk.map((body) => ({ body })));
  }
}
