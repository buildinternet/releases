import type { RawRelease } from "../types.js";

export type VideoProviderId = "youtube" | "vimeo" | "wistia";

export interface VideoChannelInfo {
  id?: string;
  handle?: string;
  title?: string;
  playlistId?: string;
  playlistTitle?: string;
}

export interface ResolvedVideoFeed {
  /** The Atom/RSS endpoint to poll (stored as metadata.feedUrl). */
  feedUrl: string;
  /** The human-facing URL (stored as source.url). */
  canonicalUrl: string;
  /** What we can derive pre-fetch; the feed fetch fills title/id. */
  channel: VideoChannelInfo;
}

export interface ParsedVideoFeed {
  channel: VideoChannelInfo;
  releases: RawRelease[];
}

export interface VideoProvider {
  id: VideoProviderId;
  /** Does this URL belong to the provider? */
  matchUrl(url: string): boolean;
  /** Turn a human channel/playlist URL into a feed endpoint + identity. */
  resolveFeed(url: string, fetchImpl?: typeof fetch): Promise<ResolvedVideoFeed>;
  /** Parse the provider's feed XML into channel meta + releases. */
  parseFeed(xml: string): ParsedVideoFeed;
}
