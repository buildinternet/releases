/**
 * Small glyphs shared across the digest surfaces (homepage reel, collection
 * timeline, digest page). SVG only, per the web UI convention. Both are
 * decorative (`aria-hidden`) — the surrounding element carries any
 * accessible label.
 */

/** Outbound-link arrow marking an upstream release link. Distinct from
 *  {@link ExternalLinkIcon} (`./external-link-icon.tsx`) — a different glyph
 *  used elsewhere; do not conflate the two. */
export function ExternalArrow({ size, className }: { size: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.25"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M7 17 17 7" />
      <path d="M8 7h9v9" />
    </svg>
  );
}

/** Small notebook/journal glyph marking a digest — matches the icon used in
 *  the design mockup, shared by the homepage reel's newspaper cue and the
 *  collection timeline's inline digest cards. */
export function DigestIcon({ size = 13, className }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" />
      <path d="M18 14h-8" />
      <path d="M15 18h-5" />
      <path d="M10 6h8v4h-8V6Z" />
    </svg>
  );
}
