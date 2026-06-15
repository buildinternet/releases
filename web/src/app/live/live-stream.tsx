"use client";

import Link from "next/link";
import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import type { MediaItem } from "@buildinternet/releases-api-types";
import { CliCommand } from "@/components/cli-command";
import { LocalTimestamp } from "@/components/local-timestamp";
import { orgAvatarSrc } from "@/components/org-avatar";
import { SourceTypeIcon } from "@/components/source-type-icon";
import { FallbackImage } from "@/components/fallback-image";
import { PlayBadge } from "@/components/play-badge";
import { ExternalLinkIcon } from "@/components/external-link-icon";
import { deriveFeedTitle } from "@/lib/release-title";
import { releaseThumbUrl, IMG_TRANSFORM_ON } from "@/lib/media";
import { isOptimizableImage } from "@/lib/sanitize";
import { useFaviconBadge } from "@/hooks/use-favicon-badge";
import { useReleaseStream, type LiveRelease } from "@/hooks/use-release-stream";

type StatusTone = "live" | "polling" | "reconnecting";

const BADGE_CAP = 9;

function statusLabel(
  connected: boolean,
  mode: "websocket" | "polling",
): { label: string; tone: StatusTone } {
  if (connected) return { label: "Live", tone: "live" };
  if (mode === "polling") return { label: "Polling (WebSocket unavailable)", tone: "polling" };
  return { label: "Reconnecting…", tone: "reconnecting" };
}

function StatusDot({ tone }: { tone: StatusTone }) {
  const color =
    tone === "live" ? "bg-emerald-500" : tone === "polling" ? "bg-stone-400" : "bg-amber-500";
  const pulse = tone === "live" ? "animate-pulse" : "";
  return (
    <span className={`inline-block w-2 h-2 rounded-full ${color} ${pulse}`} aria-hidden="true" />
  );
}

function firstImage(media: MediaItem[]): MediaItem | null {
  return media.find((m) => m.type === "image" || m.type === "gif") ?? null;
}

// A `type:"video"` item promoted from an inline body link (#1549): the watch URL
// lives on `linkUrl`, the poster on `url`/`r2Url`. Only these render a play card.
function firstVideo(media: MediaItem[]): MediaItem | null {
  return (
    media.find((m) => m.type === "video" && Boolean(m.linkUrl) && Boolean(m.r2Url ?? m.url)) ?? null
  );
}

// Inline media preview — one asset per card to keep the feed scannable. A hosted
// video wins (play-thumbnail linking out to its watch page, mirroring the
// release-detail card); otherwise the first image/gif renders as a bounded
// thumbnail. Null when the release carries no previewable media.
function MediaPreview({ release, heading }: { release: LiveRelease; heading: string }) {
  const video = firstVideo(release.media);
  if (video) {
    const poster = video.r2Url ?? video.url;
    return (
      <a
        href={video.linkUrl}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={video.alt ? `Watch video: ${video.alt}` : "Watch video"}
        className="group relative mt-3 block aspect-video w-full max-w-sm overflow-hidden rounded-lg border border-stone-200 bg-black no-underline dark:border-stone-800"
      >
        <FallbackImage
          src={releaseThumbUrl(poster, 1280)}
          alt={video.alt || heading}
          width={1280}
          height={720}
          className="h-full w-full object-cover"
          unoptimized={IMG_TRANSFORM_ON || undefined}
        />
        <PlayBadge size="sm" />
      </a>
    );
  }
  const img = firstImage(release.media);
  if (img) {
    return (
      <div className="mt-3">
        <FallbackImage
          src={img.r2Url ?? img.url}
          alt={img.alt || heading}
          width={480}
          height={300}
          className="rounded-md object-cover max-h-56 w-auto border border-stone-200 dark:border-stone-800"
        />
      </div>
    );
  }
  return null;
}

// Org avatar for the byline. Unlike the shared `OrgAvatar`, this omits itself
// entirely when there's no resolvable image (no stored avatar and no GitHub
// handle) or when the image fails to load — no initial-letter monogram.
function BylineAvatar({ src }: { src: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <Image
      src={src}
      alt=""
      width={18}
      height={18}
      className="rounded-full shrink-0"
      unoptimized={!isOptimizableImage(src)}
      onError={() => setFailed(true)}
    />
  );
}

function ReleaseCard({ release }: { release: LiveRelease }) {
  const { descriptive, versionLabel } = deriveFeedTitle({
    title: release.title ?? "",
    version: release.version,
    titleGenerated: release.titleGenerated,
    titleShort: release.titleShort,
  });
  // Lead with the descriptive (AI/parsed) headline; fall back to the version,
  // then the raw title. Demote the version to a small mono tag beside it — but
  // only when it adds something the headline doesn't already say.
  const heading = descriptive ?? versionLabel ?? release.title ?? "Release";
  const versionTag = versionLabel && versionLabel !== heading ? versionLabel : null;
  const org = release.org;
  // Byline leads with the product/source (the specific thing shipped) and
  // trails with the org as dim attribution — the company is context, not the
  // headline. `OrgSection`/search-results use the same hierarchy.
  const productLabel = release.product?.name ?? release.source.name;
  const orgName = org?.name ?? null;
  const orgSlug = org?.slug ?? null;
  const avatarSrc = orgAvatarSrc(org?.avatarUrl ?? null, org?.githubHandle ?? null, 18);
  // Drop the org name when it just restates the product/source label (e.g.
  // PostHog / PostHog) — same dedup as the search-results byline.
  const showOrg = !!orgName && !productLabel.toLowerCase().startsWith(orgName.toLowerCase());

  return (
    <article className="border border-stone-200 dark:border-stone-800 rounded-lg bg-white dark:bg-stone-900 px-4 py-3.5">
      {/* Byline: [avatar] product/source · org — small attribution, timestamp right */}
      <div className="flex items-center gap-2">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 text-[12px]">
          {avatarSrc && <BylineAvatar src={avatarSrc} />}
          <Link
            href={`/source/${release.source.slug}`}
            className="font-medium text-stone-700 dark:text-stone-200 hover:underline truncate"
          >
            {productLabel}
          </Link>
          {showOrg &&
            (orgSlug ? (
              <Link
                href={`/${orgSlug}`}
                className="shrink-0 text-stone-400 dark:text-stone-500 hover:text-stone-600 dark:hover:text-stone-300"
              >
                · {orgName}
              </Link>
            ) : (
              <span className="shrink-0 text-stone-400 dark:text-stone-500">· {orgName}</span>
            ))}
        </div>
        {release.publishedAt && (
          <LocalTimestamp
            iso={release.publishedAt}
            className="text-[11px] text-stone-400 dark:text-stone-500 shrink-0"
          />
        )}
      </div>

      {/* Headline + version */}
      <div className="mt-2.5 flex items-baseline gap-2 flex-wrap">
        <h3 className="m-0 text-[15px] font-semibold tracking-tight text-stone-900 dark:text-stone-100 leading-snug">
          <Link href={`/release/${release.id}`} className="hover:underline underline-offset-2">
            {heading}
          </Link>
        </h3>
        {versionTag && (
          <span className="font-mono text-[11.5px] text-stone-400 dark:text-stone-500">
            {versionTag}
          </span>
        )}
      </div>

      {release.summary && (
        <p className="mt-1.5 text-[13px] text-stone-600 dark:text-stone-400 leading-relaxed line-clamp-2">
          {release.summary}
        </p>
      )}

      <MediaPreview release={release} heading={heading} />

      <div className="mt-2.5 flex items-center gap-2 text-stone-400 dark:text-stone-500">
        {release.source.type && <SourceTypeIcon type={release.source.type} size={12} />}
        {release.url && (
          <a
            href={release.url}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-[11px] hover:text-stone-700 dark:hover:text-stone-200"
          >
            <ExternalLinkIcon size={11} />
            Source
          </a>
        )}
      </div>
    </article>
  );
}

/**
 * Track releases that arrived while the tab was hidden. Resets to 0 when the
 * tab becomes visible again. Drives the title prefix and (via hasUnseen) the
 * favicon badge.
 */
function useUnreadCount(releaseIds: string[]): number {
  const [unread, setUnread] = useState(0);
  const lastSeenIdRef = useRef<string | undefined>(undefined);
  const seenOnceRef = useRef(false);

  useEffect(() => {
    function reset() {
      setUnread(0);
      lastSeenIdRef.current = releaseIds[0];
    }
    if (!document.hidden) reset();
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) reset();
    });
    // No removeEventListener: handler is anonymous and this effect runs once.
    // The page-level component unmount tears down the whole island.
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // Seed lastSeen on the first render that has items, without counting the
    // initial REST backfill as unread.
    if (!seenOnceRef.current) {
      seenOnceRef.current = true;
      lastSeenIdRef.current = releaseIds[0];
      return;
    }
    if (!document.hidden) {
      lastSeenIdRef.current = releaseIds[0];
      return;
    }
    const lastSeen = lastSeenIdRef.current;
    if (!lastSeen) {
      if (releaseIds.length > 0) setUnread(releaseIds.length);
      return;
    }
    const idx = releaseIds.indexOf(lastSeen);
    const newCount = idx === -1 ? releaseIds.length : idx;
    if (newCount > 0) setUnread(newCount);
  }, [releaseIds]);

  return unread;
}

function useDocumentTitleBadge(unread: number) {
  useEffect(() => {
    const originalTitle = document.title;
    if (unread > 0) {
      const badge = unread > BADGE_CAP ? `${BADGE_CAP}+` : String(unread);
      document.title = `(${badge}) ${originalTitle.replace(/^\(\d+\+?\)\s*/, "")}`;
    } else {
      document.title = originalTitle.replace(/^\(\d+\+?\)\s*/, "");
    }
  }, [unread]);
}

export function LiveStream({ apiUrl }: { apiUrl: string }) {
  const { releases, connected, mode } = useReleaseStream(apiUrl);
  const status = statusLabel(connected, mode);
  const releaseIds = releases.map((r) => r.id);
  const unread = useUnreadCount(releaseIds);
  useDocumentTitleBadge(unread);
  useFaviconBadge({ connected, hasUnseen: unread > 0 });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div
          className="flex items-center gap-2 text-xs text-stone-600 dark:text-stone-400"
          role="status"
          aria-live="polite"
        >
          <StatusDot tone={status.tone} />
          <span>{status.label}</span>
        </div>
        <CliCommand command="npx @buildinternet/releases tail -f" className="" />
      </div>
      <p className="text-xs text-stone-500 dark:text-stone-400">
        Prefer your terminal? Run the command above to stream new releases as they arrive.
      </p>

      {releases.length === 0 ? (
        <p className="text-sm text-stone-500 dark:text-stone-400">Waiting for the next release…</p>
      ) : (
        <div className="space-y-3">
          {releases.map((r) => (
            <ReleaseCard key={r.id} release={r} />
          ))}
        </div>
      )}
    </div>
  );
}
