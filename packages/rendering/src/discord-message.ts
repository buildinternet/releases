/**
 * Discord incoming-webhook message formatter. Sibling of `slack-message`:
 * same release fields, Discord embed body. Pure + runtime-neutral so the
 * webhooks worker can render without importing worker code.
 * `DiscordReleaseInput` is structurally satisfied by the worker's
 * `ReleaseEventPayload`.
 */

export interface DiscordReleaseInput {
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

export interface DiscordEmbedAuthor {
  name: string;
  icon_url?: string;
}

export interface DiscordEmbed {
  title: string;
  url: string;
  description?: string;
  color: number;
  author: DiscordEmbedAuthor;
  timestamp?: string;
}

export interface DiscordWebhookBody {
  /** Plain-text fallback for notification toasts / clients that skip embeds. */
  content: string;
  embeds: DiscordEmbed[];
  /** Incoming webhooks should never ping from release text. */
  allowed_mentions: { parse: [] };
}

const DEFAULT_BASE_URL = "https://releases.sh";
const SUMMARY_MAX = 300;
const TITLE_MAX = 256;
/** Discord blurple — left-edge accent on the embed. */
const EMBED_COLOR = 0x5865f2;

/** Truncate to `max`, preferring a word boundary past 60% of the limit, with an ellipsis. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const base = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${base.trimEnd()}…`;
}

function avatarUrl(org: DiscordReleaseInput["org"]): string | null {
  if (!org) return null;
  if (org.avatarUrl) return org.avatarUrl;
  if (org.githubHandle) return `https://github.com/${org.githubHandle}.png`;
  return null;
}

function isoTimestamp(publishedAt: string | null): string | undefined {
  if (!publishedAt) return undefined;
  const ms = Date.parse(publishedAt);
  if (Number.isNaN(ms)) return undefined;
  return new Date(ms).toISOString();
}

export function formatDiscordMessage(
  release: DiscordReleaseInput,
  opts?: { baseUrl?: string },
): DiscordWebhookBody {
  const baseUrl = opts?.baseUrl ?? DEFAULT_BASE_URL;
  const url = release.webUrl ?? `${baseUrl}/release/${release.id}`;
  const titleText = `${release.title}${release.version ? ` ${release.version}` : ""}`;
  const contextName = release.org?.name ?? release.product?.name ?? release.sourceName;
  const avatar = avatarUrl(release.org);

  const embed: DiscordEmbed = {
    title: truncate(titleText, TITLE_MAX),
    url,
    color: EMBED_COLOR,
    author: avatar ? { name: contextName, icon_url: avatar } : { name: contextName },
  };
  if (release.summary) embed.description = truncate(release.summary, SUMMARY_MAX);
  const timestamp = isoTimestamp(release.publishedAt);
  if (timestamp) embed.timestamp = timestamp;

  return {
    content: `${contextName} — ${titleText}`,
    embeds: [embed],
    allowed_mentions: { parse: [] },
  };
}
