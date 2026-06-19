import { sql } from "drizzle-orm";
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
}): { subject: string; text: string } {
  const label =
    input.description?.trim() || (input.orgName ? `${input.orgName} webhook` : "your webhook");
  const orgLine =
    input.orgName && input.orgSlug ? `Organization: ${input.orgName} (${input.orgSlug})\n` : "";
  const greeting = input.recipientName ? `Hi ${input.recipientName},\n\n` : "";
  const errorLine = input.lastError ? `Recent error: ${input.lastError}\n` : "";

  return {
    subject: "Your Releases webhook was paused",
    text:
      `${greeting}` +
      `We paused "${label}" because we couldn't deliver events to your endpoint.\n\n` +
      `Endpoint: ${input.url}\n` +
      orgLine +
      `Failures: ${input.consecutiveFailures} consecutive delivery failures\n` +
      errorLine +
      `Reason: ${input.disabledReason}\n\n` +
      `While paused, we won't send new events to this URL. ` +
      `Fix your endpoint, then re-enable the webhook from your account:\n` +
      `${input.accountUrl}\n\n` +
      `You can also use PATCH /v1/me/webhooks/:id with {"enabled": true} once delivery should work again.`,
  };
}
