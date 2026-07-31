/**
 * Emails fired when a signed-in user first verifies domain ownership via
 * POST /v1/listing/claim/verify:
 *   - owner confirmation (AUTH_EMAIL / sendAuthEmail)
 *   - operator notify (SEND_EMAIL / sendEmail → EMAIL_NOTIFY_TO)
 * Both are best-effort and never fail the verify response.
 */
import { logEvent } from "@releases/lib/log-event";
import { releaseWebBase } from "@buildinternet/releases-core/release-slug";
import { renderEmail } from "@releases/rendering/email-shell";
import { sendAuthEmail, type AuthEmailEnv } from "../auth/email.js";
import { sendEmail, type EmailEnv } from "./email.js";

export type ClaimVerifyMethod = "well-known" | "dns-txt";

export type ClaimVerifiedEmailEnv = AuthEmailEnv &
  EmailEnv & {
    WEB_BASE_URL?: string;
  };

export type ClaimVerifiedNotifyInput = {
  domain: string;
  orgName: string;
  orgSlug: string;
  method: ClaimVerifyMethod;
  /** Verifying user's account email (contact). */
  ownerEmail: string;
  userId: string;
  claimId: string;
  verifiedAt: string;
};

function methodLabel(method: ClaimVerifyMethod): string {
  return method === "well-known" ? "well-known file" : "DNS TXT record";
}

function webOrigin(env: ClaimVerifiedEmailEnv): string {
  const raw = releaseWebBase(env);
  try {
    return new URL(raw).origin;
  } catch {
    return "https://releases.sh";
  }
}

/** Owner-facing confirmation — pure formatter. */
export function formatClaimVerifiedEmail(input: {
  domain: string;
  orgName: string;
  orgSlug: string;
  method: ClaimVerifyMethod;
  webOrigin: string;
}): { subject: string; text: string; html: string } {
  const orgUrl = `${input.webOrigin}/${input.orgSlug}`;
  const how = methodLabel(input.method);
  const { html, text } = renderEmail({
    lane: "Account · Ownership",
    title: `Ownership verified for ${input.domain}`,
    preheader: `You proved control of ${input.domain} on Releases.`,
    blocks: [
      {
        t: "p",
        text: `You verified ownership of **${input.domain}** (${input.orgName}) on Releases via a ${how}.`,
      },
      {
        t: "p",
        text: "We've recorded demand for tracking on this org. When self-serve tracking is available for your listing, you can enable it from the org page — until then, our team uses this signal to prioritize coverage.",
      },
      {
        t: "data",
        rows: [
          { label: "Domain", value: input.domain },
          { label: "Organization", value: input.orgName },
          { label: "Verified via", value: how },
        ],
      },
      { t: "button", label: "View organization", url: orgUrl },
    ],
    footer: {
      reason: `You received this because you verified ownership of ${input.domain} on releases.sh.`,
      links: [{ label: "View organization", href: orgUrl }],
    },
  });
  return { subject: `Ownership verified — ${input.domain}`, text, html };
}

/**
 * Operator-facing notification — pure formatter. Subject uses the `[ownership]`
 * filter prefix (same family as `[recommendation]` / `[feedback]`).
 */
export function formatClaimVerifiedOperatorEmail(
  input: {
    domain: string;
    orgName: string;
    orgSlug: string;
    method: ClaimVerifyMethod;
    ownerEmail: string;
    userId: string;
    claimId: string;
    verifiedAt: string;
  },
  webOrigin: string,
): { subject: string; text: string; html: string } {
  const orgUrl = `${webOrigin}/${input.orgSlug}`;
  const how = methodLabel(input.method);
  const subject = `[ownership] verified: ${input.domain}`;
  const { html, text } = renderEmail({
    lane: "Ownership",
    title: "Domain ownership verified",
    blocks: [
      {
        t: "p",
        text: `A signed-in user verified control of **${input.domain}** (${input.orgName}) via a ${how}. Tracking demand has been stamped.`,
      },
      {
        t: "data",
        rows: [
          { label: "Domain", value: input.domain },
          { label: "Organization", value: `${input.orgName} (/${input.orgSlug})` },
          { label: "Verified via", value: how },
          { label: "Owner email", value: input.ownerEmail || "(none)" },
          { label: "User id", value: input.userId },
          { label: "Claim id", value: input.claimId },
          { label: "When", value: input.verifiedAt },
        ],
      },
      { t: "button", label: "View organization", url: orgUrl },
    ],
    footer: {
      reason:
        "Internal notification from Releases — a signed-in user completed domain ownership verification.",
    },
  });
  return { subject, text, html };
}

/** Send the owner confirmation. Never throws. */
export async function sendClaimVerifiedEmail(
  env: ClaimVerifiedEmailEnv,
  input: {
    to: string;
    domain: string;
    orgName: string;
    orgSlug: string;
    method: ClaimVerifyMethod;
  },
): Promise<void> {
  try {
    if (!input.to) {
      logEvent("info", {
        component: "listing",
        event: "claim-verified-email-skipped",
        reason: "no_recipient",
        domain: input.domain,
        orgSlug: input.orgSlug,
      });
      return;
    }

    const rendered = formatClaimVerifiedEmail({
      domain: input.domain,
      orgName: input.orgName,
      orgSlug: input.orgSlug,
      method: input.method,
      webOrigin: webOrigin(env),
    });
    const result = await sendAuthEmail(env, {
      to: input.to,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    if (!result.sent) {
      logEvent("info", {
        component: "listing",
        event: "claim-verified-email-skipped",
        reason: result.reason,
        domain: input.domain,
        orgSlug: input.orgSlug,
      });
    } else {
      logEvent("info", {
        component: "listing",
        event: "claim-verified-email-sent",
        domain: input.domain,
        orgSlug: input.orgSlug,
        method: input.method,
      });
    }
  } catch (err) {
    logEvent("warn", {
      component: "listing",
      event: "claim-verified-email-error",
      domain: input.domain,
      orgSlug: input.orgSlug,
      err,
    });
  }
}

/** Notify operators via SEND_EMAIL → EMAIL_NOTIFY_TO. Never throws. */
export async function notifyClaimVerified(
  env: ClaimVerifiedEmailEnv,
  input: ClaimVerifiedNotifyInput,
): Promise<void> {
  try {
    const rendered = formatClaimVerifiedOperatorEmail(input, webOrigin(env));
    const result = await sendEmail(env, {
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
    });
    if (!result.sent) {
      logEvent("info", {
        component: "listing",
        event: "claim-verified-notify-skipped",
        reason: result.reason,
        domain: input.domain,
        orgSlug: input.orgSlug,
      });
    } else {
      logEvent("info", {
        component: "listing",
        event: "claim-verified-notify-sent",
        domain: input.domain,
        orgSlug: input.orgSlug,
        method: input.method,
      });
    }
  } catch (err) {
    logEvent("warn", {
      component: "listing",
      event: "claim-verified-notify-error",
      domain: input.domain,
      orgSlug: input.orgSlug,
      err,
    });
  }
}

/**
 * Fire owner confirmation + operator notify together. Never throws.
 * Call only on first successful verification.
 */
export async function onClaimVerified(
  env: ClaimVerifiedEmailEnv,
  input: ClaimVerifiedNotifyInput,
): Promise<void> {
  await Promise.all([
    sendClaimVerifiedEmail(env, {
      to: input.ownerEmail,
      domain: input.domain,
      orgName: input.orgName,
      orgSlug: input.orgSlug,
      method: input.method,
    }),
    notifyClaimVerified(env, input),
  ]);
}
