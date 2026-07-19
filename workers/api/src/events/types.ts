/**
 * Re-export of the release-event wire types + helpers. Implementation lives in
 * `@releases/core-internal/release-event` so API fan-out and the webhooks
 * delivery worker share one shape (via DeliveryMessage).
 */
export {
  EVENT_BUFFER_SIZE,
  SEQ_PAD_WIDTH,
  newEventId,
  padSeq,
  type ReleaseEvent,
  type ReleaseEventPayload,
} from "@releases/core-internal/release-event";
