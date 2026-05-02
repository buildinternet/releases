/**
 * Fire-and-forget alert email helper for Tier-1 failure notifications.
 *
 * Lives separately from the cron-report path (`notifications.ts`) because
 * cron reports always send (status-stamped severity prefix) while alerts
 * dedupe per-subject across a 1h window — repeated cron crashes during a
 * sustained outage shouldn't flood the inbox.
 */

import { sendEmail, type EmailEnv } from "./email.js";
import { logEvent } from "@releases/lib/log-event";

const DEDUP_TTL_SECONDS = 3600;

export type AlertEnv = EmailEnv & {
  /** Optional KV namespace used for 1h dedup. Reuses any existing KV namespace. */
  ALERT_DEDUP_KV?: KVNamespace;
};

export type SendAlertInput = {
  subject: string;
  body: string;
};

/**
 * Send a Tier-1 alert email. Never throws. Returns true when sent, false
 * when skipped (deduped, disabled, missing binding, or send error).
 */
export async function sendAlert(env: AlertEnv, input: SendAlertInput): Promise<boolean> {
  // Bail before touching KV if the email path is a no-op anyway — saves
  // KV writes during partial deployments where SEND_EMAIL hasn't been set.
  if (!env.SEND_EMAIL || env.EMAIL_NOTIFY_ENABLED === "false") return false;

  const subject = input.subject.startsWith("[alert]") ? input.subject : `[alert] ${input.subject}`;

  // Check (but don't yet write) the dedup key. We only commit the dedup record
  // after a successful send — otherwise a transient send failure would poison
  // the dedup window for an hour and silently swallow retries.
  const dedupKey = env.ALERT_DEDUP_KV ? `alert:${subject}` : null;
  if (env.ALERT_DEDUP_KV && dedupKey) {
    try {
      const existing = await env.ALERT_DEDUP_KV.get(dedupKey);
      if (existing !== null) return false;
    } catch (err) {
      // KV failure is non-fatal — let the email attempt proceed.
      const msg = err instanceof Error ? err.message : String(err);
      logEvent("warn", { component: "send-alert", event: "kv-dedup-read-error", err: msg });
    }
  }

  try {
    const result = await sendEmail(env, { subject, text: input.body });
    if (!result.sent) {
      logEvent("info", {
        component: "send-alert",
        event: "skipped",
        reason: result.reason,
        subject,
      });
      return false;
    }
    if (env.ALERT_DEDUP_KV && dedupKey) {
      try {
        await env.ALERT_DEDUP_KV.put(dedupKey, "1", { expirationTtl: DEDUP_TTL_SECONDS });
      } catch (err) {
        // Log but don't undo the send — duplicate emails within the window
        // are preferable to mis-reporting send success.
        const msg = err instanceof Error ? err.message : String(err);
        logEvent("warn", { component: "send-alert", event: "kv-dedup-write-error", err: msg });
      }
    }
    logEvent("info", { component: "send-alert", event: "sent", subject });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logEvent("warn", { component: "send-alert", event: "send-error", err: msg });
    return false;
  }
}
