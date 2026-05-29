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
