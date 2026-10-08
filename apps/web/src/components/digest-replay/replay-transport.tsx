import type { ReactNode } from "react";
import { ImportanceFlame } from "@/components/importance-marker";
import { REPLAY_DAYS, type Replay } from "@/lib/digest-replay";
import { dayLabel, weekPct } from "./replay-format";

/** Scrubber resolution: one step per minute of week time. */
const STEPS_PER_DAY = 24 * 60;

export interface ReplayTransportProps {
  replay: Replay;
  t: number;
  playing: boolean;
  speed: 1 | 2;
  /** Reduced motion: day step buttons replace play, speed, restart and skip. */
  still: boolean;
  onTogglePlay: () => void;
  onSeek: (t: number) => void;
  onToggleSpeed: () => void;
  onRestart: () => void;
  onSkipEnd: () => void;
  onPrevDay: () => void;
  onNextDay: () => void;
}

/**
 * Transport: play/pause (or previous/next day under reduced motion), a
 * scrubber with a tick per release and flame pins for importance 4–5, then
 * speed, restart and skip to end. Icon buttons carry `aria-label`; their
 * tooltips also show on focus.
 */
export function ReplayTransport(props: ReplayTransportProps) {
  const { replay, t, playing, speed, still } = props;
  const ended = t >= REPLAY_DAYS;
  const dayIndex = Math.min(REPLAY_DAYS - 1, Math.floor(t));
  const playLabel = playing ? "Pause" : ended ? "Replay" : "Play";

  return (
    <div className="flex flex-wrap items-center gap-3.5 border-t border-[var(--line)] pt-3.5">
      {still ? (
        <div className="flex gap-1.5">
          <IconButton label="Previous day" onClick={props.onPrevDay}>
            <path d="m15 18-6-6 6-6" />
          </IconButton>
          <IconButton label="Next day" onClick={props.onNextDay}>
            <path d="m9 18 6-6-6-6" />
          </IconButton>
        </div>
      ) : (
        <button
          type="button"
          onClick={props.onTogglePlay}
          aria-label={playLabel}
          className="group relative grid h-11 w-11 shrink-0 place-items-center rounded-full border border-[var(--line-2)] bg-[var(--surface)] text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            {playing ? (
              <>
                <rect x="3" y="2" width="3.5" height="12" rx="1" />
                <rect x="9.5" y="2" width="3.5" height="12" rx="1" />
              </>
            ) : (
              <path d="M4.5 2.5v11l9-5.5z" />
            )}
          </svg>
          <Tip>{playLabel}</Tip>
        </button>
      )}

      <div className="flex min-w-0 flex-[1_1_360px] flex-col gap-1">
        <div className="relative h-10">
          <div
            aria-hidden="true"
            className="absolute inset-x-0 top-[18px] h-1 rounded-sm bg-[var(--surface-2)]"
          />
          <div
            aria-hidden="true"
            className="absolute left-0 top-[18px] h-1 rounded-sm bg-[var(--fg-3)]"
            style={{ width: weekPct(t) }}
          />
          {replay.items.map((it) => {
            const importance = it.release.importance ?? 0;
            const landed = it.at <= t;
            return (
              <span key={it.release.id} aria-hidden="true">
                {importance >= 4 && (
                  <span
                    className="absolute top-1 flex -translate-x-1/2"
                    style={{ left: weekPct(it.at), opacity: landed ? 1 : 0.55 }}
                  >
                    <ImportanceFlame importance={importance === 5 ? 5 : 4} />
                  </span>
                )}
                <span
                  className={`absolute top-[26px] -ml-px h-1.5 w-0.5 rounded-[1px] ${
                    landed ? "bg-[var(--fg-2)]" : "bg-[var(--line-2)]"
                  }`}
                  style={{ left: weekPct(it.at) }}
                />
              </span>
            );
          })}
          <input
            type="range"
            min={0}
            max={REPLAY_DAYS * STEPS_PER_DAY}
            step={1}
            value={Math.round(t * STEPS_PER_DAY)}
            onChange={(e) => props.onSeek(Number(e.target.value) / STEPS_PER_DAY)}
            aria-label="Scrub through the week"
            aria-valuetext={ended ? "End of week" : dayLabel(replay.dayKeys[dayIndex])}
            className="replay-scrub absolute inset-0 m-0 h-full w-full cursor-ew-resize appearance-none bg-transparent focus-visible:rounded focus-visible:outline-2 focus-visible:outline-offset-[3px] focus-visible:outline-[var(--accent)]"
          />
        </div>
        <div className="flex justify-between font-mono text-[11px] text-[var(--fg-3)]">
          <span>{dayLabel(replay.dayKeys[0]).replace(",", "")}</span>
          <span>{dayLabel(replay.dayKeys[REPLAY_DAYS - 1]).replace(",", "")}</span>
        </div>
      </div>

      {!still && (
        <div className="flex gap-0.5">
          <IconButton
            label={`Playback speed ${speed}×. Switch to ${speed === 1 ? 2 : 1}×.`}
            tip={speed === 1 ? "Play at 2×" : "Play at 1×"}
            onClick={props.onToggleSpeed}
            text={`${speed}×`}
          />
          <IconButton label="Restart" onClick={props.onRestart}>
            <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
            <path d="M3 3v5h5" />
          </IconButton>
          <IconButton label="Skip to end" onClick={props.onSkipEnd}>
            <path d="M5 4l10 8-10 8z" />
            <path d="M19 5v14" />
          </IconButton>
        </div>
      )}
    </div>
  );
}

/** Hover/focus tooltip for an icon button. Decorative: the button has `aria-label`. */
function Tip({ children }: { children: ReactNode }) {
  return (
    <span
      aria-hidden="true"
      className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md bg-[var(--fg)] px-2 py-1.5 font-sans text-[12px] font-medium leading-none text-[var(--page)] opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100"
    >
      {children}
    </span>
  );
}

export function IconButton({
  label,
  tip = label,
  onClick,
  text,
  children,
}: {
  label: string;
  tip?: string;
  onClick: () => void;
  /** Short text in place of an icon (the speed toggle). */
  text?: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      onClick={onClick}
      className="group relative grid h-9 w-9 shrink-0 place-items-center rounded-lg text-[var(--fg-2)] transition-colors hover:bg-[var(--surface-2)] hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
    >
      {text ? (
        <span className="font-mono text-[12px] font-medium">{text}</span>
      ) : (
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          {children}
        </svg>
      )}
      <Tip>{tip}</Tip>
    </button>
  );
}
