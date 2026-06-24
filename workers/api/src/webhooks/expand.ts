import type { ReleaseEvent } from "../events/types.js";
import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
import type { DeliveryMessage } from "./types.js";
import { orgSubscriptionMatchesEvent, type WebhookEventOwner } from "./subscription-match.js";

/**
 * Pure function: expand (events × subscriptions) → DeliveryMessage[].
 * The caller provides `eventOwner` which maps an event to its owning org/source/product/type
 * — the publisher knows this from the inserted release row.
 */
export function expand(
  events: ReleaseEvent[],
  subscriptions: WebhookSubscription[],
  eventOwner: (e: ReleaseEvent) => WebhookEventOwner | null,
): DeliveryMessage[] {
  const out: DeliveryMessage[] = [];
  for (const event of events) {
    const owner = eventOwner(event);
    if (!owner) continue;
    for (const sub of subscriptions) {
      if (!orgSubscriptionMatchesEvent(sub, owner)) continue;
      out.push({
        subscriptionId: sub.id,
        url: sub.url,
        secretVersion: sub.secretVersion,
        format: sub.format,
        event,
        attempt: 1,
      });
    }
  }
  return out;
}
