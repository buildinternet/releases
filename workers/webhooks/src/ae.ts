export type Outcome = "success" | "retry" | "perm_fail" | "skipped" | "dlq" | "auto_disabled";

export type ErrorCode = "network" | "timeout" | "subscriber_4xx" | "subscriber_5xx";

export interface DeliveryAttempt {
  subscriptionId: string;
  eventId: string;
  outcome: Outcome;
  httpStatus: number;
  latencyMs: number;
  attempt: number;
  errorMessage: string | null;
  errorCode: ErrorCode | null;
  /** Delivery format — "json" (signed raw event) or "slack" (Block Kit). Lets queries segment by webhook type. */
  format: string;
  /** Non-secret Slack workspace+app id (`T../B..`) for slack deliveries, else "". `COUNT(DISTINCT)` → unique Slack apps. */
  slackApp: string;
}

/**
 * Write one data point to the webhook_deliveries AE dataset.
 * Schema (blobs are append-only — existing queries pin blob1..4):
 *   indexes: [subscription_id]
 *   blobs:   [event_id, error_message, error_code, outcome, format, slack_app]
 *   doubles: [http_status, latency_ms, attempt_number]
 *
 * Example AE SQL (segment + count):
 *   -- Slack hooks successfully sent, last 24h:
 *   SELECT count() FROM webhook_deliveries
 *   WHERE blob5 = 'slack' AND blob4 = 'success' AND timestamp > NOW() - INTERVAL '1' DAY
 *   -- Unique Slack apps delivered to:
 *   SELECT count(DISTINCT blob6) FROM webhook_deliveries WHERE blob5 = 'slack' AND blob6 != ''
 *   -- Deliveries broken down by webhook type:
 *   SELECT blob5 AS format, blob4 AS outcome, count() FROM webhook_deliveries GROUP BY format, outcome
 */
export function writeDeliveryAttempt(ds: AnalyticsEngineDataset, attempt: DeliveryAttempt): void {
  ds.writeDataPoint({
    indexes: [attempt.subscriptionId],
    blobs: [
      attempt.eventId,
      attempt.errorMessage ?? "",
      attempt.errorCode ?? "",
      attempt.outcome,
      attempt.format,
      attempt.slackApp,
    ],
    doubles: [attempt.httpStatus, attempt.latencyMs, attempt.attempt],
  });
}
