/**
 * Pure formatters for the webhook operator alerts (DLQ batch + auto-disable).
 *
 * Both alerts used to lead with an opaque `whk_…` subscription id (and a bare
 * `org_…` for auto-disable), which told the operator nothing about which
 * integration broke. These formatters take the resolved subscription URL,
 * optional description, and owning org so the email names the endpoint and
 * company; the ids stay as trailing detail for admin lookup.
 *
 * No DB or `cloudflare:*` imports — the webhooks worker does the lookup and
 * passes the resolved shapes in, so this stays unit-testable.
 *
 * Lives in core-internal, not in `workers/webhooks`, because the API worker's
 * admin email preview (`email-samples.ts`) has to render these two alerts too.
 * It previously rebuilt them by hand from a "keep this in step" comment, and
 * they drifted — different lane, different blocks, different footer — so the
 * preview stopped showing what operators actually receive. One implementation,
 * imported by both, is the only version of that promise that holds.
 */

import { renderEmail, subjectNames, type EmailBlock } from "@releases/rendering/email-shell";

export type SubscriptionLabel = {
  id: string;
  url: string;
  description: string | null;
  orgName: string | null;
  orgSlug: string | null;
};

/** "Acme Inc (acme)", "acme", or "" when nothing resolved. */
export function orgLabel(orgName: string | null, orgSlug: string | null): string {
  const name = orgName?.trim() || null;
  const slug = orgSlug?.trim() || null;
  if (name && slug && name !== slug) return `${name} (${slug})`;
  return name ?? slug ?? "";
}

/** Body headline: org + description, degrading to url, then the bare id. */
export function subscriptionHeadline(label: SubscriptionLabel | null, subId: string): string {
  if (!label) return subId;
  const org = orgLabel(label.orgName, label.orgSlug);
  const desc = label.description?.trim();
  if (org && desc) return `${org} — ${desc}`;
  return org || desc || label.url || subId;
}

/** Subject identifier: concise (no description) — org, else url, else id. */
function subscriptionShortName(label: SubscriptionLabel | null, subId: string): string {
  if (!label) return subId;
  return orgLabel(label.orgName, label.orgSlug) || label.url || subId;
}

/** Indented "label:" padded to a fixed column so values line up vertically. */
function field(label: string, value: string): string {
  return `    ${`${label}:`.padEnd(12)}${value}`;
}

export type DlqEntry = {
  subId: string;
  count: number;
  lastError: string | null;
  label: SubscriptionLabel | null;
};

export function formatDlqAlert(entries: DlqEntry[]): {
  subject: string;
  body: string;
  html: string;
} {
  // Pinned byte-for-byte by alert-format.test.ts — the subject/body here stay
  // hand-built; only `html` below goes through the shared email shell.
  const totalMsgs = entries.reduce((s, e) => s + e.count, 0);
  const lines = [`${totalMsgs} message(s) reached the DLQ in this batch.`, ""];
  for (const e of entries) {
    lines.push(subscriptionHeadline(e.label, e.subId));
    if (e.label?.url) lines.push(field("url", e.label.url));
    lines.push(field("messages", String(e.count)));
    lines.push(field("last error", e.lastError ?? "unknown"));
    lines.push(field("sub id", e.subId));
    lines.push("");
  }
  const body = `${lines.join("\n").trimEnd()}\n`;

  const blocks: EmailBlock[] = entries.map((e) => ({
    t: "entity",
    coord: subscriptionHeadline(e.label, e.subId),
    metrics: `${e.count} message${e.count === 1 ? "" : "s"} · ${e.lastError ?? "unknown"} · ${e.subId}`,
    url: e.label?.url,
    sev: "crit",
  }));
  const { html } = renderEmail({
    lane: "Alert · Webhook DLQ",
    tone: "crit",
    title: `${totalMsgs} message(s) reached the DLQ`,
    blocks,
    footer: {
      reason:
        "Automated alert from Releases — delivery attempts for these webhook subscriptions exhausted their retries.",
    },
  });

  // Name whose endpoint is failing — "3 messages" alone doesn't say whether
  // this is one broken integration or a platform-wide problem.
  const affected = subjectNames(
    entries.map((e) => e.label?.orgName ?? e.label?.description ?? null),
  );
  return {
    subject: `[alert] webhook DLQ: ${totalMsgs} messages${affected ? ` — ${affected}` : ""}`,
    body,
    html,
  };
}

export type AutoDisableInfo = {
  subId: string;
  url: string;
  description: string | null;
  orgName: string | null;
  orgSlug: string | null;
  consecutiveFailures: number;
  lastError: string | null;
};

export function formatAutoDisableAlert(info: AutoDisableInfo): {
  subject: string;
  body: string;
  html: string;
} {
  // Pinned byte-for-byte by alert-format.test.ts — the subject/body here stay
  // hand-built; only `html` below goes through the shared email shell.
  const label: SubscriptionLabel = {
    id: info.subId,
    url: info.url,
    description: info.description,
    orgName: info.orgName,
    orgSlug: info.orgSlug,
  };
  const org = orgLabel(info.orgName, info.orgSlug);
  const lines = [
    `Webhook subscription auto-disabled after ${info.consecutiveFailures} consecutive failures.`,
    "",
    subscriptionHeadline(label, info.subId),
    field("url", info.url),
  ];
  if (org) lines.push(field("org", org));
  lines.push(field("failures", String(info.consecutiveFailures)));
  lines.push(field("last error", info.lastError ?? "unknown"));
  lines.push(field("sub id", info.subId));
  const body = `${lines.join("\n").trimEnd()}\n`;

  const blocks: EmailBlock[] = [
    {
      t: "entity",
      coord: subscriptionHeadline(label, info.subId),
      metrics: `${info.consecutiveFailures} consecutive failures · ${info.lastError ?? "unknown"} · ${info.subId}`,
      url: info.url,
      sev: "crit",
    },
  ];
  const { html } = renderEmail({
    lane: "Alert · Webhook auto-disable",
    tone: "crit",
    title: "Webhook subscription auto-disabled",
    subtitle: org || undefined,
    blocks,
    footer: {
      reason:
        "Automated alert from Releases — this webhook subscription was auto-disabled after repeated delivery failures.",
    },
  });

  return {
    subject: `[alert] webhook subscription auto-disabled: ${subscriptionShortName(label, info.subId)}`,
    body,
    html,
  };
}
