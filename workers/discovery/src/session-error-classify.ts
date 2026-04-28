/**
 * Pure helpers for classifying terminal events from a managed-agents session
 * stream. Lifted into its own module so unit tests can import it without
 * pulling in `cloudflare:workers` (which the rest of `managed-agents-session.ts`
 * depends on).
 */

/**
 * Classification attached to a `session:error` StatusHub event so downstream
 * consumers (web Sessions tab, CLI exit codes) can distinguish managed-agents
 * service incidents from our-side problems without parsing free-text strings.
 *
 * `retryCount` is the count of provider `session.error` events the run
 * observed before terminal — useful for incident-burst detection.
 */
export interface SessionErrorClassification {
  errorSource: "provider" | "us";
  errorType?: string;
  stopReason?: string;
  retryCount?: number;
  message: string;
}

/**
 * Pull the typed error off a `session.error` SDK event into a
 * StatusHub-shaped classification. Always `errorSource: "provider"` — by
 * definition the SDK only emits these from upstream.
 */
export function classifyProviderSessionError(event: unknown): SessionErrorClassification | null {
  const e = event as { type?: string; error?: { type?: string; message?: string } } | null;
  if (!e || e.type !== "session.error") return null;
  const errorType = e.error?.type;
  const message = e.error?.message ?? "Unknown managed-agents error";
  return {
    errorSource: "provider",
    ...(errorType ? { errorType } : {}),
    message,
  };
}

/**
 * True when a `session.status_idle` event signals the agent ran out of retries
 * (i.e. an upstream incident or `max_iterations` hit), as opposed to ending
 * normally or pausing for user input.
 */
export function isRetriesExhaustedIdle(event: unknown): boolean {
  const e = event as { type?: string; stop_reason?: { type?: string } } | null;
  return e?.type === "session.status_idle" && e.stop_reason?.type === "retries_exhausted";
}
