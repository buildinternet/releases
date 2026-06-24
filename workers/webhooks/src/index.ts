import { createDb } from "./db.js";
import {
  getWebhookSubscriptionById,
  getWebhookSubscriptionLabels,
  updateWebhookSubscriptionSummary,
  setWebhookSubscriptionEnabled,
} from "./queries.js";
import { formatDlqAlert, type DlqEntry, type SubscriptionLabel } from "./alert-format.js";
import { notifyAutoDisabledSubscription } from "./auto-disable-notify.js";
import { deliver } from "./deliver.js";
import { writeDeliveryAttempt, type DeliveryAttempt, type Outcome } from "./ae.js";
import { slackWebhookAppId } from "./slack-app-id.js";
import type { DeliveryMessage } from "../../api/src/webhooks/types.js";
import { sendWebhookAlert, type EmailEnv } from "./email.js";
import { logEvent } from "@releases/lib/log-event";
import { getSecret } from "@releases/lib/secrets";
import {
  autoDisableReason,
  shouldAutoDisableWebhook,
} from "@releases/core-internal/webhook-resilience";

export const DLQ_QUEUE = "webhook-dlq";

export interface Env {
  DB: D1Database;
  WEBHOOK_DELIVERIES_AE: AnalyticsEngineDataset;
  WEBHOOK_HMAC_MASTER: { get(): Promise<string | null> };
  PER_SUB_RATE_LIMITER: RateLimit;
  DELIVERY_TIMEOUT_MS: string;
  AUTO_DISABLE_THRESHOLD: string;
  // Email alert bindings (see workers/webhooks/src/email.ts).
  // Absent → alert emails silently no-op.
  SEND_EMAIL?: { send(message: unknown): Promise<void> };
  EMAIL_NOTIFY_ENABLED?: string;
  EMAIL_NOTIFY_TO?: string;
  EMAIL_FROM?: string;
  /** Web origin for user-facing links in auto-pause emails. */
  WEB_BASE_URL?: string;
}

/** Telemetry dimensions derived from the message: webhook type + (for slack) the non-secret app id. */
function deliveryDims(body: DeliveryMessage): { format: string; slackApp: string } {
  const format = body.format ?? "json";
  return { format, slackApp: format === "slack" ? slackWebhookAppId(body.url) : "" };
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
    ...deliveryDims(body),
  };
}

export default {
  /**
   * Minimal HTTP surface. This worker is primarily the queue consumer below and
   * has no inbound HTTP routes, so any request used to throw (1101 → 500). Expose
   * a basic liveness endpoint for uptime monitoring (status.releases.sh) plus a
   * deny-all robots.txt. Every response carries `X-Robots-Tag: noindex` so this
   * machine endpoint is never indexed.
   */
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const noindex = {
      "X-Robots-Tag": "noindex, nofollow",
      "X-Content-Type-Options": "nosniff",
    };
    if (req.method === "GET" && url.pathname === "/robots.txt") {
      return new Response("User-agent: *\nDisallow: /\n", {
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "public, max-age=3600",
          ...noindex,
        },
      });
    }
    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/")) {
      return Response.json(
        { ok: true, service: "releases-webhooks" },
        { headers: { "Cache-Control": "no-store", ...noindex } },
      );
    }
    return Response.json({ error: "not_found" }, { status: 404, headers: noindex });
  },

  async queue(
    batch: MessageBatch<DeliveryMessage>,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    const alertEnv: EmailEnv = {
      SEND_EMAIL: env.SEND_EMAIL,
      EMAIL_NOTIFY_ENABLED: env.EMAIL_NOTIFY_ENABLED,
      EMAIL_NOTIFY_TO: env.EMAIL_NOTIFY_TO,
      EMAIL_FROM: env.EMAIL_FROM,
    };

    if (batch.queue === DLQ_QUEUE) {
      // Aggregate per subscription for a compact summary email.
      const bySubId = new Map<string, { count: number; lastError: string | null }>();
      for (const msg of batch.messages) {
        logEvent("warn", {
          component: "webhook-dlq",
          event: "max-retries-exceeded",
          subscriptionId: msg.body.subscriptionId,
          releaseId: msg.body.event.release.id,
          attempts: msg.attempts,
        });
        writeDeliveryAttempt(
          env.WEBHOOK_DELIVERIES_AE,
          syntheticAttempt(msg.body, msg.attempts, "dlq"),
        );
        msg.ack();

        const entry = bySubId.get(msg.body.subscriptionId) ?? { count: 0, lastError: null };
        entry.count += 1;
        // Delivery messages don't carry the last error at DLQ time — use a placeholder.
        entry.lastError = "max retries exceeded";
        bySubId.set(msg.body.subscriptionId, entry);
      }

      // Send one alert per DLQ batch — DLQ batches are infrequent; no dedup needed.
      if (bySubId.size > 0) {
        // Resolve subscription URLs + owning orgs inside waitUntil so the DB
        // round-trip stays off the synchronous ack path; fail open to the bare
        // id on any lookup error.
        ctx.waitUntil(
          (async () => {
            let labels = new Map<string, SubscriptionLabel>();
            try {
              const db = createDb(env.DB);
              const resolved = await getWebhookSubscriptionLabels(db, [...bySubId.keys()]);
              labels = new Map(resolved.map((r) => [r.id, r]));
            } catch (err) {
              logEvent("warn", { component: "webhook-dlq", event: "resolve-labels-failed", err });
            }
            const entries: DlqEntry[] = [...bySubId].map(([subId, info]) => ({
              subId,
              count: info.count,
              lastError: info.lastError,
              label: labels.get(subId) ?? null,
            }));
            const { subject, body } = formatDlqAlert(entries);
            await sendWebhookAlert(alertEnv, subject, body);
          })().catch(() => undefined),
        );
      }

      return;
    }

    const db = createDb(env.DB);
    const timeoutMs = parseInt(env.DELIVERY_TIMEOUT_MS, 10) || 10000;
    const threshold = parseInt(env.AUTO_DISABLE_THRESHOLD, 10) || 50;
    const masterKey = await getSecret(env.WEBHOOK_HMAC_MASTER);
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
        ...deliveryDims(body),
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
        if (fresh && shouldAutoDisableWebhook(fresh, threshold)) {
          const reason = autoDisableReason(fresh);
          // oxlint-disable-next-line no-await-in-loop -- webhook delivery; auto-disable subscription after threshold failures
          const flipped = await setWebhookSubscriptionEnabled(
            db,
            body.subscriptionId,
            false,
            reason,
          );
          writeDeliveryAttempt(
            env.WEBHOOK_DELIVERIES_AE,
            syntheticAttempt(body, msg.attempts, "auto_disabled"),
          );
          // Notify once per auto-disable event. Gated on the actual enabled→disabled
          // transition so concurrent batch messages past the threshold don't spam.
          if (flipped) {
            ctx.waitUntil(
              notifyAutoDisabledSubscription(
                db,
                { ...alertEnv, WEB_BASE_URL: env.WEB_BASE_URL },
                fresh,
                reason,
                result.errorMessage ?? null,
              ).catch(() => undefined),
            );
          }
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
