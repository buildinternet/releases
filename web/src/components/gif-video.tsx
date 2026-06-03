"use client";

import { useEffect, useRef, useState } from "react";
import { releaseVideoUrl } from "@/lib/media";

interface GifVideoProps {
  /** Original GIF source (third-party URL or R2 URL). */
  src: string;
  alt: string;
  className?: string;
}

/**
 * Renders an animated GIF as a Cloudflare Media Transformations MP4 (`<video>`),
 * which is ~95% smaller than the source GIF. On transform error it degrades to
 * the original GIF `<img>` (real content — never a placeholder). Respects
 * `prefers-reduced-motion`: when set, autoplay is paused and native controls are
 * shown so the user opts in to motion.
 */
export function GifVideo({ src, alt, className }: GifVideoProps) {
  const [failed, setFailed] = useState(false);
  const [reduceMotion, setReduceMotion] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setReduceMotion(true);
      videoRef.current?.pause();
    }
  }, []);

  if (failed) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={src}
        alt={alt}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        className={className}
      />
    );
  }

  return (
    <video
      ref={videoRef}
      src={releaseVideoUrl(src)}
      aria-label={alt || undefined}
      autoPlay={!reduceMotion}
      loop
      muted
      playsInline
      controls={reduceMotion}
      preload="metadata"
      className={className}
      onError={() => setFailed(true)}
    />
  );
}
