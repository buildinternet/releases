"use client";

import Link from "next/link";
import { LocalTimestamp } from "@/components/local-timestamp";
import { useReleaseStream, type LiveRelease } from "@/hooks/use-release-stream";

type StatusTone = "live" | "polling" | "reconnecting";

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

export function LiveStream({ apiUrl }: { apiUrl: string }) {
  const { releases, connected, mode } = useReleaseStream(apiUrl);
  const status = statusLabel(connected, mode);

  return (
    <div className="space-y-4">
      <div
        className="flex items-center gap-2 text-xs text-stone-600 dark:text-stone-400"
        role="status"
        aria-live="polite"
      >
        <StatusDot tone={status.tone} />
        <span>{status.label}</span>
      </div>

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
