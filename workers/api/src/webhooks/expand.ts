import type { ReleaseEvent } from "../events/types.js";
import type { WebhookSubscription } from "@releases/core-internal/schema";
import type { DeliveryMessage } from "./types.js";

/**
 * Pure function: expand (events × subscriptions) → DeliveryMessage[].
 * The caller provides `eventOwner` which maps an event to its (orgId, sourceId)
 * — the publisher knows this from the inserted release row.
 */
export function expand(
  events: ReleaseEvent[],
  subscriptions: WebhookSubscription[],
  eventOwner: (e: ReleaseEvent) => { orgId: string; sourceId: string },
): DeliveryMessage[] {
  const out: DeliveryMessage[] = [];
  for (const event of events) {
    const owner = eventOwner(event);
    for (const sub of subscriptions) {
      if (sub.orgId !== owner.orgId) continue;
      if (sub.sourceId !== null && sub.sourceId !== owner.sourceId) continue;
      out.push({
        subscriptionId: sub.id,
        url: sub.url,
        secretVersion: sub.secretVersion,
        event,
        attempt: 1,
      });
    }
  }
  return out;
}
