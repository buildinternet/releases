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
import { renderEmail } from "@releases/rendering/email-shell";

const DEDUP_TTL_SECONDS = 3600;

export type AlertEnv = EmailEnv & {
  /** Optional KV namespace used for 1h dedup. Reuses any existing KV namespace. */
  ALERT_DEDUP_KV?: KVNamespace;
};

export type SendAlertInput = {
  subject: string;
  body: string;
  /** Optional HTML alternative part. Plain-text `body` is always sent too. */
  html?: string;
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
      logEvent("warn", { component: "send-alert", event: "kv-dedup-read-error", err });
    }
  }

  try {
    const result = await sendEmail(env, { subject, text: input.body, html: input.html });
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
        logEvent("warn", { component: "send-alert", event: "kv-dedup-write-error", err });
      }
    }
    logEvent("info", { component: "send-alert", event: "sent", subject });
    return true;
  } catch (err) {
    logEvent("warn", { component: "send-alert", event: "send-error", err });
    return false;
  }
}

/**
 * The Tier-1 "a cron threw" alert. Lives here rather than inline at the throw
 * site so the crash mail is branded like every other operator message and the
 * admin preview can render the real thing instead of a fabricated string.
 *
 * The stack is deliberately text-only: it is the one payload an operator copies
 * out wholesale, and monospace HTML wrapping mangles it.
 */
export function formatCronCrashAlert(input: {
  tag: string;
  message: string;
  stack?: string;
  firedAt?: string;
}): { subject: string; body: string; html: string } {
  const { html, text } = renderEmail({
    lane: "Operator · Alert",
    tone: "crit",
    title: `${input.tag} crashed`,
    subtitle: input.firedAt,
    preheader: `Unhandled error — the run did not complete. ${input.message}`,
    blocks: [
      { t: "p", text: "The scheduled run threw before it finished." },
      {
        t: "data",
        rows: [
          { label: "cron tag", value: input.tag },
          { label: "error", value: input.message, kind: "err" },
          ...(input.firedAt ? [{ label: "fired", value: input.firedAt }] : []),
        ],
      },
    ],
    footer: {
      reason: "Internal Tier-1 alert from Releases — a scheduled run threw an unhandled error.",
    },
  });
  const body = [text.trimEnd(), input.stack ? `\nStack:\n${input.stack}` : ""]
    .filter(Boolean)
    .join("\n");
  return { subject: `[alert] cron crashed: ${input.tag}`, body, html };
}
