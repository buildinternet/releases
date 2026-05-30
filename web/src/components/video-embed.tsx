"use client";

import { useState } from "react";
import { FallbackImage } from "./fallback-image";
import { PlayBadge } from "./play-badge";
import { releaseThumbUrl, IMG_TRANSFORM_ON } from "@/lib/media";

/**
 * Click-to-play video facade for the release detail page. Renders the thumbnail
 * with a {@link PlayBadge}; the heavy provider iframe (and its cookies) load
 * only after the user clicks, keeping detail pages fast and cookie-free until
 * opt-in. Provider-agnostic — the caller supplies the resolved `embedUrl` (see
 * `resolveVideoEmbed`). 16:9 responsive.
 */
export function VideoEmbed({
  embedUrl,
  thumbnailUrl,
  title,
  providerLabel,
}: {
  embedUrl: string;
  thumbnailUrl: string | null;
  title: string;
  providerLabel: string;
}) {
  const [playing, setPlaying] = useState(false);

  return (
    <div className="relative aspect-video w-full overflow-hidden rounded-lg border border-stone-200 bg-black dark:border-stone-800">
      {playing ? (
        <iframe
          src={embedUrl}
          title={title}
          className="absolute inset-0 h-full w-full"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : (
        <button
          type="button"
          onClick={() => setPlaying(true)}
          aria-label={`Play video: ${title}`}
          className="group absolute inset-0 h-full w-full cursor-pointer"
        >
          {thumbnailUrl && (
            <FallbackImage
              src={releaseThumbUrl(thumbnailUrl, 1280)}
              alt=""
              width={1280}
              height={720}
              className="h-full w-full object-cover"
              unoptimized={IMG_TRANSFORM_ON || undefined}
            />
          )}
          <PlayBadge />
          <span className="absolute bottom-2 right-2 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-medium text-white">
            {providerLabel}
          </span>
        </button>
      )}
    </div>
  );
}
