/**
 * User-facing auth email (verification + password reset) over Cloudflare Email
 * Sending — the transactional product that delivers to ARBITRARY recipients (any
 * new-signup address), distinct from the Email Routing `SEND_EMAIL` binding used
 * for internal ops notifications (which only reaches account-verified addresses).
 *
 * `sendAuthEmail` NEVER throws: a missing binding or a send failure degrades to a
 * logged event and a `{ sent: false }` result, so it can't surface as an unhandled
 * rejection inside Better Auth's request flow. It always logs the action.
 *
 * The single-use verify/reset/sign-in link is surfaced in logs so a dev run can
 * finish the flow by copy-pasting the URL from the `dev:api` Worker console (the
 * Cloudflare Email Sending binding doesn't deliver real mail under `wrangler dev`).
 * The link is logged ONLY when this is not a deployed env, decided by `devLogLink`:
 * a non-prod `ENVIRONMENT` (unset / `"development"`) OR the local-only `DEV_MODE`
 * var. The `DEV_MODE` arm is the resilience backstop for the footgun where local
 * `wrangler dev` inherits the top-level `ENVIRONMENT: "production"` var: `DEV_MODE`
 * is set in `.dev.vars` and is NEVER present in a deployed env, so it cleanly tells
 * local apart from prod where `ENVIRONMENT` alone can't (the same discriminator
 * `resolveSigningSecret` uses). When `devLogLink` is on, the token is logged on
 * EVERY outcome — including a "sent" success, since `wrangler dev` may simulate the
 * send without delivering, so a bare success log would otherwise leave nothing to
 * act on.
 *
 * Every deployed env (production AND staging carry a concrete `ENVIRONMENT` and no
 * `DEV_MODE`) logs neither the body nor the URL on ANY branch — a successful send, a
 * transient failure, AND a missing-binding misconfiguration all keep the single-use
 * token out of the shared log sink. A missing binding in prod stays loudly
 * observable via the `email-no-binding` event plus its subject + recipient, just
 * without the live credential.
 */
import { logEvent } from "@releases/lib/log-event";
import { appendHtmlFooter, appendTextFooter, wrapHtmlEmail } from "../lib/email-layout.js";
import { escapeHtml } from "../lib/html-escape.js";

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
  /**
   * Local-only flag (`.dev.vars`, never set in a deployed env). When `"true"` the
   * recovery link is surfaced in logs even though local `wrangler dev` reports
   * `ENVIRONMENT: "production"`. See the module header and `resolveSigningSecret`.
   */
  DEV_MODE?: string;
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

/**
 * Pull the first http(s) URL out of a rendered text body so the dev log can carry a
 * single, copy-pasteable line instead of burying the link inside the multi-line
 * `body`. The templates always embed exactly the verify/reset/sign-in URL on its own
 * line, so a whitespace-bounded match is reliable here. Returns undefined if none is
 * found (callers fall back to `(see body)`).
 */
function firstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/\S+/)?.[0];
}

export async function sendAuthEmail(
  env: AuthEmailEnv,
  msg: AuthEmailMessage,
): Promise<SendAuthEmailResult> {
  const addr = env.AUTH_EMAIL_FROM || DEFAULT_FROM;
  const name = env.AUTH_EMAIL_FROM_NAME || DEFAULT_FROM_NAME;
  const from = `${name} <${addr}>`;
  // Is this a non-deployed (local) run, where surfacing the single-use token link in
  // logs is the only way to finish the flow? True for a non-prod ENVIRONMENT (unset /
  // "development") OR the local-only DEV_MODE var — the latter catches local
  // `wrangler dev`, which inherits the top-level ENVIRONMENT: "production" var and so
  // can't be told apart from prod by ENVIRONMENT alone. A deployed env sets neither,
  // so the token is NEVER written to a shared log sink on any branch below.
  const devLogLink =
    !env.ENVIRONMENT || env.ENVIRONMENT === "development" || env.DEV_MODE === "true";
  const url = firstUrl(msg.text);

  if (!env.AUTH_EMAIL) {
    logEvent("warn", {
      component: "auth",
      event: "email-no-binding",
      // Loud + greppable: the binding is missing → this email did NOT send. The
      // recovery URL is included ONLY in a local env — a missing binding in real
      // prod must not write a live token to a shared log sink; the event + subject +
      // recipient keep the misconfiguration observable without the credential.
      message: devLogLink
        ? `AUTH EMAIL NOT SENT (no AUTH_EMAIL binding) — open this URL to finish "${msg.subject}" for ${msg.to}: ${url ?? "(see body)"}`
        : `AUTH EMAIL NOT SENT (no AUTH_EMAIL binding) for "${msg.subject}" to ${msg.to}`,
      ...(devLogLink ? { body: msg.text } : {}),
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
      // A "sent" success under `wrangler dev` may be SIMULATED (no real delivery),
      // so in a non-prod env surface the link too — don't strand a dev on a success
      // log that never reached an inbox. Real prod keeps the token out of logs.
      message: devLogLink
        ? `AUTH EMAIL sent in dev (may not be delivered) — open this URL to finish "${msg.subject}" for ${msg.to}: ${url ?? "(see body)"}`
        : `Sent "${msg.subject}" to ${msg.to}`,
      ...(devLogLink ? { body: msg.text } : {}),
      environment: env.ENVIRONMENT,
    });
    return { sent: true, messageId: res?.messageId };
  } catch (err) {
    logEvent("error", {
      component: "auth",
      event: "email-send-failed",
      message: devLogLink
        ? `AUTH EMAIL NOT SENT (send failed) — open this URL to finish "${msg.subject}" for ${msg.to}: ${url ?? "(see body)"}`
        : `Failed to send "${msg.subject}" to ${msg.to}`,
      error: err instanceof Error ? err.message : String(err),
      // Single-use token in the body: non-prod only — a transient prod send failure
      // must not write a live token to a shared log sink.
      ...(devLogLink ? { body: msg.text } : {}),
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

const DEFAULT_WEB_ORIGIN = "https://releases.sh";

function accountFooter(webOrigin: string) {
  const accountUrl = `${webOrigin}/account`;
  return {
    reason:
      "You received this because someone signed up for a Releases account with this email address.",
    links: [{ label: "Account settings", href: accountUrl }],
  };
}

/** Verification email shown on sign-up / re-sent on an unverified sign-in. */
export function verifyEmailTemplate(opts: { url: string; webOrigin?: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const safeUrl = escapeHrefUrl(opts.url);
  const footer = accountFooter(opts.webOrigin ?? DEFAULT_WEB_ORIGIN);
  const subject = "Verify your email for Releases";
  const bodyText = [
    "Welcome to Releases.",
    "",
    "Confirm your email address to finish setting up your account:",
    opts.url,
    "",
    "This link expires in 1 hour. If you didn't create an account, you can ignore this email.",
  ].join("\n");
  const bodyHtml = [
    "<p>Welcome to Releases.</p>",
    "<p>Confirm your email address to finish setting up your account:</p>",
    `<p><a href="${safeUrl}">Verify email</a></p>`,
    "<p>This link expires in 1 hour. If you didn't create an account, you can ignore this email.</p>",
  ].join("");
  return {
    subject,
    text: appendTextFooter(bodyText, footer),
    html: wrapHtmlEmail(appendHtmlFooter(bodyHtml, footer)),
  };
}

/** Password-reset email triggered by the forgot-password flow. */
export function resetPasswordTemplate(opts: { url: string; webOrigin?: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const safeUrl = escapeHrefUrl(opts.url);
  const webOrigin = opts.webOrigin ?? DEFAULT_WEB_ORIGIN;
  const footer = {
    reason: "You received this because a password reset was requested for your Releases account.",
    links: [{ label: "Account settings", href: `${webOrigin}/account` }],
  };
  const subject = "Reset your Releases password";
  const bodyText = [
    "We received a request to reset your Releases password.",
    "",
    "Reset it here:",
    opts.url,
    "",
    "This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.",
  ].join("\n");
  const bodyHtml = [
    "<p>We received a request to reset your Releases password.</p>",
    `<p><a href="${safeUrl}">Reset password</a></p>`,
    "<p>This link expires in 1 hour. If you didn't request this, you can ignore this email — your password won't change.</p>",
  ].join("");
  return {
    subject,
    text: appendTextFooter(bodyText, footer),
    html: wrapHtmlEmail(appendHtmlFooter(bodyHtml, footer)),
  };
}

/**
 * Email-change confirmation. Sent to the user's CURRENT (old) address when they
 * request a new email from the account page — clicking the link confirms the
 * change and switches the account over. Going to the existing inbox is the
 * security property: an attacker who momentarily holds a session still can't move
 * the account to an address they control without access to the current mailbox.
 * The new address is named in the copy so the recipient can spot an unexpected
 * request and ignore it.
 */
export function changeEmailTemplate(opts: { url: string; newEmail: string; webOrigin?: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const safeUrl = escapeHrefUrl(opts.url);
  const safeNewEmail = escapeHtml(opts.newEmail);
  const webOrigin = opts.webOrigin ?? DEFAULT_WEB_ORIGIN;
  const footer = {
    reason:
      "You received this because a change to your Releases account email was requested from your signed-in session.",
    links: [{ label: "Account settings", href: `${webOrigin}/account` }],
  };
  const subject = "Confirm your new Releases email address";
  const bodyText = [
    `We received a request to change your Releases email address to ${opts.newEmail}.`,
    "",
    "Confirm the change here:",
    opts.url,
    "",
    "This link expires in 1 hour. If you didn't request this, you can ignore this email — your address won't change.",
  ].join("\n");
  const bodyHtml = [
    `<p>We received a request to change your Releases email address to ${safeNewEmail}.</p>`,
    `<p><a href="${safeUrl}">Confirm new email</a></p>`,
    "<p>This link expires in 1 hour. If you didn't request this, you can ignore this email — your address won't change.</p>",
  ].join("");
  return {
    subject,
    text: appendTextFooter(bodyText, footer),
    html: wrapHtmlEmail(appendHtmlFooter(bodyHtml, footer)),
  };
}

/**
 * Passwordless magic-link sign-in email. Clicking the link authenticates the user
 * (and auto-creates a verified account for an unknown email — see the magicLink
 * plugin in index.ts). Shorter expiry copy than verify/reset: a login link lives 15
 * minutes (`expiresIn: 60 * 15`).
 */
export function invitationEmailTemplate(opts: {
  url: string;
  orgName: string;
  webOrigin?: string;
}): {
  subject: string;
  text: string;
  html: string;
} {
  const safeUrl = escapeHrefUrl(opts.url);
  const safeOrg = escapeHtml(opts.orgName);
  const footer = {
    reason: "You received this because someone invited you to a workspace on Releases.",
    links: [{ label: "Releases", href: opts.webOrigin ?? DEFAULT_WEB_ORIGIN }],
  };
  const subject = `You're invited to join ${opts.orgName} on Releases`;
  const bodyText = [
    `You've been invited to join the ${opts.orgName} workspace on Releases.`,
    "",
    "Accept the invitation:",
    opts.url,
  ].join("\n");
  const bodyHtml = [
    `<p>You've been invited to join the <strong>${safeOrg}</strong> workspace on Releases.</p>`,
    `<p><a href="${safeUrl}">Accept the invitation</a></p>`,
  ].join("");
  return {
    subject,
    text: appendTextFooter(bodyText, footer),
    html: wrapHtmlEmail(appendHtmlFooter(bodyHtml, footer)),
  };
}

export function magicLinkTemplate(opts: { url: string; webOrigin?: string }): {
  subject: string;
  text: string;
  html: string;
} {
  const safeUrl = escapeHrefUrl(opts.url);
  const footer = {
    reason: "You received this because someone requested a passwordless sign-in link for Releases.",
    links: [{ label: "Sign in", href: opts.webOrigin ?? DEFAULT_WEB_ORIGIN }],
  };
  const subject = "Your Releases sign-in link";
  const bodyText = [
    "Sign in to Releases.",
    "",
    "Click the link below to sign in — no password needed:",
    opts.url,
    "",
    "This link expires in 15 minutes and can be used once. If you didn't request it, you can ignore this email.",
  ].join("\n");
  const bodyHtml = [
    "<p>Sign in to Releases.</p>",
    "<p>Click the link below to sign in — no password needed:</p>",
    `<p><a href="${safeUrl}">Sign in to Releases</a></p>`,
    "<p>This link expires in 15 minutes and can be used once. If you didn't request it, you can ignore this email.</p>",
  ].join("");
  return {
    subject,
    text: appendTextFooter(bodyText, footer),
    html: wrapHtmlEmail(appendHtmlFooter(bodyHtml, footer)),
  };
}
