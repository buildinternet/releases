import type { DeliveryMessage } from "../../api/src/webhooks/types.js";

export interface Env {
  DB: D1Database;
  WEBHOOK_DELIVERIES_AE: AnalyticsEngineDataset;
  WEBHOOK_HMAC_MASTER: string;
  PER_SUB_RATE_LIMITER: RateLimit;
  DELIVERY_TIMEOUT_MS: string;
  AUTO_DISABLE_THRESHOLD: string;
}

export default {
  async queue(batch: MessageBatch<DeliveryMessage>, _env: Env): Promise<void> {
    if (batch.queue === "webhook-dlq") {
      for (const msg of batch.messages) {
        console.warn(`[webhook-dlq] ${msg.body.subscriptionId} ${msg.body.event.release.id}`);
        msg.ack();
      }
      return;
    }
    for (const msg of batch.messages) {
      msg.ack();
    }
  },
};
