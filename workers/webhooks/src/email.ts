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

  const message = new EmailMessage(from, to, msg.asRaw());
  await env.SEND_EMAIL.send(message);
  return { sent: true };
}

// ── Alert helper ───────────────────────────────────────────────────────────

/**
 * Send a `[alert]`-prefixed email. Fire-and-forget; never throws.
 * Returns true if the email was sent, false if skipped.
 */
export async function sendWebhookAlert(
  env: EmailEnv,
  subject: string,
  body: string,
): Promise<boolean> {
  const normalizedSubject = subject.startsWith("[alert]") ? subject : `[alert] ${subject}`;
  try {
    const result = await sendEmail(env, { subject: normalizedSubject, text: body });
    if (!result.sent) {
      logEvent("info", {
        component: "webhook-alert",
        event: "skipped",
        reason: result.reason,
        subject: normalizedSubject,
      });
      return false;
    }
    logEvent("info", { component: "webhook-alert", event: "sent", subject: normalizedSubject });
    return true;
  } catch (err) {
    logEvent("warn", {
      component: "webhook-alert",
      event: "send-error",
      err: err instanceof Error ? err : new Error(String(err)),
    });
    return false;
  }
}
