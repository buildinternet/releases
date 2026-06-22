// Both glyphs stay mounted, stacked, and cross-fade on `copied` so the
// copy→check swap eases instead of hard-cutting. No motion lib is installed, so
// the fade is a plain opacity transition on the project's standard easing.
const FADE = "absolute inset-0 transition-opacity duration-150 ease-[cubic-bezier(0.2,0,0,1)]";

export function CopyIcon({ copied, size = 16 }: { copied: boolean; size?: number }) {
  return (
    <span
      className="relative inline-block shrink-0"
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <svg
        className={`${FADE} ${copied ? "opacity-0" : "opacity-100"}`}
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
        <path d="M10.5 5.5V3.5a1.5 1.5 0 0 0-1.5-1.5H3.5A1.5 1.5 0 0 0 2 3.5V9a1.5 1.5 0 0 0 1.5 1.5h2" />
      </svg>
      <svg
        className={`${FADE} ${copied ? "opacity-100" : "opacity-0"}`}
        width={size}
        height={size}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <polyline points="3.5 8.5 6.5 11.5 12.5 4.5" />
      </svg>
    </span>
  );
}
