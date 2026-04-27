/**
 * Fire-and-forget alert helper for Tier-1 failure notifications.
 *
 * All four alert types ([alert] subject prefix) flow through `sendAlert()`.
 * The existing cron-report path ([degraded]/[failed]/[aborted]) is untouched.
 *
 * Debounce: a lightweight KV write (key = `alert:<subject>`, TTL = 1h) prevents
 * duplicate emails for the same failure within a single cron window. The KV
 * binding is optional — when absent the check is skipped and every alert fires.
 */

import { sendEmail, type EmailEnv } from "./email.js";

export type AlertEnv = EmailEnv & {
  /** Optional KV namespace used for 1h dedup (EMBED_CACHE or LATEST_CACHE both work). */
  ALERT_DEDUP_KV?: KVNamespace;
};

export type SendAlertInput = {
  subject: string;
  body: string;
};

/**
 * Send a Tier-1 alert email. Never throws; always fire-and-forget safe.
 * Returns true when the email was sent, false when skipped (deduped / disabled / no binding).
 */
export async function sendAlert(env: AlertEnv, input: SendAlertInput): Promise<boolean> {
  // Subject must carry the [alert] prefix — enforce it here so callers can't forget.
  const subject = input.subject.startsWith("[alert]") ? input.subject : `[alert] ${input.subject}`;

  // 1-hour KV dedup keyed by the exact subject.
  if (env.ALERT_DEDUP_KV) {
    try {
      const dedupKey = `alert:${subject}`;
      const existing = await env.ALERT_DEDUP_KV.get(dedupKey);
      if (existing !== null) {
        // Already sent within the TTL window — skip.
        console.log(`[send-alert] deduped (already sent within 1h): ${subject}`);
        return false;
      }
      // Mark as sent before the email call so concurrent fires don't race.
      await env.ALERT_DEDUP_KV.put(dedupKey, "1", { expirationTtl: 3600 });
    } catch (err) {
      // KV failure is non-fatal — let the email attempt proceed.
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[send-alert] KV dedup error (continuing): ${msg}`);
    }
  }

  try {
    const result = await sendEmail(env, {
      subject,
      text: input.body,
    });
    if (!result.sent) {
      console.log(`[send-alert] skipped (${result.reason}): ${subject}`);
      return false;
    }
    console.log(`[send-alert] sent: ${subject}`);
    return true;
  } catch (err) {
    // sendEmail is designed not to throw, but be defensive.
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[send-alert] send error: ${msg}`);
    return false;
  }
}
