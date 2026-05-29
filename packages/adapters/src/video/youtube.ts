import { XMLParser } from "fast-xml-parser";
import { RELEASES_BOT_UA } from "../user-agent.js";
import type { RawRelease } from "../types.js";
import type {
  ParsedVideoFeed,
  ResolvedVideoFeed,
  VideoChannelInfo,
  VideoProvider,
} from "./types.js";

const FEED_BASE = "https://www.youtube.com/feeds/videos.xml";

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  // Keep namespace prefixes (media:group, yt:videoId) as literal keys.
  removeNSPrefix: false,
  // Trim leading/trailing whitespace from text nodes.
  trimValues: true,
});

/** fast-xml-parser collapses single children to objects; normalize to arrays. */
function toArray<T>(v: T | T[] | undefined): T[] {
  if (v === undefined || v === null) return [];
  return Array.isArray(v) ? v : [v];
}

function asString(v: unknown): string | undefined {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  return undefined;
}

interface YtEntry {
  "yt:videoId"?: string;
  title?: string;
  published?: string;
  link?: { "@_rel"?: string; "@_href"?: string } | Array<{ "@_rel"?: string; "@_href"?: string }>;
  "media:group"?: {
    "media:description"?: unknown;
    "media:thumbnail"?: { "@_url"?: string };
  };
}

function entryToRelease(entry: YtEntry): RawRelease | null {
  const videoId = asString(entry["yt:videoId"]);
  const title = asString(entry.title);
  if (!videoId || !title) return null;

  const links = toArray(entry.link);
  const alternate = links.find((l) => l["@_rel"] === "alternate") ?? links[0];
  const url = alternate?.["@_href"] ?? `https://www.youtube.com/watch?v=${videoId}`;

  const group = entry["media:group"];
  const description = asString(group?.["media:description"]) ?? "";
  const thumbUrl = group?.["media:thumbnail"]?.["@_url"];

  const publishedStr = asString(entry.published);
  const published = publishedStr ? new Date(publishedStr) : undefined;

  return {
    title,
    content: description,
    url,
    publishedAt: published && !Number.isNaN(published.getTime()) ? published : undefined,
    media: thumbUrl ? [{ type: "image", url: thumbUrl, alt: title }] : [],
    // Note: `contentFromSummary` is intentionally NOT set. That flag keys the
    // HTML-page feed-enrich path (`assessFeedDepth`), which would try to fetch
    // JS-heavy YouTube watch pages. A creator's description is the genuine
    // content, not a truncated summary of a fetchable page; the future
    // transcript-enrichment path is a separate mechanism.
  };
}

export function parseYouTubeFeed(xml: string): ParsedVideoFeed {
  const doc = parser.parse(xml) as { feed?: Record<string, unknown> };
  const feed = doc.feed ?? {};

  const author = feed.author as { name?: unknown } | undefined;
  const channel: VideoChannelInfo = {
    id: asString(feed["yt:channelId"]),
    title: asString(author?.name),
    playlistId: asString(feed["yt:playlistId"]),
    playlistTitle: asString(feed.title),
  };

  const releases = toArray(feed.entry as YtEntry | YtEntry[] | undefined)
    .map(entryToRelease)
    .filter((r): r is RawRelease => r !== null);

  return { channel, releases };
}

const PLAYLIST_RE = /[?&]list=([A-Za-z0-9_-]+)/;
const CHANNEL_ID_RE = /\/channel\/(UC[A-Za-z0-9_-]+)/;
const HANDLE_RE = /youtube\.com\/(@[A-Za-z0-9._-]+|c\/[^/?#]+|user\/[^/?#]+)/i;
const CHANNEL_ID_IN_PAGE_RE = /"channelId":"(UC[A-Za-z0-9_-]+)"/;

async function resolveFeed(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ResolvedVideoFeed> {
  const playlist = url.match(PLAYLIST_RE);
  if (playlist) {
    const id = playlist[1]!;
    return {
      feedUrl: `${FEED_BASE}?playlist_id=${id}`,
      canonicalUrl: `https://www.youtube.com/playlist?list=${id}`,
      channel: { playlistId: id },
    };
  }

  const byId = url.match(CHANNEL_ID_RE);
  if (byId) {
    const id = byId[1]!;
    return {
      feedUrl: `${FEED_BASE}?channel_id=${id}`,
      canonicalUrl: `https://www.youtube.com/channel/${id}`,
      channel: { id },
    };
  }

  const handleMatch = url.match(HANDLE_RE);
  if (handleMatch) {
    // Handles (@name, c/Name, user/Name) don't expose the channel_id directly;
    // fetch the page and scrape it. This is the one fragile path — playlist and
    // /channel/UC… URLs are pure. Send our bot UA so YouTube serves the real
    // page rather than a bot interstitial that lacks the channelId.
    const res = await fetchImpl(url, {
      redirect: "follow",
      headers: { "User-Agent": RELEASES_BOT_UA, Accept: "text/html" },
    });
    if (!res.ok) throw new Error(`YouTube channel page fetch failed: ${res.status}`);
    const html = await res.text();
    const idMatch = html.match(CHANNEL_ID_IN_PAGE_RE);
    if (!idMatch) throw new Error("Could not resolve channel_id from YouTube page");
    const id = idMatch[1]!;
    return {
      feedUrl: `${FEED_BASE}?channel_id=${id}`,
      canonicalUrl: url,
      channel: { id, handle: handleMatch[1] },
    };
  }

  // Reached by YouTube URLs we can't turn into a feed — most commonly a single
  // video (youtu.be/<id> or /watch?v=<id>). We onboard channels and playlists,
  // not individual videos.
  throw new Error(
    `Could not derive a YouTube feed from "${url}". Provide a channel (/channel/UC…, /@handle) or playlist (?list=…) URL, not a single video.`,
  );
}

export const youtubeProvider: VideoProvider = {
  id: "youtube",
  matchUrl: (url) => {
    try {
      const host = new URL(url).hostname.toLowerCase();
      return host === "youtube.com" || host === "www.youtube.com" || host === "youtu.be";
    } catch {
      return false;
    }
  },
  resolveFeed,
  parseFeed: parseYouTubeFeed,
};
