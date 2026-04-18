import { getReleaseHub } from "../utils.js";
import { buildReleaseEventPayloads, type InsertedReleaseRow } from "./build-event.js";
import { expandAndEnqueue } from "../webhooks/expand-and-enqueue.js";
import { matchWebhookSubscriptions } from "../webhooks/queries.js";
import { createDb } from "../db.js";
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
export async function publishReleaseEvents(
  env: PublishEnv,
  ctx: PublishContext,
): Promise<void> {
  if (ctx.inserted.length === 0) return;
  const eventOwners = new Map<string, { orgId: string; sourceId: string }>();
  if (ctx.src.orgId) {
    for (const row of ctx.inserted) {
      eventOwners.set(row.id, { orgId: ctx.src.orgId, sourceId: ctx.src.sourceId });
    }
  }

  // (1) Hub publish.
  let hubEvents: ReleaseEvent[] = [];
  try {
    const payloads = buildReleaseEventPayloads(ctx);
    const res = await getReleaseHub(env).fetch(new Request("https://do/publish", {
      method: "POST",
      body: JSON.stringify({ events: payloads }),
      headers: { "Content-Type": "application/json" },
    }));
    if (!res.ok) {
      console.warn(`[events] publish returned ${res.status}: ${await res.text().catch(() => "")}`);
    } else {
      // v1: build ReleaseEvent shape locally with placeholder seq/id.
      // Consumer keys idempotency on release.id (X-Released-Event-Id), not on seq.
      // If future cursor-resume needs DO-assigned seq, extend /publish to return events.
      hubEvents = payloads.map((p, i) => ({
        id: `local_${Date.now()}_${i}`,
        seq: 0,
        ts: Date.now(),
        type: "release.created" as const,
        release: p,
      }));
    }
  } catch (err) {
    console.warn(`[events] hub publish failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // (2) Webhook fan-out. Independent of hub publish success.
  // Only runs when both bindings are present (production cron / batch path).
  if (env.WEBHOOK_DELIVERY_QUEUE && env.DB) {
    const db = createDb(env.DB);
    await expandAndEnqueue({
      events: hubEvents,
      eventOwners,
      loadSubscriptions: (orgIds) => matchWebhookSubscriptions(db, orgIds),
      queue: env.WEBHOOK_DELIVERY_QUEUE,
    });
  }
}
