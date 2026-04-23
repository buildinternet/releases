"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { CliCommand } from "@/components/cli-command";
import { LocalTimestamp } from "@/components/local-timestamp";
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

function ReleaseCard({ release }: { release: LiveRelease }) {
  const label = release.version ?? release.title ?? "(untitled)";
  return (
    <article className="border border-stone-200 dark:border-stone-800 rounded-md px-4 py-3">
      <div className="flex items-baseline justify-between gap-4">
        <Link
          href={`/source/${release.source.slug}`}
          className="text-sm font-medium text-stone-900 dark:text-stone-100 hover:underline"
        >
          {release.source.name}
        </Link>
        {release.publishedAt ? (
          <LocalTimestamp
            iso={release.publishedAt}
            className="text-xs text-stone-500 dark:text-stone-400"
          />
        ) : null}
      </div>
      <div className="mt-1 text-sm text-stone-700 dark:text-stone-300 font-mono">{label}</div>
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
        <div className="space-y-2">
          {releases.map((r) => (
            <ReleaseCard key={r.id} release={r} />
          ))}
        </div>
      )}
    </div>
  );
}
