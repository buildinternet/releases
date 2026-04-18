import type { ReleaseEvent } from "../events/types.js";

/**
 * One queue message represents one delivery attempt for one subscription.
 * The event payload is embedded so the consumer doesn't need to re-fetch
 * from D1 (which would race with deletes anyway).
 */
export interface DeliveryMessage {
  subscriptionId: string;
  /** Subscriber URL captured at fan-out time so URL rotation doesn't strand in-flight messages. */
  url: string;
  /** Subscription's secret_version at fan-out time; consumer uses this in HMAC derivation. */
  secretVersion: number;
  event: ReleaseEvent;
  /** 1-indexed; queue retry handler is responsible for incrementing this. Used for AE attempt_number. */
  attempt: number;
}
