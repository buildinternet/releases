import { RELEASES_BOT_UA } from "../user-agent.js";
import type { ParsedVideoFeed, VideoProvider } from "./types.js";

const FEED_ACCEPT = "application/atom+xml, application/rss+xml, application/xml";

export interface FetchVideoFeedResult extends ParsedVideoFeed {
  etag?: string;
  lastModified?: string;
}

/**
 * Fetch a video provider's feed (with conditional-GET headers) and parse it via
 * the provider. Transport mirrors `fetchAndParseFeed`; the parse is provider-
 * specific because the generic feed parser drops `media:thumbnail` /
 * `media:description`. A 304 returns empty releases + empty channel.
 */
export async function fetchAndParseVideoFeed(
  feedUrl: string,
  provider: VideoProvider,
  conditionalHeaders?: Record<string, string>,
  fetchImpl: typeof fetch = fetch,
): Promise<FetchVideoFeedResult> {
  const res = await fetchImpl(feedUrl, {
    headers: { "User-Agent": RELEASES_BOT_UA, Accept: FEED_ACCEPT, ...conditionalHeaders },
    redirect: "follow",
  });

  if (res.status === 304) return { channel: {}, releases: [] };
  if (!res.ok) throw new Error(`Video feed fetch failed: ${res.status} ${res.statusText}`);

  const body = await res.text();
  const parsed = provider.parseFeed(body);
  return {
    ...parsed,
    etag: res.headers.get("etag") ?? undefined,
    lastModified: res.headers.get("last-modified") ?? undefined,
  };
}

export { VIDEO_PROVIDERS, resolveVideoProvider, matchVideoUrl } from "./providers.js";
export { youtubeProvider } from "./youtube.js";
export type {
  VideoProvider,
  VideoProviderId,
  VideoChannelInfo,
  ResolvedVideoFeed,
  ParsedVideoFeed,
} from "./types.js";
