import type { WebhookSubscription } from "@buildinternet/releases-core/schema";
import { logEvent } from "@releases/lib/log-event";
import { formatAutoDisableAlert } from "@releases/core-internal/webhook-alert-format";
import type { EmailEnv } from "./email.js";
import { sendWebhookAlert, sendWebhookUserNotice } from "./email.js";
import { getOrgLabelById } from "./queries.js";
import type { D1Db } from "./db.js";
import {
  formatUserAutoPauseEmail,
  formatWorkspaceAutoPauseEmail,
  getWebhookUserContact,
  getWorkspaceName,
  getWorkspaceOwnerAdminContacts,
} from "./user-notify.js";

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

  if (sub.workspaceId) {
    await notifyWorkspaceOwnersAdmins(db, env, sub, org, reason, lastError);
    return;
  }

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

/** Notify every owner/admin of a workspace-owned subscription's workspace. Send failures per-recipient are logged and don't block others. */
async function notifyWorkspaceOwnersAdmins(
  db: D1Db,
  env: AutoDisableNotifyEnv,
  sub: WebhookSubscription,
  org: { name: string; slug: string } | null,
  reason: string,
  lastError: string | null,
): Promise<void> {
  if (!sub.workspaceId) return;
  const workspaceId = sub.workspaceId;

  let workspaceName: string | null = null;
  let contacts: Awaited<ReturnType<typeof getWorkspaceOwnerAdminContacts>> = [];
  try {
    [workspaceName, contacts] = await Promise.all([
      getWorkspaceName(db, workspaceId),
      getWorkspaceOwnerAdminContacts(db, workspaceId),
    ]);
  } catch (err) {
    logEvent("warn", {
      component: "webhook-auto-disable",
      event: "workspace-notify-lookup-failed",
      subscriptionId: sub.id,
      workspaceId,
      err,
    });
    return;
  }
  if (!workspaceName || contacts.length === 0) return;

  const workspaceWebhooksUrl = `${env.WEB_BASE_URL ?? "https://releases.sh"}/account/workspace-webhooks`;
  const notice = formatWorkspaceAutoPauseEmail({
    recipientName: null,
    url: sub.url,
    description: sub.description,
    workspaceName,
    orgName: org?.name ?? null,
    orgSlug: org?.slug ?? null,
    consecutiveFailures: sub.consecutiveFailures,
    lastError,
    disabledReason: reason,
    workspaceWebhooksUrl,
  });

  for (const contact of contacts) {
    try {
      // oxlint-disable-next-line no-await-in-loop -- per-recipient sends must not block on each other's failures
      await sendWebhookUserNotice(env, contact.email, notice.subject, notice.text, notice.html);
    } catch (err) {
      logEvent("warn", {
        component: "webhook-auto-disable",
        event: "workspace-notify-failed",
        subscriptionId: sub.id,
        workspaceId,
        err,
      });
    }
  }
}
