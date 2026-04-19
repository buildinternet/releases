import { getReleaseHub } from "../utils.js";
import { buildReleaseEventPayloads, type InsertedReleaseRow } from "./build-event.js";
import { expandAndEnqueue } from "../webhooks/expand-and-enqueue.js";
import { matchWebhookSubscriptions } from "../webhooks/queries.js";
import { createDb } from "../db.js";
import { newLocalEventId } from "@releases/core-internal/id";
import type { ReleaseEvent } from "./types.js";

export interface PublishContext {
  src: { name: string; slug: string; orgId: string | null; sourceId: string };
  inserted: InsertedReleaseRow[];
}

export interface PublishEnv {
  RELEASE_HUB: DurableObjectNamespace;
  WEBHOOK_DELIVERY_QUEUE?: Queue<unknown>;
  DB?: D1Database;
}

/**
 * Publish release.created events:
 *   1. To ReleaseHub (WebSocket fan-out + ring buffer).
 *   2. To webhook-delivery queue (per-subscription fan-out).
 *
 * Both branches are fire-and-forget. Caller already wraps this in
 * ctx.waitUntil(). Errors are logged, never thrown.
 */
export async function publishReleaseEvents(env: PublishEnv, ctx: PublishContext): Promise<void> {
  if (ctx.inserted.length === 0) return;
  const eventOwners = new Map<string, { orgId: string; sourceId: string }>();
  if (ctx.src.orgId) {
    for (const row of ctx.inserted) {
      eventOwners.set(row.id, { orgId: ctx.src.orgId, sourceId: ctx.src.sourceId });
    }
  }

  const payloads = buildReleaseEventPayloads(ctx);
  // Consumer keys idempotency on release.id (X-Released-Event-Id), not on seq.
  const ts = Date.now();
  const events: ReleaseEvent[] = payloads.map((p) => ({
    id: newLocalEventId(),
    seq: 0,
    ts,
    type: "release.created" as const,
    release: p,
  }));

  const hubPublish = (async () => {
    try {
      const res = await getReleaseHub(env).fetch(
        new Request("https://do/publish", {
          method: "POST",
          body: JSON.stringify({ events: payloads }),
          headers: { "Content-Type": "application/json" },
        }),
      );
      if (!res.ok) {
        console.warn(
          `[events] publish returned ${res.status}: ${await res.text().catch(() => "")}`,
        );
      }
    } catch (err) {
      console.warn(
        `[events] hub publish failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  })();

  const webhookFanout =
    env.WEBHOOK_DELIVERY_QUEUE && env.DB
      ? expandAndEnqueue({
          events,
          eventOwners,
          loadSubscriptions: (orgIds) => matchWebhookSubscriptions(createDb(env.DB!), orgIds),
          queue: env.WEBHOOK_DELIVERY_QUEUE,
        })
      : Promise.resolve();

  await Promise.all([hubPublish, webhookFanout]);
}
