"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DigestCoveredRelease } from "@/lib/api";
import { ImportanceMarker } from "@/components/importance-marker";
import { OrgAvatar } from "@/components/org-avatar";
import {
  arrivalFade,
  buildReplay,
  frameAt,
  REPLAY_DAY_MS,
  REPLAY_DAYS,
  type ReplayCaption as Caption,
} from "@/lib/digest-replay";
import { glanceRow } from "@/components/digest-week-glance/glance-tiles";
import { ReplayRiver } from "./replay-river";
import { ReplayImpactMap } from "./replay-impact-map";
import { ReplayTransport } from "./replay-transport";
import { IconButton, RestartIcon } from "./replay-controls";
import { dayLabel, timeLabel } from "./replay-format";

/** Longest real-time step one animation frame may take (a backgrounded tab resumes cleanly). */
const MAX_FRAME_MS = 200;

function usePrefersReducedMotion(): boolean | null {
  const [reduced, setReduced] = useState<boolean | null>(null);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = () => setReduced(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

export interface ReplayStageProps {
  releases: DigestCoveredRelease[];
  weekStart: string;
  /** Release id → the digest section anchor that cites it. */
  anchors: Record<string, string>;
  /** The digest page; end-state rows and "Read the digest" link here. */
  digestHref: string;
  /** Open on the last frame (weeks too small to be worth playing). */
  startAtEnd?: boolean;
  /** Test seam: force reduced motion instead of reading the media query. */
  reducedMotion?: boolean;
}

/**
 * The replay's clock. Holds `t` (week time in days), play state and speed;
 * one `requestAnimationFrame` loop advances `t` while playing. Everything on
 * screen is rendered from `frameAt(replay, t)`.
 */
export function ReplayStage({
  releases,
  weekStart,
  anchors,
  digestHref,
  startAtEnd = false,
  reducedMotion,
}: ReplayStageProps) {
  const replay = useMemo(() => buildReplay(releases, weekStart), [releases, weekStart]);
  const anchorMap = useMemo(() => new Map(Object.entries(anchors)), [anchors]);
  const mediaReduced = usePrefersReducedMotion();
  const reduced = reducedMotion ?? mediaReduced;
  const still = reduced === true;

  const [t, setT] = useState(startAtEnd ? REPLAY_DAYS : 0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<1 | 2>(1);

  // Autoplay once, as soon as we know motion is allowed.
  const autoplayed = useRef(false);
  useEffect(() => {
    if (reduced === null || autoplayed.current) return;
    autoplayed.current = true;
    if (!reduced && !startAtEnd) setPlaying(true);
  }, [reduced, startAtEnd]);
  // Playing is a request; the clock runs only while motion is allowed and the week isn't over.
  const active = playing && !still && t < REPLAY_DAYS;

  useEffect(() => {
    if (!active) return;
    let last = performance.now();
    let id = requestAnimationFrame(function step(now) {
      const dt = Math.min(MAX_FRAME_MS, now - last);
      last = now;
      setT((prev) => Math.min(REPLAY_DAYS, prev + (dt / REPLAY_DAY_MS) * speed));
      id = requestAnimationFrame(step);
    });
    return () => cancelAnimationFrame(id);
  }, [active, speed]);

  const frame = useMemo(() => frameAt(replay, t), [replay, t]);
  // frame.top only changes when a release lands.
  const rows = useMemo(
    () => frame.top.map((r) => glanceRow(r, anchorMap, digestHref)),
    [frame.top, anchorMap, digestHref],
  );
  const restart = () => {
    setT(0);
    setPlaying(!still);
  };

  return (
    <section
      aria-label="Week replay"
      className="flex flex-col gap-[18px] rounded-[14px] border border-[var(--line)] bg-[var(--surface)] p-[18px]"
    >
      <div className="grid gap-5 min-[900px]:grid-cols-[minmax(0,1fr)_340px]">
        <div className="flex min-w-0 flex-col gap-3.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="font-mono text-[20px] font-medium tracking-tight">
              {dayLabel(replay.dayKeys[frame.dayIndex])}
            </span>
            {!frame.ended && (
              <span className="font-mono text-[11px] uppercase tracking-[0.12em] text-[var(--fg-3)]">
                Day {frame.dayIndex + 1} of {REPLAY_DAYS}
              </span>
            )}
          </div>

          <ReplayRiver replay={replay} frame={frame} still={still} />

          {/* Not a live region: captions change every few seconds. The end state holds the summary. */}
          <div className="min-h-28 border-t border-[var(--line)] pt-3.5">
            {frame.ended ? (
              <EndState digestHref={digestHref} onReplay={restart} />
            ) : frame.caption ? (
              <ReplayCaption caption={frame.caption} t={t} still={still} />
            ) : (
              <span className="text-[14px] text-[var(--fg-3)]">
                {still
                  ? "Step through the week a day at a time."
                  : "Press play to watch the week unfold."}
              </span>
            )}
          </div>
        </div>

        <ReplayImpactMap frame={frame} rows={rows} />
      </div>

      <ReplayTransport
        replay={replay}
        frame={frame}
        playing={active}
        speed={speed}
        still={still}
        onTogglePlay={() => {
          if (frame.ended) restart();
          else setPlaying(!active);
        }}
        onSeek={(next) => {
          setPlaying(false);
          setT(next);
        }}
        onToggleSpeed={() => setSpeed(speed === 1 ? 2 : 1)}
        onRestart={restart}
      />
    </section>
  );
}

function ReplayCaption({ caption, t, still }: { caption: Caption; t: number; still: boolean }) {
  const { item, kicker, moreCount } = caption;
  const r = item.release;
  const fade = still ? 1 : arrivalFade(t, item.at);
  const when = item.stamp
    ? `${dayLabel(item.stamp.dayKey)}${item.stamp.hasTime ? ` · ${timeLabel(r.publishedAt!)}` : ""}`
    : null;
  const byline = [item.productName, when, moreCount > 0 ? `+${moreCount} more` : null]
    .filter(Boolean)
    .join(" · ");
  return (
    <div
      className="flex items-start gap-3"
      style={{
        opacity: 0.2 + 0.8 * fade,
        transform: `translateY(${((1 - fade) * 4).toFixed(1)}px)`,
      }}
    >
      <OrgAvatar
        avatarUrl={r.org.avatarUrl ?? null}
        githubHandle={r.org.githubHandle ?? null}
        name={item.productName}
        size={36}
      />
      <div className="flex min-w-0 flex-col gap-[5px]">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--fg-3)]">
          {kicker}
        </span>
        <span className="flex items-baseline gap-1.5 text-balance text-[18px] font-semibold leading-snug tracking-tight">
          <ImportanceMarker importance={r.importance} />
          <span>{r.title}</span>
        </span>
        <span className="text-[13px] text-[var(--fg-2)]">{byline}</span>
      </div>
    </div>
  );
}

function EndState({ digestHref, onReplay }: { digestHref: string; onReplay: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="flex flex-col gap-1">
        <span className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--fg-3)]">
          End of week
        </span>
        <span className="text-[18px] font-semibold tracking-tight">
          The impact map is the week at a glance.
        </span>
      </div>
      <div className="flex items-center gap-2">
        <IconButton label="Replay the week" tip="Replay" onClick={onReplay}>
          <RestartIcon />
        </IconButton>
        <Link
          href={digestHref}
          className="inline-flex h-9 items-center rounded-lg border border-[var(--fg)] bg-[var(--fg)] px-3.5 text-[13px] font-medium text-[var(--page)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          Read the digest
        </Link>
      </div>
    </div>
  );
}
