import { logEvent } from "@releases/lib/log-event";

/**
 * Minimal email + alert helpers for the webhooks worker.
 *
 * Duplicated from workers/api/src/lib/email.ts + send-alert.ts because
 * `workers/webhooks/` is excluded from the root workspace (see AGENTS.md
 * "Workspaces and carved-out packages") and has no shared package on the
 * import path. Keep in sync with the API-worker versions when the send
 * path changes — same `EMAIL_NOTIFY_*` env contract on both sides.
 *
 * Intentional differences from the API-worker `sendAlert`:
 *   - No KV dedup. The webhooks worker has no KV binding, and the alert
 *     call sites here (auto-disable, DLQ batch) are naturally rate-limited
 *     by their triggering events. If we ever see DLQ batch storms generate
 *     duplicate alerts, add a KV binding and port the dedup logic.
 */

// ── Email types ────────────────────────────────────────────────────────────

export type EmailBinding = {
  send(message: unknown): Promise<void>;
};

export type EmailEnv = {
  SEND_EMAIL?: EmailBinding;
  EMAIL_NOTIFY_ENABLED?: string;
  EMAIL_NOTIFY_TO?: string;
  EMAIL_FROM?: string;
};

type SendEmailInput = {
  subject: string;
  text: string;
  /** Optional HTML alternative part — rendered by the shared email shell upstream. */
  html?: string;
  to?: string;
  from?: string;
  fromName?: string;
};

type SendEmailResult =
  | { sent: true }
  | { sent: false; reason: "disabled" | "no_binding" | "no_recipient" | "no_sender" };

const DEFAULT_FROM = "notifications@releases.sh";
const DEFAULT_FROM_NAME = "Releases Notifications";

async function sendEmail(env: EmailEnv, input: SendEmailInput): Promise<SendEmailResult> {
  if (env.EMAIL_NOTIFY_ENABLED === "false") return { sent: false, reason: "disabled" };
  if (!env.SEND_EMAIL) return { sent: false, reason: "no_binding" };

  const to = input.to ?? env.EMAIL_NOTIFY_TO;
  if (!to) return { sent: false, reason: "no_recipient" };

  const from = input.from ?? env.EMAIL_FROM ?? DEFAULT_FROM;
  if (!from) return { sent: false, reason: "no_sender" };

  const [{ EmailMessage }, { createMimeMessage }] = await Promise.all([
    import("cloudflare:email"),
    import("mimetext"),
  ]);

  const msg = createMimeMessage();
  msg.setSender({ name: input.fromName ?? DEFAULT_FROM_NAME, addr: from });
  msg.setRecipient(to);
  msg.setSubject(input.subject);
  msg.addMessage({ contentType: "text/plain", data: input.text });
  if (input.html) {
    msg.addMessage({ contentType: "text/html", data: input.html });
  }

  const message = new EmailMessage(from, to, msg.asRaw());
  await env.SEND_EMAIL.send(message);
  return { sent: true };
}

async function sendTransactional(
  component: "webhook-alert" | "webhook-user-notify",
  env: EmailEnv,
  subject: string,
  body: string,
  to?: string,
  html?: string,
): Promise<boolean> {
  try {
    const result = await sendEmail(env, { to, subject, text: body, html });
    if (!result.sent) {
      logEvent("info", { component, event: "skipped", reason: result.reason, subject });
      return false;
    }
    logEvent("info", { component, event: "sent", subject });
    return true;
  } catch (err) {
    logEvent("warn", { component, event: "send-error", err });
    return false;
  }
}

/** Owner-facing transactional email (no `[alert]` prefix). */
export async function sendWebhookUserNotice(
  env: EmailEnv,
  to: string,
  subject: string,
  body: string,
  html?: string,
): Promise<boolean> {
  return sendTransactional("webhook-user-notify", env, subject, body, to, html);
}

/** Operator `[alert]` email to EMAIL_NOTIFY_TO. */
export async function sendWebhookAlert(
  env: EmailEnv,
  subject: string,
  body: string,
  html?: string,
): Promise<boolean> {
  const normalizedSubject = subject.startsWith("[alert]") ? subject : `[alert] ${subject}`;
  return sendTransactional("webhook-alert", env, normalizedSubject, body, undefined, html);
}
