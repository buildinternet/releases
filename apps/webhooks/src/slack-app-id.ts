/**
 * Extract a non-secret Slack workspace+app identifier from an incoming-webhook
 * URL, for delivery telemetry. A Slack incoming-webhook URL looks like
 * `https://hooks.slack.com/services/T<team>/B<app>/<secret>`; we return the
 * `T<team>/B<app>` pair — the workspace + app that identify the destination —
 * and NEVER the secret third path segment. Returns "" for non-Slack hosts,
 * the workflow-trigger form (`/triggers/...`), or any URL we can't parse into
 * the `/services/T../B../secret` shape.
 *
 * Counting `COUNT(DISTINCT)` over this dimension in the `webhook_deliveries` AE
 * dataset yields the number of unique Slack apps releases are delivered to.
 */
const SLACK_WEBHOOK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);

export function slackWebhookAppId(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "";
  }
  if (!SLACK_WEBHOOK_HOSTS.has(parsed.hostname.toLowerCase())) return "";
  const parts = parsed.pathname.split("/").filter(Boolean);
  // Only the `/services/T../B../<secret>` form carries a workspace+app id.
  if (parts[0] !== "services" || parts.length < 3) return "";
  return `${parts[1]}/${parts[2]}`;
}
