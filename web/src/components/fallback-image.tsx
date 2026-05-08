"use client";

import { useState } from "react";
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
}

/** next/image wrapper that renders a placeholder on load error. */
export function FallbackImage({ src, alt, width, height, className }: FallbackImageProps) {
  const [failed, setFailed] = useState(false);
  if (failed) return <Placeholder className={className} />;
  return (
    <Image
      src={src}
      alt={alt}
      width={width}
      height={height}
      className={className}
      unoptimized={!isOptimizableImage(src)}
      onError={() => setFailed(true)}
    />
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
