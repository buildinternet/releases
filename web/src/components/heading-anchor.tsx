/**
 * Hover-revealed "link to this section" affordance rendered beside docs
 * headings. Pure/server-safe — the reveal is CSS `group-hover` off the parent
 * heading's `group` class, so no client JS. The heading carries the id (from
 * `rehype-slug`); this just points a same-page fragment link at it.
 */
export function HeadingAnchor({ id }: { id: string }) {
  return (
    <a
      href={`#${id}`}
      aria-label="Link to this section"
      className="ml-2 inline-flex align-middle text-stone-400 no-underline opacity-0 transition-opacity hover:text-stone-600 focus:opacity-100 group-hover:opacity-100 dark:text-stone-500 dark:hover:text-stone-300"
    >
      <LinkIcon />
    </a>
  );
}

/** Chain-link glyph (SVG only, per the web UI icon convention). Decorative —
 *  the anchor carries the accessible label. */
function LinkIcon({ size = 15 }: { size?: number }) {
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
    >
      <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
      <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
    </svg>
  );
}
