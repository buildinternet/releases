import type { ReleaseEvent } from "../events/types.js";

/** Cloudflare Queue name — per-recipient follow digest send. */
export const DIGEST_DELIVERY_QUEUE = "digest-delivery";

/** Cloudflare Queue name — release.created fan-out before webhook-delivery. */
export const RELEASE_EVENTS_QUEUE = "release-events";

/** One digest email for one user from one cron run. */
export interface DigestDeliveryMessage {
  userId: string;
  cadence: "daily" | "weekly";
  /** ISO timestamp — cron run upper bound (`before`). */
  runStart: string;
  /** ISO timestamp or null — recipient watermark at enqueue time (`after`). */
  after: string | null;
}

/**
 * One collection weekly digest email for one subscriber (#2459). Rides the same
 * queue as the follows digest; the consumer tells them apart by `kind`.
 */
export interface CollectionDigestDeliveryMessage {
  kind: "collection-digest";
  userId: string;
  collectionId: string;
  /** ET-Monday week key (YYYY-MM-DD) of the digest to send. */
  weekStart: string;
}

/** Everything the digest-delivery queue carries. Follows messages predate `kind`. */
export type DigestQueueMessage = DigestDeliveryMessage | CollectionDigestDeliveryMessage;

export function isCollectionDigestMessage(
  m: DigestQueueMessage,
): m is CollectionDigestDeliveryMessage {
  return (m as { kind?: unknown }).kind === "collection-digest";
}

export interface ReleaseFanoutOwner {
  releaseId: string;
  orgId: string;
  sourceId: string;
  productId: string | null;
  releaseType: "feature" | "rollup";
}

/** One publish batch — consumer expands into webhook-delivery messages. */
export interface ReleaseFanoutMessage {
  events: ReleaseEvent[];
  owners: ReleaseFanoutOwner[];
}
