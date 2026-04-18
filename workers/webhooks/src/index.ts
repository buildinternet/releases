import { createDb } from "./db.js";
import {
  getWebhookSubscriptionById,
  updateWebhookSubscriptionSummary,
  setWebhookSubscriptionEnabled,
} from "./queries.js";
import { deliver } from "./deliver.js";
import { writeDeliveryAttempt } from "./ae.js";
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
  async queue(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
    if (batch.queue === "webhook-dlq") {
      for (const msg of batch.messages) {
        console.warn(
          `[webhook-dlq] sub=${msg.body.subscriptionId} release=${msg.body.event.release.id} attempts=${msg.attempts}`,
        );
        writeDeliveryAttempt(env.WEBHOOK_DELIVERIES_AE, {
          subscriptionId: msg.body.subscriptionId,
          eventId: msg.body.event.id,
          outcome: "dlq",
          httpStatus: 0,
          latencyMs: 0,
          attempt: msg.attempts,
          errorMessage: null,
          errorCode: null,
        });
        msg.ack();
      }
      return;
    }

    const db = createDb(env.DB);
    const timeoutMs = parseInt(env.DELIVERY_TIMEOUT_MS, 10) || 10000;
    const threshold = parseInt(env.AUTO_DISABLE_THRESHOLD, 10) || 50;

    for (const msg of batch.messages) {
      const body = msg.body;

      const limit = await env.PER_SUB_RATE_LIMITER.limit({ key: body.subscriptionId });
      if (!limit.success) {
        msg.retry({ delaySeconds: 6 });
        continue;
      }

      const sub = await getWebhookSubscriptionById(db, body.subscriptionId);
      if (!sub || !sub.enabled) {
        writeDeliveryAttempt(env.WEBHOOK_DELIVERIES_AE, {
          subscriptionId: body.subscriptionId,
          eventId: body.event.id,
          outcome: "skipped",
          httpStatus: 0,
          latencyMs: 0,
          attempt: msg.attempts,
          errorMessage: sub ? "disabled" : "not_found",
          errorCode: null,
        });
        msg.ack();
        continue;
      }

      const result = await deliver(body, { masterKey: env.WEBHOOK_HMAC_MASTER, timeoutMs });

      writeDeliveryAttempt(env.WEBHOOK_DELIVERIES_AE, {
        subscriptionId: body.subscriptionId,
        eventId: body.event.id,
        outcome: result.outcome,
        httpStatus: result.httpStatus,
        latencyMs: result.latencyMs,
        attempt: msg.attempts,
        errorMessage: result.errorMessage,
        errorCode: result.errorCode,
      });

      const at = new Date().toISOString();
      if (result.outcome === "success") {
        await updateWebhookSubscriptionSummary(db, body.subscriptionId, { kind: "success", at });
        msg.ack();
      } else {
        await updateWebhookSubscriptionSummary(db, body.subscriptionId, {
          kind: "error",
          at,
          message: result.errorMessage ?? "unknown",
        });
        const fresh = await getWebhookSubscriptionById(db, body.subscriptionId);
        if (fresh && fresh.consecutiveFailures >= threshold) {
          await setWebhookSubscriptionEnabled(db, body.subscriptionId, false, `auto-disabled after ${fresh.consecutiveFailures} consecutive failures`);
          writeDeliveryAttempt(env.WEBHOOK_DELIVERIES_AE, {
            subscriptionId: body.subscriptionId,
            eventId: body.event.id,
            outcome: "auto_disabled",
            httpStatus: 0,
            latencyMs: 0,
            attempt: msg.attempts,
            errorMessage: null,
            errorCode: null,
          });
        }
        if (result.outcome === "perm_fail") {
          msg.ack();
        } else {
          msg.retry();
        }
      }
    }
  },
};
