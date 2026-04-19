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
}

/**
 * Write one data point to the webhook_deliveries AE dataset.
 * Schema:
 *   indexes: [subscription_id]
 *   blobs:   [event_id, error_message, error_code, outcome]
 *   doubles: [http_status, latency_ms, attempt_number]
 */
export function writeDeliveryAttempt(ds: AnalyticsEngineDataset, attempt: DeliveryAttempt): void {
  ds.writeDataPoint({
    indexes: [attempt.subscriptionId],
    blobs: [attempt.eventId, attempt.errorMessage ?? "", attempt.errorCode ?? "", attempt.outcome],
    doubles: [attempt.httpStatus, attempt.latencyMs, attempt.attempt],
  });
}
