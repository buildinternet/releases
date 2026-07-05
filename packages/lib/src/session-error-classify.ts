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
  /**
   * `fatal` — the session can't continue (auth, billing, model overloaded after
   * full retry budget on a session-level operation).
   * `soft` — a sub-task ran out of retries (skill setup, MCP fetch) but the
   * conversation is still alive. Log + accumulate, don't terminate the loop.
   * Multi-agent sessions in particular fire `session.error` for transient
   * skill-load failures while the agent goes on to make progress via fallbacks.
   */
  severity: "fatal" | "soft";
}

/**
 * Pull the typed error off a `session.error` SDK event into a
 * StatusHub-shaped classification. Always `errorSource: "provider"` — by
 * definition the SDK only emits these from upstream.
 */
export function classifyProviderSessionError(event: unknown): SessionErrorClassification | null {
  const e = event as {
    type?: string;
    error?: {
      type?: string;
      message?: string;
      retry_status?: { type?: string };
    };
  } | null;
  if (!e || e.type !== "session.error") return null;
  const errorType = e.error?.type;
  const message = e.error?.message ?? "Unknown managed-agents error";
  // `retry_status: exhausted` on an `unknown_error` historically means a
  // sub-task (skill setup, MCP fetch) gave up — the session continues. Other
  // typed errors (rate limits, billing, auth) are session-fatal.
  const severity: "fatal" | "soft" =
    errorType === "unknown_error" && e.error?.retry_status?.type === "exhausted" ? "soft" : "fatal";
  return {
    errorSource: "provider",
    ...(errorType ? { errorType } : {}),
    message,
    severity,
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

/**
 * Build the "our-side fatal" classification for a terminal failure whose cause
 * is a known error category (a `manage_source` fetch tool error). Shared by the
 * agent-path "all tool calls failed" branch and the deterministic-update "all
 * source fetches failed" branch so the two can't drift. Returns `undefined`
 * when the category is unknown — an unclassified failure, which `fail()`
 * defaults to `errorSource: "us"` anyway.
 */
export function classifyUsFatal(
  category: string | undefined,
  message: string,
): SessionErrorClassification | undefined {
  return category
    ? { errorSource: "us", errorType: category, message, severity: "fatal" }
    : undefined;
}
