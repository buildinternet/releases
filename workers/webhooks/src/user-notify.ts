import { sql } from "drizzle-orm";
import { renderEmail, type EmailBlock } from "@releases/rendering/email-shell";
import type { D1Db } from "./db.js";

export interface WebhookUserContact {
  email: string;
  name: string;
}

export async function getWebhookUserContact(
  db: D1Db,
  userId: string,
): Promise<WebhookUserContact | null> {
  const row = await db.get<{ email: string; name: string }>(sql`
    SELECT email, name FROM "user" WHERE id = ${userId} LIMIT 1
  `);
  if (!row?.email) return null;
  return { email: row.email, name: row.name };
}

export function formatUserAutoPauseEmail(input: {
  recipientName: string | null;
  url: string;
  description: string | null;
  orgName: string | null;
  orgSlug: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  disabledReason: string;
  accountUrl: string;
}): { subject: string; text: string; html: string } {
  const label =
    input.description?.trim() ||
    (input.orgName ? `${input.orgName} webhook` : "your follows webhook");

  const blocks: EmailBlock[] = [];
  if (input.recipientName) blocks.push({ t: "p", text: `Hi ${input.recipientName},` });
  blocks.push({
    t: "p",
    text: `We paused **${label}** because we couldn't deliver events to your endpoint.`,
  });
  blocks.push({
    t: "data",
    rows: [
      { label: "Endpoint", value: input.url },
      ...(input.orgName && input.orgSlug
        ? [{ label: "Org", value: `${input.orgName} (${input.orgSlug})` }]
        : []),
      {
        label: "Failures",
        value: `${input.consecutiveFailures} consecutive delivery failures`,
        kind: "err" as const,
      },
      ...(input.lastError
        ? [{ label: "Last error", value: input.lastError, kind: "err" as const }]
        : []),
      { label: "Reason", value: input.disabledReason },
    ],
  });
  blocks.push({
    t: "p",
    text: "While paused, we won't send new events to this URL. Fix your endpoint, then re-enable the webhook from your account.",
  });
  blocks.push({ t: "button", label: "Manage webhooks", url: input.accountUrl });
  blocks.push({
    t: "fine",
    text: 'You can also use `PATCH /v1/me/webhooks/:id` with `{"enabled": true}` once delivery should work again.',
  });

  const { html, text } = renderEmail({
    lane: "Account · Webhooks",
    title: "Your Releases webhook was paused",
    preheader: `We paused ${label} after repeated delivery failures.`,
    blocks,
    footer: {
      reason:
        "You received this because a webhook subscription tied to your Releases account was auto-paused.",
      links: [{ label: "Manage webhooks", href: input.accountUrl }],
    },
  });

  return { subject: "Your Releases webhook was paused", text, html };
}
