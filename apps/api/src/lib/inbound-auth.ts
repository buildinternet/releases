import { logEvent } from "@releases/lib/log-event";

export type InboundAuthRejectReason = "missing" | "mismatch" | "secret-unbound";

/**
 * Classify and log a rejected inbound provider webhook (`/v1/inbound/<provider>`)
 * so a broken secret shows up as an app event, not only as a 401 in the request
 * logs. Logs the reason only — never the presented token or signature.
 */
export function logInboundAuthRejected(
  component: string,
  secret: string | null | undefined,
  presented: string | null | undefined,
): InboundAuthRejectReason {
  const reason: InboundAuthRejectReason = !secret
    ? "secret-unbound"
    : presented
      ? "mismatch"
      : "missing";
  logEvent(reason === "secret-unbound" ? "error" : "warn", {
    component,
    event: "auth-rejected",
    reason,
  });
  return reason;
}
