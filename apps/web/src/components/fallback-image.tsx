"use client";

import { useState, type ReactNode } from "react";
import Image from "next/image";
import { isOptimizableImage } from "@/lib/sanitize";

function Placeholder({ className }: { className?: string }) {
  return (
    <div
      className={`rounded-md border border-dashed border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900 text-[11px] text-stone-400 dark:text-stone-500 px-3 py-2 inline-flex items-center ${className ?? ""}`}
      role="img"
      aria-label="Image unavailable"
    >
      Image unavailable
    </div>
  );
}

interface FallbackImageProps {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
  /**
   * Override the optimizer decision. Defaults to `!isOptimizableImage(src)`.
   * Pass `true` for URLs already optimized upstream (e.g. a Cloudflare
   * `/cdn-cgi/image/` transform) so next/image doesn't re-process them.
   */
  unoptimized?: boolean;
  /**
   * What to render when the image fails to load.
   * - `placeholder` (default): dashed "Image unavailable" chip — fine for
   *   body/content surfaces where the layout already reserved space.
   * - `hide`: render nothing. Prefer this for compact thumbnails / highlight
   *   reels so a broken asset never leaves a jagged broken-image icon.
   */
  fallback?: "placeholder" | "hide";
  /**
   * Sibling chrome (e.g. a play badge) that co-hides with the image when
   * `fallback="hide"`. Parent must still supply a `relative` wrapper for
   * absolutely positioned overlays. Prefer this over a local failed-state
   * when only the image + badge need to vanish.
   */
  chrome?: ReactNode;
  /**
   * Fires when the image fails to load (after the local failed state flips).
   * Use when outer chrome (zoom button, grid cell, linked video shell) must
   * also unmount — `fallback="hide"` / `chrome` alone only cover the image tree.
   */
  onLoadError?: () => void;
}

/** next/image wrapper that degrades on load error (placeholder or hide). */
export function FallbackImage({
  src,
  alt,
  width,
  height,
  className,
  unoptimized,
  fallback = "placeholder",
  chrome,
  onLoadError,
}: FallbackImageProps) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    if (fallback === "hide") return null;
    return <Placeholder className={className} />;
  }
  const image = (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      unoptimized={unoptimized ?? !isOptimizableImage(src)}
      onError={() => {
        setFailed(true);
        onLoadError?.();
      }}
    />
  );
  if (chrome == null) return image;
  return (
    <>
      {image}
      {chrome}
    </>
  );
}

interface FallbackPlainImageProps {
  src: string;
  alt: string;
  className?: string;
}

/** Plain <img> wrapper used inside ReactMarkdown for content images. */
export function FallbackPlainImage({ src, alt, className }: FallbackPlainImageProps) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Placeholder className={className} />;
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
