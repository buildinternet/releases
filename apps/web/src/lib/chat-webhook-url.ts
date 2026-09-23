/**
 * Client-side recognition of Slack / Discord incoming-webhook URLs for the
 * Notifications → Chat section. A quick hint only — the API enforces the real
 * allowlist (`validateWebhookUrlForFormat` in core-internal, worker-only).
 */

export type ChatWebhookFormat = "slack" | "discord";

const SLACK_HOSTS = new Set(["hooks.slack.com", "hooks.slack-gov.com"]);
const DISCORD_HOSTS = new Set([
  "discord.com",
  "discordapp.com",
  "canary.discord.com",
  "ptb.discord.com",
]);
const DISCORD_PATH = /^\/api(?:\/v\d+)?\/webhooks\/\d+\/[A-Za-z0-9_.-]+\/?$/;

/** Which chat app an incoming-webhook URL belongs to, or null if neither. */
export function detectChatWebhookFormat(raw: string): ChatWebhookFormat | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  const host = u.hostname.toLowerCase();
  if (SLACK_HOSTS.has(host)) return "slack";
  if (DISCORD_HOSTS.has(host) && DISCORD_PATH.test(u.pathname)) return "discord";
  return null;
}
