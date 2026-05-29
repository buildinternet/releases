import type { VideoProvider, VideoProviderId } from "./types.js";
import { youtubeProvider } from "./youtube.js";

export const VIDEO_PROVIDERS: VideoProvider[] = [youtubeProvider];

/** Look up a provider by its stored id. Throws on unknown id. */
export function resolveVideoProvider(id: VideoProviderId | string): VideoProvider {
  const p = VIDEO_PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`Unknown video provider: ${id}`);
  return p;
}

/** First provider that claims this URL, or null. */
export function matchVideoUrl(url: string): VideoProvider | null {
  return VIDEO_PROVIDERS.find((p) => p.matchUrl(url)) ?? null;
}
