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

/** Workspace name, for the workspace-flavored auto-pause email. Raw SQL — this worker has no auth schema import. */
export async function getWorkspaceName(db: D1Db, workspaceId: string): Promise<string | null> {
  const row = await db.get<{ name: string }>(sql`
    SELECT name FROM "organization" WHERE id = ${workspaceId} LIMIT 1
  `);
  return row?.name ?? null;
}

/** Every owner/admin of a workspace, for the workspace-flavored auto-pause email. Raw SQL — no auth schema import here. */
export async function getWorkspaceOwnerAdminContacts(
  db: D1Db,
  workspaceId: string,
): Promise<WebhookUserContact[]> {
  const rows = await db.all<{ email: string; name: string }>(sql`
    SELECT u.email AS email, u.name AS name
    FROM "member" m
    JOIN "user" u ON u.id = m.user_id
    WHERE m.organization_id = ${workspaceId} AND m.role IN ('owner', 'admin')
  `);
  return rows.filter((row): row is WebhookUserContact => Boolean(row?.email));
}

interface AutoPauseEmailFields {
  recipientName: string | null;
  url: string;
  description: string | null;
  orgName: string | null;
  orgSlug: string | null;
  consecutiveFailures: number;
  lastError: string | null;
  disabledReason: string;
}

type AutoPauseOwnerContext =
  | { kind: "account"; accountUrl: string }
  | { kind: "workspace"; workspaceName: string; workspaceWebhooksUrl: string };

/**
 * Shared renderer for the personal and workspace auto-pause emails — the two
 * differ only in the owner-scoped label/copy/link (account vs. workspace)
 * and an extra "Workspace" data row. {@link formatUserAutoPauseEmail} and
 * {@link formatWorkspaceAutoPauseEmail} are thin wrappers over this.
 */
function formatAutoPauseEmail(
  input: AutoPauseEmailFields,
  owner: AutoPauseOwnerContext,
): { subject: string; text: string; html: string } {
  const label =
    input.description?.trim() ||
    (owner.kind === "workspace"
      ? `${owner.workspaceName} webhook`
      : input.orgName
        ? `${input.orgName} webhook`
        : "your follows webhook");

  const manageUrl = owner.kind === "workspace" ? owner.workspaceWebhooksUrl : owner.accountUrl;
  const manageLabel = owner.kind === "workspace" ? "Manage workspace webhooks" : "Manage webhooks";
  const patchPathHint =
    owner.kind === "workspace" ? "/v1/workspaces/:workspaceId/webhooks/:id" : "/v1/me/webhooks/:id";

  const blocks: EmailBlock[] = [];
  if (input.recipientName) blocks.push({ t: "p", text: `Hi ${input.recipientName},` });
  blocks.push({
    t: "p",
    text:
      owner.kind === "workspace"
        ? `We paused **${label}** in the **${owner.workspaceName}** workspace because we couldn't deliver events to its endpoint.`
        : `We paused **${label}** because we couldn't deliver events to your endpoint.`,
  });
  blocks.push({
    t: "data",
    rows: [
      { label: "Endpoint", value: input.url },
      ...(owner.kind === "workspace" ? [{ label: "Workspace", value: owner.workspaceName }] : []),
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
    text:
      owner.kind === "workspace"
        ? "While paused, we won't send new events to this URL. Fix the endpoint, then re-enable the webhook from the workspace's webhook settings."
        : "While paused, we won't send new events to this URL. Fix your endpoint, then re-enable the webhook from your account.",
  });
  blocks.push({ t: "button", label: manageLabel, url: manageUrl });
  blocks.push({
    t: "fine",
    text: `You can also use \`PATCH ${patchPathHint}\` with \`{"enabled": true}\` once delivery should work again.`,
  });

  const title =
    owner.kind === "workspace"
      ? `A ${owner.workspaceName} webhook was paused`
      : "Your Releases Index webhook was paused";

  const { html, text } = renderEmail({
    lane: owner.kind === "workspace" ? "Workspace · Webhooks" : "Account · Webhooks",
    title,
    preheader: `We paused ${label} after repeated delivery failures.`,
    blocks,
    footer: {
      reason:
        owner.kind === "workspace"
          ? `You received this because you're an owner or admin of the ${owner.workspaceName} workspace, and one of its webhook subscriptions was auto-paused.`
          : "You received this because a webhook subscription tied to your Releases Index account was auto-paused.",
      links: [{ label: manageLabel, href: manageUrl }],
    },
  });

  return { subject: title, text, html };
}

export function formatUserAutoPauseEmail(input: AutoPauseEmailFields & { accountUrl: string }): {
  subject: string;
  text: string;
  html: string;
} {
  return formatAutoPauseEmail(input, { kind: "account", accountUrl: input.accountUrl });
}

export function formatWorkspaceAutoPauseEmail(
  input: AutoPauseEmailFields & { workspaceName: string; workspaceWebhooksUrl: string },
): { subject: string; text: string; html: string } {
  return formatAutoPauseEmail(input, {
    kind: "workspace",
    workspaceName: input.workspaceName,
    workspaceWebhooksUrl: input.workspaceWebhooksUrl,
  });
}
