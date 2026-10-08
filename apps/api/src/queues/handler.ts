import { logEvent } from "@releases/lib/log-event";
import { processDigestDeliveryMessage, type DigestConsumerEnv } from "./digest-consumer.js";
import {
  processCollectionDigestMessage,
  type SendCollectionDigestsEnv,
} from "../cron/send-collection-digests.js";
import {
  processReleaseFanoutMessage,
  type ReleaseFanoutConsumerEnv,
} from "./release-fanout-consumer.js";
import {
  DIGEST_DELIVERY_QUEUE,
  RELEASE_EVENTS_QUEUE,
  isCollectionDigestMessage,
  type DigestQueueMessage,
  type ReleaseFanoutMessage,
} from "./types.js";

export type QueueHandlerEnv = DigestConsumerEnv &
  SendCollectionDigestsEnv &
  ReleaseFanoutConsumerEnv;

export async function handleQueueBatch(
  batch: MessageBatch<DigestQueueMessage | ReleaseFanoutMessage>,
  env: QueueHandlerEnv,
): Promise<void> {
  if (batch.queue === DIGEST_DELIVERY_QUEUE) {
    for (const msg of batch.messages as MessageBatch<DigestQueueMessage>["messages"]) {
      const body = msg.body;
      // oxlint-disable-next-line no-await-in-loop -- digest delivery; per-recipient send must be sequential
      const outcome = isCollectionDigestMessage(body)
        ? await processCollectionDigestMessage(env, body)
        : await processDigestDeliveryMessage(env, body);
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
