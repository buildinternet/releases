import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { formatAutoDisableAlert } from "./alert-format.js";
import type { EmailEnv } from "./email.js";
import { sendWebhookAlert, sendWebhookUserNotice } from "./email.js";
import { getOrgLabelById } from "./queries.js";
import type { D1Db } from "./db.js";
import { formatUserAutoPauseEmail, getWebhookUserContact } from "./user-notify.js";

export type AutoDisableNotifyEnv = EmailEnv & { WEB_BASE_URL?: string };

/** Operator alert + owner transactional email after a subscription auto-pauses. */
export async function notifyAutoDisabledSubscription(
  db: D1Db,
  env: AutoDisableNotifyEnv,
  sub: WebhookSubscription,
  reason: string,
  lastError: string | null,
): Promise<void> {
  let org: { name: string; slug: string } | null = null;
  try {
    if (sub.orgId) org = await getOrgLabelById(db, sub.orgId);
  } catch (err) {
    logEvent("warn", {
      component: "webhook-auto-disable",
      event: "resolve-org-failed",
      subscriptionId: sub.id,
      err,
    });
  }

  const alert = formatAutoDisableAlert({
    subId: sub.id,
    url: sub.url,
    description: sub.description,
    orgName: org?.name ?? null,
    orgSlug: org?.slug ?? null,
    consecutiveFailures: sub.consecutiveFailures,
    lastError,
  });
  await sendWebhookAlert(env, alert.subject, alert.body, alert.html);

  if (!sub.userId) return;

  try {
    const contact = await getWebhookUserContact(db, sub.userId);
    if (!contact) return;

    const accountUrl = `${env.WEB_BASE_URL ?? "https://releases.sh"}/account`;
    const notice = formatUserAutoPauseEmail({
      recipientName: contact.name,
      url: sub.url,
      description: sub.description,
      orgName: org?.name ?? null,
      orgSlug: org?.slug ?? null,
      consecutiveFailures: sub.consecutiveFailures,
      lastError,
      disabledReason: reason,
      accountUrl,
    });
    await sendWebhookUserNotice(env, contact.email, notice.subject, notice.text, notice.html);
  } catch (err) {
    logEvent("warn", {
      component: "webhook-auto-disable",
      event: "user-notify-failed",
      subscriptionId: sub.id,
      err,
    });
  }
}
