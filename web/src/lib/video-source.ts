/**
 * Display info for a video source. Video sources (`type === "video"`) carry
 * the provider discriminator in `metadata.video`; the resolved wire facet
 * `{ provider }` threads onto feed and search surfaces so the UI can render
 * a thumbnail-forward video row. Returns `null` for absent/null facets so
 * callers gate video-only treatment with `if (videoRowInfoFromWire(...))`.
 */
export interface VideoRowInfo {
  provider: "youtube" | "vimeo" | "wistia";
  /** Human-readable platform label shown on the "Watch on …" line. */
  label: "YouTube" | "Vimeo" | "Wistia";
}

const VIDEO_LABELS: Record<"youtube" | "vimeo" | "wistia", "YouTube" | "Vimeo" | "Wistia"> = {
  youtube: "YouTube",
  vimeo: "Vimeo",
  wistia: "Wistia",
};

/**
 * Build a {@link VideoRowInfo} from the wire-shape `video` block
 * (`{ provider }`, already resolved server-side by `videoSourceInfo`)
 * Returns null when the block is absent so callers gate video-only treatment
 * with `videoRowInfoFromWire(...)`. Mirrors `appRowInfoFromWire` in
 * `@/lib/app-source`.
 */
export function videoRowInfoFromWire(
  video: { provider: "youtube" | "vimeo" | "wistia" } | null | undefined,
): VideoRowInfo | null {
  if (!video) return null;
  return { provider: video.provider, label: VIDEO_LABELS[video.provider] };
}

interface VideoSourceLike {
  type: string;
  metadata?: string | null;
}

/**
 * Parse a {@link VideoRowInfo} from a source's raw metadata JSON.
 * Mirrors `getAppInfo` in `@/lib/app-source` — tolerant of null/missing/
 * malformed metadata. Returns `null` for non-video sources or when the
 * provider is absent or unrecognised.
 */
export function getVideoInfo(source: VideoSourceLike): VideoRowInfo | null {
  if (source.type !== "video") return null;
  try {
    const block = (JSON.parse(source.metadata ?? "{}") as { video?: { provider?: unknown } } | null)
      ?.video;
    const provider = block?.provider;
    if (provider === "youtube" || provider === "vimeo" || provider === "wistia") {
      return { provider, label: VIDEO_LABELS[provider] };
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Matches the 11-char YouTube video id in the URL shapes we encounter: the
 * watch URL (`?v=ID`), the share URL (`youtu.be/ID`), the embed URL
 * (`/embed/ID`), a `/shorts/ID` URL, and the thumbnail path
 * (`i.ytimg.com/vi/ID/…`). The fixed-width `[A-Za-z0-9_-]{11}` window plus the
 * trailing delimiter assertion keeps the `v=` arm from over-matching.
 */
const YOUTUBE_ID =
  /(?:v=|\/embed\/|\/shorts\/|\/vi\/|youtu\.be\/)([A-Za-z0-9_-]{11})(?:[^A-Za-z0-9_-]|$)/;

function youtubeIdFrom(value: string | null | undefined): string | null {
  if (!value) return null;
  const match = value.match(YOUTUBE_ID);
  return match ? match[1] : null;
}

/**
 * Resolve a YouTube video id from a release. The watch URL (`release.url`) is
 * the primary source; the stored thumbnail (`/vi/<id>/…`) is the fallback for
 * the rare row whose URL was rewritten. Returns null when no id is recoverable,
 * so callers gate the embed with `if (youtubeVideoId(...))`.
 */
export function youtubeVideoId(
  url: string | null | undefined,
  media?: ReadonlyArray<{ url: string }> | null,
): string | null {
  const fromUrl = youtubeIdFrom(url);
  if (fromUrl) return fromUrl;
  if (media) {
    for (const item of media) {
      const id = youtubeIdFrom(item?.url);
      if (id) return id;
    }
  }
  return null;
}

/**
 * Privacy-friendly embed URL on the `youtube-nocookie.com` host. Defaults to
 * autoplay for the click-to-play facade (the user has already opted in by
 * clicking); pass `{ autoplay: false }` for inline body-copy embeds that render
 * directly on load and must not start playing on their own.
 */
export function youtubeEmbedUrl(videoId: string, opts?: { autoplay?: boolean }): string {
  const params = opts?.autoplay === false ? "?rel=0" : "?autoplay=1&rel=0";
  return `https://www.youtube-nocookie.com/embed/${videoId}${params}`;
}

export interface VideoEmbedInfo {
  /** Provider-agnostic player URL for the `<VideoEmbed>` facade iframe. */
  embedUrl: string;
  /** Platform label shown on the facade chip (e.g. "YouTube"). */
  label: VideoRowInfo["label"];
}

/**
 * Resolve a playable embed for a release, dispatching on the wire `video`
 * facet's provider. Centralizes provider routing so the page stays declarative
 * and new providers (Vimeo/Wistia) plug in here rather than in the view.
 * Returns null when the source isn't a (recognised) video or no id is
 * recoverable, so callers gate with `if (resolveVideoEmbed(...))`.
 */
export function resolveVideoEmbed(
  video: { provider: "youtube" | "vimeo" | "wistia" } | null | undefined,
  url: string | null | undefined,
  media?: ReadonlyArray<{ url: string }> | null,
): VideoEmbedInfo | null {
  const info = videoRowInfoFromWire(video);
  if (!info) return null;
  if (info.provider === "youtube") {
    const videoId = youtubeVideoId(url, media);
    return videoId ? { embedUrl: youtubeEmbedUrl(videoId), label: info.label } : null;
  }
  // vimeo / wistia: facet recognised but no player wired yet.
  return null;
}
