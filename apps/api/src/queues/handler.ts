import { logEvent } from "@releases/lib/log-event";
import { processDigestDeliveryMessage, type DigestConsumerEnv } from "./digest-consumer.js";
import {
  processReleaseFanoutMessage,
  type ReleaseFanoutConsumerEnv,
} from "./release-fanout-consumer.js";
import {
  DIGEST_DELIVERY_QUEUE,
  RELEASE_EVENTS_QUEUE,
  type DigestDeliveryMessage,
  type ReleaseFanoutMessage,
} from "./types.js";

export type QueueHandlerEnv = DigestConsumerEnv & ReleaseFanoutConsumerEnv;

export async function handleQueueBatch(
  batch: MessageBatch<DigestDeliveryMessage | ReleaseFanoutMessage>,
  env: QueueHandlerEnv,
): Promise<void> {
  if (batch.queue === DIGEST_DELIVERY_QUEUE) {
    for (const msg of batch.messages as MessageBatch<DigestDeliveryMessage>["messages"]) {
      // oxlint-disable-next-line no-await-in-loop -- digest delivery; per-recipient send must be sequential
      const outcome = await processDigestDeliveryMessage(env, msg.body);
      if (outcome === "ack") msg.ack();
      else msg.retry();
    }
    return;
  }

  if (batch.queue === RELEASE_EVENTS_QUEUE) {
    for (const msg of batch.messages as MessageBatch<ReleaseFanoutMessage>["messages"]) {
      try {
        // oxlint-disable-next-line no-await-in-loop -- release fan-out; expand per message sequentially
        await processReleaseFanoutMessage(env, msg.body);
        msg.ack();
      } catch (err) {
        logEvent("warn", {
          component: "release-events-queue",
          event: "fanout-failed",
          attempts: msg.attempts,
          err: err instanceof Error ? err : String(err),
        });
        msg.retry();
      }
    }
    return;
  }

  logEvent("warn", {
    component: "queues",
    event: "unknown-queue",
    queue: batch.queue,
    count: batch.messages.length,
  });
}
