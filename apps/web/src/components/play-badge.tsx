/**
 * Centered play-button overlay for video thumbnails — used on feed rows and the
 * release-detail facade so a still image reads as a playable video. SVG only
 * (no emoji, per the web UI convention) and decorative: `pointer-events-none`
 * keeps clicks flowing to the parent button/link. Scales up on `group-hover`
 * when an ancestor carries the `group` class. The parent must be `relative`.
 */
export function PlayBadge({ size = "md" }: { size?: "sm" | "md" }) {
  const ring = size === "sm" ? "h-8 w-8" : "h-16 w-16";
  const icon = size === "sm" ? "h-3.5 w-3.5" : "h-7 w-7";
  return (
    <span className="pointer-events-none absolute inset-0 flex items-center justify-center">
      <span
        className={`flex ${ring} items-center justify-center rounded-full bg-black/55 text-white shadow-sm backdrop-blur-sm transition-transform duration-150 group-hover:scale-110 group-hover:bg-black/70`}
      >
        <svg
          className={`${icon} translate-x-[1px]`}
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden="true"
        >
          <path d="M8 5v14l11-7z" />
        </svg>
      </span>
    </span>
  );
}
