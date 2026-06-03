"use client";

import { useEffect, useRef, useState, type MouseEventHandler } from "react";
import { releaseVideoUrl } from "@/lib/media";

interface GifVideoProps {
  /** Original GIF source (third-party URL or R2 URL). */
  src: string;
  alt: string;
  className?: string;
  /**
   * Click handler on the rendered element (video, or the `<img>` fallback).
   * The gallery/collapsed thumbnails deliberately omit this so the click
   * bubbles to their wrapping `<button>` to open the lightbox; the lightbox
   * passes `stopPropagation` so clicking the video doesn't dismiss the overlay.
   */
  onClick?: MouseEventHandler<HTMLElement>;
}

/**
 * Renders an animated GIF as a Cloudflare Media Transformations MP4 (`<video>`),
 * which is ~95% smaller than the source GIF. On transform error it degrades to
 * the original GIF `<img>` (real content — never a placeholder). Respects
 * `prefers-reduced-motion`: when set, autoplay is paused and native controls are
 * shown so the user opts in to motion.
 */
export function GifVideo({ src, alt, className, onClick }: GifVideoProps) {
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
        onClick={onClick}
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
      onClick={onClick}
      onError={() => setFailed(true)}
    />
  );
}
