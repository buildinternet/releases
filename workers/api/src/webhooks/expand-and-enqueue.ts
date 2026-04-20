import type { ReleaseEvent } from "../events/types.js";
import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
import { expand } from "./expand.js";
import type { DeliveryMessage } from "./types.js";

export interface ExpandAndEnqueueArgs {
  events: ReleaseEvent[];
  /** Maps release.id to its (orgId, sourceId). Built by the caller from the inserted rows. */
  eventOwners: Map<string, { orgId: string; sourceId: string }>;
  loadSubscriptions: (orgIds: string[]) => Promise<WebhookSubscription[]>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queue: { sendBatch: (messages: { body: DeliveryMessage }[]) => Promise<any> };
}

const QUEUE_BATCH_LIMIT = 100;

/**
 * Fan-out side-effect: load matching subscriptions, expand into messages, sendBatch in chunks.
 * Never throws — queue/D1 failures are logged. Caller should already be inside ctx.waitUntil().
 */
export async function expandAndEnqueue(args: ExpandAndEnqueueArgs): Promise<void> {
  if (args.events.length === 0) return;
  try {
    const orgIds = [
      ...new Set(
        args.events
          .map((e) => args.eventOwners.get(e.release.id)?.orgId)
          .filter((x): x is string => !!x),
      ),
    ];
    if (orgIds.length === 0) return;
    const subs = await args.loadSubscriptions(orgIds);
    if (subs.length === 0) return;
    const messages = expand(args.events, subs, (e) => {
      const owner = args.eventOwners.get(e.release.id);
      if (!owner) return { orgId: "", sourceId: "" };
      return owner;
    });
    if (messages.length === 0) return;
    for (let i = 0; i < messages.length; i += QUEUE_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + QUEUE_BATCH_LIMIT);
      await args.queue.sendBatch(chunk.map((body) => ({ body })));
    }
  } catch (err) {
    console.warn(
      `[webhooks] expandAndEnqueue failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
