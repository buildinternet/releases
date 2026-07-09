"use client";

import { useEffect, useState } from "react";

/**
 * Letter fallback that only swaps to a photo once the URL has loaded, and keeps
 * the previous photo painted while a new URL is in flight — avoids letter ↔ image
 * flicker on settings / account chrome (user avatar + workspace logo).
 */
export function StableImageAvatar({
  src,
  fallback,
  className = "h-full w-full object-cover",
  referrerPolicy,
}: {
  src?: string | null;
  /** Single character (or short text) when no image is available. */
  fallback: string;
  className?: string;
  referrerPolicy?: React.HTMLAttributeReferrerPolicy;
}) {
  const [broken, setBroken] = useState(false);
  const [shown, setShown] = useState<string | null>(src ?? null);

  useEffect(() => {
    setBroken(false);
    if (!src) {
      setShown(null);
      return;
    }
    if (src === shown) return;
    let cancelled = false;
    const img = new Image();
    img.onload = () => {
      if (!cancelled) setShown(src);
    };
    img.onerror = () => {
      if (!cancelled) {
        setBroken(true);
        // Keep previous shown image if we had one; only clear when nothing was up.
        setShown((prev) => prev);
      }
    };
    img.src = src;
    return () => {
      cancelled = true;
    };
    // Only react to src changes — `shown` is intentionally omitted.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  if (shown && !broken) {
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={shown}
        alt=""
        decoding="async"
        referrerPolicy={referrerPolicy}
        onError={() => setBroken(true)}
        className={className}
      />
    );
  }
  return <span aria-hidden="true">{fallback}</span>;
}
