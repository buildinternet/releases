/**
 * One-release notification when a semantic alert matches (#2304).
 * Renders through the shared email shell and sends on AUTH_EMAIL — the same
 * binding as digests and other account mail. The interest text is included
 * because the recipient wrote it. Callers must not log that text.
 */
import { logEvent } from "@releases/lib/log-event";
import { renderEmail, type EmailBlock } from "@releases/rendering/email-shell";
import type { AuthEmailBinding, AuthEmailEnv } from "../auth/email.js";

const DEFAULT_FROM = "noreply@releases.sh";
const DEFAULT_FROM_NAME = "Releases Index";

export interface SemanticAlertEmailInput {
  to: string;
  recipientName: string | null;
  /** The owner's interest. Shown in the message, never logged. */
  query: string;
  releaseTitle: string;
  sourceName: string;
  summary: string | null;
  releaseUrl: string | null;
  manageUrl: string;
  alertId: string;
  releaseId: string;
}

export function buildSemanticAlertEmail(
  input: Omit<SemanticAlertEmailInput, "to" | "alertId" | "releaseId">,
): { subject: string; text: string; html: string } {
  const title = input.releaseTitle.trim() || "A followed release";
  const short = title.length > 80 ? `${title.slice(0, 79)}…` : title;
  const blocks: EmailBlock[] = [];
  if (input.recipientName) blocks.push({ t: "p", text: `Hi ${input.recipientName},` });
  blocks.push({
    t: "p",
    text: `**${title}** from ${input.sourceName} matched an interest alert on your account.`,
  });
  if (input.summary?.trim()) blocks.push({ t: "p", text: input.summary.trim() });
  blocks.push({
    t: "data",
    rows: [{ label: "Interest", value: input.query }],
  });
  if (input.releaseUrl) {
    blocks.push({ t: "button", label: "View release", url: input.releaseUrl });
  }
  blocks.push({
    t: "fine",
    text: "Turn this alert off or edit it from your notification settings.",
  });
  blocks.push({ t: "button", label: "Manage alerts", url: input.manageUrl });

  const { html, text } = renderEmail({
    lane: "Alerts · Interest",
    title: short,
    preheader: `${input.sourceName} published a release that matched an alert.`,
    blocks,
    footer: {
      reason:
        "You received this because a release from something you follow matched a semantic alert on your Releases Index account.",
      links: [{ label: "Manage alerts", href: input.manageUrl }],
    },
  });
  return { subject: `A release matched your alert: ${short}`, text, html };
}

export async function sendSemanticAlertEmail(
  env: AuthEmailEnv & { AUTH_EMAIL?: AuthEmailBinding },
  input: SemanticAlertEmailInput,
): Promise<{ sent: boolean; reason?: "no_binding" | "error" }> {
  const { subject, text, html } = buildSemanticAlertEmail(input);
  const addr = env.AUTH_EMAIL_FROM || DEFAULT_FROM;
  const name = env.AUTH_EMAIL_FROM_NAME || DEFAULT_FROM_NAME;
  const from = `${name} <${addr}>`;

  if (!env.AUTH_EMAIL) {
    logEvent("warn", {
      component: "semantic-alerts",
      event: "email-no-binding",
      alertId: input.alertId,
      releaseId: input.releaseId,
    });
    return { sent: false, reason: "no_binding" };
  }

  try {
    await env.AUTH_EMAIL.send({ to: input.to, from, subject, text, html });
    logEvent("info", {
      component: "semantic-alerts",
      event: "email-sent",
      alertId: input.alertId,
      releaseId: input.releaseId,
    });
    return { sent: true };
  } catch (err) {
    logEvent("error", {
      component: "semantic-alerts",
      event: "email-send-failed",
      alertId: input.alertId,
      releaseId: input.releaseId,
      errName: err instanceof Error ? err.name : "Error",
    });
    return { sent: false, reason: "error" };
  }
}
