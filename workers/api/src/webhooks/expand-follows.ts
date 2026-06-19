import type { ReleaseEvent } from "../events/types.js";
import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
import type { UserFollowTargets } from "./follows-match.js";
import { releaseMatchesFollows } from "./follows-match.js";
import type { DeliveryMessage } from "./types.js";

export interface EventOwnerWithProduct {
  orgId: string;
  sourceId: string;
  productId: string | null;
}

/**
 * Fan-out for `scope = follows` subscriptions: one message per (event × sub)
 * when the sub owner's follows match the release's org/product.
 */
export function expandFollows(
  events: ReleaseEvent[],
  subscriptions: WebhookSubscription[],
  eventOwner: (e: ReleaseEvent) => EventOwnerWithProduct | null,
  followsByUserId: Map<string, UserFollowTargets>,
): DeliveryMessage[] {
  const out: DeliveryMessage[] = [];
  for (const event of events) {
    const owner = eventOwner(event);
    if (!owner) continue;
    for (const sub of subscriptions) {
      if (sub.scope !== "follows" || !sub.userId) continue;
      const follows = followsByUserId.get(sub.userId);
      if (!follows || !releaseMatchesFollows(owner, follows)) continue;
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
