import { createDb } from "./db.js";
import {
  getWebhookSubscriptionById,
  updateWebhookSubscriptionSummary,
  setWebhookSubscriptionEnabled,
} from "./queries.js";
import { deliver } from "./deliver.js";
import { writeDeliveryAttempt, type DeliveryAttempt, type Outcome } from "./ae.js";
import type { DeliveryMessage } from "../../api/src/webhooks/types.js";

export const DLQ_QUEUE = "webhook-dlq";

export interface Env {
  DB: D1Database;
  WEBHOOK_DELIVERIES_AE: AnalyticsEngineDataset;
  WEBHOOK_HMAC_MASTER: { get(): Promise<string | null> };
  PER_SUB_RATE_LIMITER: RateLimit;
  DELIVERY_TIMEOUT_MS: string;
  AUTO_DISABLE_THRESHOLD: string;
}

/** Build a synthetic AE attempt for branches with no live HTTP result (skipped/dlq/auto_disabled). */
function syntheticAttempt(
  body: DeliveryMessage,
  attempts: number,
  outcome: Outcome,
  errorMessage: string | null = null,
): DeliveryAttempt {
  return {
    subscriptionId: body.subscriptionId,
    eventId: body.event.id,
    outcome,
    httpStatus: 0,
    latencyMs: 0,
    attempt: attempts,
    errorMessage,
    errorCode: null,
  };
}

export default {
  async queue(batch: MessageBatch<DeliveryMessage>, env: Env): Promise<void> {
    if (batch.queue === DLQ_QUEUE) {
      for (const msg of batch.messages) {
        console.warn(
          `[webhook-dlq] sub=${msg.body.subscriptionId} release=${msg.body.event.release.id} attempts=${msg.attempts}`,
        );
        writeDeliveryAttempt(
          env.WEBHOOK_DELIVERIES_AE,
          syntheticAttempt(msg.body, msg.attempts, "dlq"),
        );
        msg.ack();
      }
      return;
    }

    const db = createDb(env.DB);
    const timeoutMs = parseInt(env.DELIVERY_TIMEOUT_MS, 10) || 10000;
    const threshold = parseInt(env.AUTO_DISABLE_THRESHOLD, 10) || 50;
    const masterKey = await env.WEBHOOK_HMAC_MASTER.get();
    if (!masterKey) {
      // Without the master we can't sign; retry each message so the queue can
      // redeliver once the binding is fixed.
      for (const msg of batch.messages) msg.retry();
      return;
    }

    for (const msg of batch.messages) {
      const body = msg.body;

      // oxlint-disable-next-line no-await-in-loop -- webhook delivery; per-subscriber rate limiter check must be sequential
      const limit = await env.PER_SUB_RATE_LIMITER.limit({ key: body.subscriptionId });
      if (!limit.success) {
        msg.retry({ delaySeconds: 6 });
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- webhook delivery; subscription lookup per message must be sequential
      const sub = await getWebhookSubscriptionById(db, body.subscriptionId);
      if (!sub || !sub.enabled) {
        writeDeliveryAttempt(
          env.WEBHOOK_DELIVERIES_AE,
          syntheticAttempt(body, msg.attempts, "skipped", sub ? "disabled" : "not_found"),
        );
        msg.ack();
        continue;
      }

      // oxlint-disable-next-line no-await-in-loop -- webhook delivery; each subscriber delivered sequentially with retry/backoff
      const result = await deliver(body, { masterKey, timeoutMs });

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
        // oxlint-disable-next-line no-await-in-loop -- webhook delivery; success summary update per-subscriber
        await updateWebhookSubscriptionSummary(db, body.subscriptionId, { kind: "success", at });
        msg.ack();
      } else {
        // oxlint-disable-next-line no-await-in-loop -- webhook delivery; failure summary update per-subscriber
        await updateWebhookSubscriptionSummary(db, body.subscriptionId, {
          kind: "error",
          at,
          message: result.errorMessage ?? "unknown",
        });
        // oxlint-disable-next-line no-await-in-loop -- webhook delivery; re-fetch subscription to check auto-disable threshold
        const fresh = await getWebhookSubscriptionById(db, body.subscriptionId);
        if (fresh && fresh.consecutiveFailures >= threshold) {
          // oxlint-disable-next-line no-await-in-loop -- webhook delivery; auto-disable subscription after threshold failures
          await setWebhookSubscriptionEnabled(
            db,
            body.subscriptionId,
            false,
            `auto-disabled after ${fresh.consecutiveFailures} consecutive failures`,
          );
          writeDeliveryAttempt(
            env.WEBHOOK_DELIVERIES_AE,
            syntheticAttempt(body, msg.attempts, "auto_disabled"),
          );
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
