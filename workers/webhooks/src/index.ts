import type { DeliveryMessage } from "../../api/src/webhooks/types.js";

export interface Env {
  DB: D1Database;
  WEBHOOK_DELIVERIES_AE: AnalyticsEngineDataset;
  WEBHOOK_HMAC_MASTER: string;
  PER_SUB_RATE_LIMITER: { limit: (opts: { key: string }) => Promise<{ success: boolean }> };
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
    // Real delivery handler — implemented in Tasks 14-16.
    for (const msg of batch.messages) {
      msg.ack();
    }
  },
};
