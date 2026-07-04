/**
 * Slack incoming-webhook message formatter. Pure + runtime-neutral so the
 * webhooks worker can render a release into Block Kit without importing
 * worker code. `SlackReleaseInput` is structurally satisfied by the worker's
 * `ReleaseEventPayload`. Discord later adds a sibling formatter + enum value.
 */

export interface SlackReleaseInput {
  id: string;
  title: string;
  version: string | null;
  publishedAt: string | null;
  summary: string | null;
  sourceName: string;
  org?: { name: string; avatarUrl: string | null; githubHandle: string | null } | null;
  product?: { name: string } | null;
  /** Slugged canonical release URL (#1906). Preferred over the bare-ID fallback. */
  webUrl?: string | null;
}

export interface SlackWebhookBody {
  /** Plain-text fallback for notifications / unfurl-less clients. */
  text: string;
  blocks: Record<string, unknown>[];
}

const DEFAULT_BASE_URL = "https://releases.sh";
const SUMMARY_MAX = 300;

const SLACK_ESCAPE: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;" };

/** Slack mrkdwn requires escaping these three characters. */
function escapeSlack(s: string): string {
  return s.replace(/[&<>]/g, (c) => SLACK_ESCAPE[c]!);
}

/** Truncate to `max`, preferring a word boundary past 60% of the limit, with an ellipsis. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

function avatarUrl(org: SlackReleaseInput["org"]): string | null {
  if (!org) return null;
  if (org.avatarUrl) return org.avatarUrl;
  if (org.githubHandle) return `https://github.com/${org.githubHandle}.png`;
  return null;
}

/** Slack `<!date>` mrkdwn so the timestamp localizes to the viewer; ISO date as fallback. */
function formatContextDate(publishedAt: string | null): string | null {
  if (!publishedAt) return null;
  const ms = Date.parse(publishedAt);
  if (Number.isNaN(ms)) return null;
  const unix = Math.floor(ms / 1000);
  const fallback = publishedAt.slice(0, 10);
  return `<!date^${unix}^{date_short_pretty}|${fallback}>`;
}

export function formatSlackMessage(
  release: SlackReleaseInput,
  opts?: { baseUrl?: string },
): SlackWebhookBody {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const url = release.webUrl ?? `${baseUrl}/release/${release.id}`;
  const titleText = `${release.title}${release.version ? ` ${release.version}` : ""}`;
  const contextName = release.org?.name ?? release.product?.name ?? release.sourceName;

  const sectionLines = [`*<${url}|${escapeSlack(titleText)}>*`];
  if (release.summary) sectionLines.push(escapeSlack(truncate(release.summary, SUMMARY_MAX)));
  const blocks: Record<string, unknown>[] = [
    { type: "section", text: { type: "mrkdwn", text: sectionLines.join("\n") } },
  ];

  const elements: Record<string, unknown>[] = [];
  const avatar = avatarUrl(release.org);
  if (avatar) elements.push({ type: "image", image_url: avatar, alt_text: contextName });
  const datePart = formatContextDate(release.publishedAt);
  elements.push({
    type: "mrkdwn",
    text: datePart ? `${escapeSlack(contextName)} · ${datePart}` : escapeSlack(contextName),
  });
  blocks.push({ type: "context", elements });

  // `text` is intentionally unescaped — plain-text notification preview, not mrkdwn.
  return { text: `${contextName} — ${titleText}`, blocks };
}
