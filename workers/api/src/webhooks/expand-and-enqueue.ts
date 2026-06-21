import type { ReleaseEvent } from "../events/types.js";
import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
import { expand } from "./expand.js";
import { expandFollows } from "./expand-follows.js";
import type { WebhookEventOwner } from "./subscription-match.js";
import type { UserFollowTargets } from "./follows-match.js";
import type { DeliveryMessage } from "./types.js";
import { logEvent } from "@releases/lib/log-event";

export interface ExpandAndEnqueueArgs {
  events: ReleaseEvent[];
  /** Maps release.id to its owning org/source/product. */
  eventOwners: Map<string, WebhookEventOwner>;
  loadOrgSubscriptions: (orgIds: string[]) => Promise<WebhookSubscription[]>;
  loadFollowsSubscriptions?: () => Promise<WebhookSubscription[]>;
  loadFollowTargetsForUsers?: (userIds: string[]) => Promise<Map<string, UserFollowTargets>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  queue: { sendBatch: (messages: { body: DeliveryMessage }[]) => Promise<any> };
  /** When true, rethrow after logging so queue consumers can retry. */
  throwOnError?: boolean;
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

    const messages: DeliveryMessage[] = [];

    if (orgIds.length > 0) {
      const orgSubs = await args.loadOrgSubscriptions(orgIds);
      if (orgSubs.length > 0) {
        messages.push(
          ...expand(args.events, orgSubs, (e) => args.eventOwners.get(e.release.id) ?? null),
        );
      }
    }

    if (args.loadFollowsSubscriptions && args.loadFollowTargetsForUsers) {
      const followsSubs = await args.loadFollowsSubscriptions();
      if (followsSubs.length > 0) {
        const userIds = [
          ...new Set(followsSubs.map((s) => s.userId).filter((x): x is string => !!x)),
        ];
        const followsByUser = await args.loadFollowTargetsForUsers(userIds);
        messages.push(
          ...expandFollows(
            args.events,
            followsSubs,
            (e) => {
              const owner = args.eventOwners.get(e.release.id);
              return owner ?? null;
            },
            followsByUser,
          ),
        );
      }
    }

    if (messages.length === 0) return;
    for (let i = 0; i < messages.length; i += QUEUE_BATCH_LIMIT) {
      const chunk = messages.slice(i, i + QUEUE_BATCH_LIMIT);
      // oxlint-disable-next-line no-await-in-loop -- Cloudflare Queue chunked sendBatch (API batch size limit)
      await args.queue.sendBatch(chunk.map((body) => ({ body })));
    }
  } catch (err) {
    logEvent("warn", {
      component: "webhooks",
      event: "expand-and-enqueue-failed",
      err: err instanceof Error ? err : String(err),
    });
    if (args.throwOnError) throw err;
  }
}
