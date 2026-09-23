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
