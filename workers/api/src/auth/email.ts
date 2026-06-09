/**
 * User-facing auth email (verification + password reset) over Cloudflare Email
 * Sending — the transactional product that delivers to ARBITRARY recipients (any
 * new-signup address), distinct from the Email Routing `SEND_EMAIL` binding used
 * for internal ops notifications (which only reaches account-verified addresses).
 *
 * `sendAuthEmail` NEVER throws: a missing binding or a send failure degrades to a
 * logged event and a `{ sent: false }` result, so it can't surface as an unhandled
 * rejection inside Better Auth's request flow. It always logs the action. The link
 * itself (a single-use verify/reset token) is logged ONLY in local development —
 * `ENVIRONMENT` unset or `"development"` — so a dev run can finish the flow by
 * copy-pasting the URL from Worker logs. Every DEPLOYED environment (production AND
 * staging both carry a concrete `ENVIRONMENT`) omits it, so a shared log sink never
 * carries the token.
 */
import { logEvent } from "@releases/lib/log-event";

/** The Cloudflare Email Sending binding (object-form `send`). */
export interface AuthEmailBinding {
  send(message: {
    to: string;
    from: string;
    subject: string;
    html?: string;
    text?: string;
    /** Custom headers (e.g. List-Unsubscribe). Cloudflare rejects reserved/API-field headers. */
    headers?: Record<string, string>;
  }): Promise<{ messageId?: string }>;
}

export type AuthEmailEnv = {
  AUTH_EMAIL?: AuthEmailBinding;
  AUTH_EMAIL_FROM?: string;
  AUTH_EMAIL_FROM_NAME?: string;
  ENVIRONMENT?: string;
};

/** A fully-rendered email (subject + both bodies); the recipient is `to`. */
export type AuthEmailMessage = {
  to: string;
  subject: string;
  text: string;
  html: string;
};

export type SendAuthEmailResult =
  | { sent: true; messageId?: string }
  | { sent: false; reason: "no_binding" | "error" };

const DEFAULT_FROM = "noreply@releases.sh";
const DEFAULT_FROM_NAME = "Releases";

export async function sendAuthEmail(
  env: AuthEmailEnv,
  msg: AuthEmailMessage,
): Promise<SendAuthEmailResult> {
  const addr = env.AUTH_EMAIL_FROM || DEFAULT_FROM;
  const name = env.AUTH_EMAIL_FROM_NAME || DEFAULT_FROM_NAME;
  const from = `${name} <${addr}>`;
  // Surface the token link in the log ONLY in local development. Every deployed
  // environment (production AND staging) sets a concrete `ENVIRONMENT`, so a
  // single-use token is never written to a shared log sink.
  const logLink = !env.ENVIRONMENT || env.ENVIRONMENT === "development";

  if (!env.AUTH_EMAIL) {
    logEvent("warn", {
      component: "auth",
      event: "email-no-binding",
      message: `AUTH_EMAIL binding absent; "${msg.subject}" not sent to ${msg.to}`,
      // The link lives in the body — local dev only, so the flow can be finished
      // from logs; never logged in a deployed env (single-use token).
      ...(logLink ? { body: msg.text } : {}),
      environment: env.ENVIRONMENT,
    });
    return { sent: false, reason: "no_binding" };
  }

  try {
    const res = await env.AUTH_EMAIL.send({
      to: msg.to,
      from,
      subject: msg.subject,
      text: msg.text,
      html: msg.html,
    });
    logEvent("info", {
      component: "auth",
      event: "email-sent",
      message: `Sent "${msg.subject}" to ${msg.to}`,
      environment: env.ENVIRONMENT,
    });
    return { sent: true, messageId: res?.messageId };
  } catch (err) {
    logEvent("error", {
      component: "auth",
      event: "email-send-failed",
      message: `Failed to send "${msg.subject}" to ${msg.to}`,
      error: err instanceof Error ? err.message : String(err),
      // Single-use token in the body: local dev only (see above).
      ...(logLink ? { body: msg.text } : {}),
      environment: env.ENVIRONMENT,
    });
    return { sent: false, reason: "error" };
  }
}

/**
 * Escape the attribute-breakout char (`"`) so the URL can sit inside an `href="…"`
 * without breaking out of the attribute. Only that char is touched — `&`/etc. must
 * stay raw or a valid query string would corrupt; the plain-text body keeps the
 * un-escaped URL.
 */
function escapeHrefUrl(url: string): string {
  return url.replace(/"/g, "%22");
}

/** Verification email shown on sign-up / re-sent on an unverified sign-in. */
export function verifyEmailTemplate(opts: { url: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const safeUrl = escapeHrefUrl(opts.url);
  const subject = "Verify your email for Releases";
  const text = [
    "Welcome to Releases.",
    "",
    "Confirm your email address to finish setting up your account:",
    opts.url,
    "",
    "This link expires in 1 hour. If you didn't create an account, you can ignore this email.",
  ].join("\n");
  const html = [
    "<p>Welcome to Releases.</p>",
    "<p>Confirm your email address to finish setting up your account:</p>",
    `<p><a href="${safeUrl}">Verify email</a></p>`,
    "<p>This link expires in 1 hour. If you didn't create an account, you can ignore this email.</p>",
  ].join("");
  return { subject, text, html };
}

/** Password-reset email triggered by the forgot-password flow. */
export function resetPasswordTemplate(opts: { url: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const safeUrl = escapeHrefUrl(opts.url);
  const subject = "Reset your Releases password";
  const text = [
    "We received a request to reset your Releases password.",
    "",
    "Reset it here:",
    opts.url,
    "",
    "This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.",
  ].join("\n");
  const html = [
    "<p>We received a request to reset your Releases password.</p>",
    `<p><a href="${safeUrl}">Reset password</a></p>`,
    "<p>This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.</p>",
  ].join("");
  return { subject, text, html };
}

/**
 * Passwordless magic-link sign-in email. Clicking the link authenticates the user
 * (and auto-creates a verified account for an unknown email — see the magicLink
 * plugin in index.ts). Shorter expiry copy than verify/reset: a login link lives 15
 * minutes (`expiresIn: 60 * 15`).
 */
export function magicLinkTemplate(opts: { url: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const safeUrl = escapeHrefUrl(opts.url);
  const subject = "Your Releases sign-in link";
  const text = [
    "Sign in to Releases.",
    "",
    "Click the link below to sign in — no password needed:",
    opts.url,
    "",
    "This link expires in 15 minutes and can be used once. If you didn't request it, you can ignore this email.",
  ].join("\n");
  const html = [
    "<p>Sign in to Releases.</p>",
    "<p>Click the link below to sign in — no password needed:</p>",
    `<p><a href="${safeUrl}">Sign in to Releases</a></p>`,
    "<p>This link expires in 15 minutes and can be used once. If you didn't request it, you can ignore this email.</p>",
  ].join("");
  return { subject, text, html };
}
