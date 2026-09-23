/**
 * Pure formatter + thin sender for the feedback-arrival notification.
 * `notifyFeedback` is fire-and-forget (never throws) so a mail failure can't
 * fail the submit — callers invoke it via `c.executionCtx.waitUntil(...)`.
 */
import { renderEmail } from "@releases/rendering/email-shell";
import { sendEmail, type EmailEnv } from "./email.js";
import { logEvent } from "@releases/lib/log-event";
import type { Feedback } from "@buildinternet/releases-core/schema";

const DEFAULT_NOTIFY_MAX_PER_HOUR = 20;
const HOUR_MS = 3_600_000;

/** Minimal KV surface used for the notify-volume counter (subset of KVNamespace). */
type NotifyKv = {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>;
};

export type FeedbackNotifyEnv = EmailEnv & {
  ALERT_DEDUP_KV?: NotifyKv;
  FEEDBACK_NOTIFY_MAX_PER_HOUR?: string;
};

/**
 * Caps notification emails to `max` per rolling-hour bucket so a flood of
 * submissions (esp. from many IPs, which the per-IP rate limiter can't stop)
 * can't bomb the operator inbox. Fail-open: no KV → always allow. The KV
 * read-then-write isn't atomic, so the cap is approximate under heavy
 * concurrency — acceptable for coarse inbox protection (rows are still stored).
 */
export async function withinNotifyBudget(kv: NotifyKv | undefined, max: number): Promise<boolean> {
  if (!kv) return true;
  const bucket = Math.floor(Date.now() / HOUR_MS);
  const key = `feedback:notify:${bucket}`;
  const current = parseInt((await kv.get(key)) ?? "0", 10) || 0;
  if (current >= max) return false;
  await kv.put(key, String(current + 1), { expirationTtl: 3600 });
  return true;
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

export function formatFeedbackEmail(row: Feedback): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = `[feedback] ${row.type}: ${truncate(row.message, 60)}`;
  const { html, text } = renderEmail({
    lane: "Feedback",
    title: `CLI feedback: ${row.type}`,
    subtitle: row.id,
    blocks: [
      { t: "p", text: row.message },
      {
        t: "data",
        rows: [
          { label: "Contact", value: row.contact ?? "(none)" },
          { label: "Surface", value: row.surface },
          { label: "CLI", value: row.cliVersion ?? "(unknown)" },
          { label: "Client", value: row.clientKind },
          { label: "Env", value: `${row.os ?? "?"}/${row.arch ?? "?"} ${row.runtime ?? "?"}` },
          { label: "Anon", value: row.anonId ?? "(omitted)" },
          { label: "ID", value: row.id },
          { label: "When", value: new Date(row.createdAt).toISOString() },
        ],
      },
    ],
    footer: {
      reason: `Internal notification from Releases — feedback submitted via ${row.surface}.`,
    },
  });
  return { subject, text, html };
}

export async function notifyFeedback(env: FeedbackNotifyEnv, row: Feedback): Promise<void> {
  try {
    const max = parseInt(env.FEEDBACK_NOTIFY_MAX_PER_HOUR ?? "", 10) || DEFAULT_NOTIFY_MAX_PER_HOUR;
    if (!(await withinNotifyBudget(env.ALERT_DEDUP_KV, max))) {
      logEvent("warn", {
        component: "feedback",
        event: "notify-rate-capped",
        id: row.id,
        maxPerHour: max,
      });
      return;
    }
    const { subject, text, html } = formatFeedbackEmail(row);
    const result = await sendEmail(env, { subject, text, html });
    if (!result.sent) {
      logEvent("info", {
        component: "feedback",
        event: "notify-skipped",
        reason: result.reason,
        id: row.id,
      });
    } else {
      logEvent("info", { component: "feedback", event: "notify-sent", id: row.id });
    }
  } catch (err) {
    logEvent("warn", { component: "feedback", event: "notify-error", id: row.id, err });
  }
}
