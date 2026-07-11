/**
 * Shared compact release-media thumbnail. One treatment reused across the home
 * ticker, org "latest releases" teaser, "also covered by" rail, and lookup
 * preview so every compact release surface reads as one system — matching the
 * related-rail card thumbnail. Renders nothing when `src` is falsy, so callers
 * pass a possibly-empty url without branching.
 */
export function ReleaseThumb({
  src,
  alt = "",
  size = "md",
}: {
  src: string | null | undefined;
  alt?: string;
  size?: "sm" | "md";
}) {
  if (!src) return null;
  const box = size === "sm" ? "w-8 h-8" : "w-10 h-10";
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      src={src}
      alt={alt}
      className={`shrink-0 ${box} rounded-md object-cover bg-stone-100 dark:bg-stone-800 outline outline-1 -outline-offset-1 outline-black/10 dark:outline-white/10`}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
    />
  );
}
