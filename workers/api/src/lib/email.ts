/**
 * Generic transactional email helper for internal notifications. Returns
 * `{ sent: false, reason }` when the binding is missing or the kill-switch
 * is off, so callers can fire-and-forget without branching.
 *
 * `cloudflare:email` and `mimetext` are imported lazily so Bun test runs
 * (which transitively import this file via crons) don't fail on the
 * `cloudflare:email` resolver — the binding guard bails before the import.
 */

export type EmailBinding = {
  send(message: unknown): Promise<void>;
};

export type EmailEnv = {
  SEND_EMAIL?: EmailBinding;
  EMAIL_NOTIFY_ENABLED?: string;
  EMAIL_NOTIFY_TO?: string;
  EMAIL_FROM?: string;
};

export type SendEmailInput = {
  subject: string;
  text: string;
  html?: string;
  /** Override EMAIL_NOTIFY_TO for this call. */
  to?: string;
  /** Override EMAIL_FROM for this call. */
  from?: string;
  /** Optional display name for the sender. */
  fromName?: string;
};

export type SendEmailResult =
  | { sent: true }
  | { sent: false; reason: "disabled" | "no_binding" | "no_recipient" | "no_sender" };

const DEFAULT_FROM = "notifications@releases.sh";
const DEFAULT_FROM_NAME = "Releases Notifications";

export async function sendEmail(env: EmailEnv, input: SendEmailInput): Promise<SendEmailResult> {
  if (env.EMAIL_NOTIFY_ENABLED === "false") return { sent: false, reason: "disabled" };
  if (!env.SEND_EMAIL) return { sent: false, reason: "no_binding" };

  const to = input.to ?? env.EMAIL_NOTIFY_TO;
  if (!to) return { sent: false, reason: "no_recipient" };

  const from = input.from ?? env.EMAIL_FROM ?? DEFAULT_FROM;
  if (!from) return { sent: false, reason: "no_sender" };

  // Lazy-load Worker-only modules so Bun test runs that transitively import
  // this file don't fail on the `cloudflare:email` resolver.
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
