import { memo } from "react";
import { ImportanceFlame } from "@/components/importance-marker";
import { OrgAvatar } from "@/components/org-avatar";
import { compositionCounts } from "@/lib/digest-glance";
import {
  arrivalFade,
  arrivalGlow,
  type Replay,
  type ReplayFrame,
  type ReplayItem,
  type ReplayLane,
} from "@/lib/digest-replay";
import { bandSegments } from "@/components/digest-week-glance/glance-tiles";
import { columnLabel, columnLetter, weekPct } from "./replay-format";

/** Mark top offset (px) per packed row inside a 72px lane. */
const ROW_TOP = [11, 30, 49];
/** Label column width; collapses to the avatar at phone width. */
const LABEL_COL = "grid-cols-[150px_minmax(0,1fr)] max-[520px]:grid-cols-[32px_minmax(0,1fr)]";
const TRACK_INSET = "left-[150px] max-[520px]:left-[32px]";

/**
 * The river: one lane per product in the final ranking, day columns, a mark
 * per landed release and the playhead. Presentational — every value derives
 * from the frame's `t`.
 */
export function ReplayRiver({
  replay,
  frame,
  still,
}: {
  replay: Replay;
  frame: ReplayFrame;
  /** Reduced motion: marks appear at full size with no fade or glow. */
  still: boolean;
}) {
  return (
    <div className={`relative grid ${LABEL_COL}`}>
      <div />
      <div className="relative h-[22px]" aria-hidden="true">
        {replay.dayKeys.map((key, d) => {
          const current = !frame.ended && d === frame.dayIndex;
          return (
            <span
              key={key}
              className={`absolute top-0.5 whitespace-nowrap pl-1.5 font-mono text-[11px] ${
                current ? "font-medium text-[var(--fg)]" : "text-[var(--fg-3)]"
              }`}
              style={{ left: weekPct(d) }}
            >
              <span className="max-[520px]:hidden">{columnLabel(key)}</span>
              <span className="hidden max-[520px]:inline">{columnLetter(key)}</span>
            </span>
          );
        })}
      </div>

      {replay.lanes.map((lane) => (
        <Lane
          key={lane.key}
          lane={lane}
          items={lane.items.filter((it) => it.at <= frame.t)}
          t={frame.t}
          still={still}
        />
      ))}

      <div
        aria-hidden="true"
        className={`pointer-events-none absolute right-0 top-[22px] bottom-0 ${TRACK_INSET}`}
      >
        {[1, 2, 3, 4, 5, 6].map((d) => (
          <span
            key={d}
            className="absolute inset-y-0 w-px bg-[var(--line)]"
            style={{ left: weekPct(d) }}
          />
        ))}
        <span
          className="absolute inset-y-0 left-0 bg-[var(--fg)] opacity-[0.035]"
          style={{ width: weekPct(frame.t) }}
        />
        {!frame.ended && (
          <span
            className="absolute -top-1 bottom-0 -ml-[0.75px] w-[1.5px] bg-[var(--fg)] opacity-55"
            style={{ left: weekPct(frame.t) }}
          />
        )}
      </div>
    </div>
  );
}

function Lane({
  lane,
  items,
  t,
  still,
}: {
  lane: ReplayLane;
  items: ReplayItem[];
  t: number;
  still: boolean;
}) {
  return (
    <>
      <div className="flex h-[72px] min-w-0 items-center gap-2 border-t border-[var(--line)] pr-2.5">
        <LaneAvatar lane={lane} />
        <span
          className={`truncate text-[13px] font-semibold max-[520px]:sr-only ${
            items.length ? "text-[var(--fg)]" : "text-[var(--fg-3)]"
          }`}
        >
          {lane.name}
        </span>
        <span className="ml-auto font-mono text-[11px] text-[var(--fg-3)] max-[520px]:hidden">
          {items.length}
        </span>
      </div>
      <div className="relative h-[72px] border-t border-[var(--line)]" aria-hidden="true">
        {items.map((it) => (
          <Mark
            key={it.release.id}
            item={it}
            // Rounded so settled marks get identical props and skip re-rendering.
            fade={still ? 1 : round2(arrivalFade(t, it.at))}
            glow={still || (it.release.importance ?? 0) < 4 ? 0 : round2(arrivalGlow(t, it.at))}
          />
        ))}
      </div>
    </>
  );
}

function LaneAvatar({ lane }: { lane: ReplayLane }) {
  if (!lane.org) {
    return (
      <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[var(--line-2)] font-mono text-[11px] text-[var(--fg-2)]">
        +
      </span>
    );
  }
  return (
    <OrgAvatar
      avatarUrl={lane.org.avatarUrl ?? null}
      githubHandle={lane.org.githubHandle ?? null}
      name={lane.name}
      size={20}
    />
  );
}

const round2 = (v: number) => Math.round(v * 100) / 100;

const Mark = memo(function Mark({
  item,
  fade,
  glow,
}: {
  item: ReplayItem;
  /** 0 → 1 as the mark fades in. */
  fade: number;
  /** 1 → 0 as the arrival glow (importance 4–5) wears off. */
  glow: number;
}) {
  const importance = item.release.importance ?? 0;
  const segments = bandSegments(compositionCounts(item.release.composition));
  // Keep edge marks (early Monday, late Sunday) inside the track.
  const half = item.extent / 2;
  return (
    <span
      title={item.release.title}
      className="absolute inline-flex -translate-x-1/2 items-center gap-[3px]"
      style={{
        left: `clamp(${half}px, ${weekPct(item.at)}, calc(100% - ${half}px))`,
        top: ROW_TOP[item.row],
        opacity: 0.25 + 0.75 * fade,
      }}
    >
      {importance >= 4 && <ImportanceFlame importance={importance === 5 ? 5 : 4} />}
      <span
        className="flex h-3 gap-px overflow-hidden rounded-[3px] bg-[var(--line-2)]"
        style={{
          width: Math.round(item.markWidth * (0.7 + 0.3 * fade)),
          boxShadow:
            glow > 0 ? `0 0 0 3px rgb(249 115 22 / ${(glow * 0.45).toFixed(3)})` : undefined,
        }}
      >
        {segments.map((s) => (
          <span
            key={s.key}
            className="h-full"
            style={{ flex: `0 0 ${s.share.toFixed(2)}%`, background: s.background }}
          />
        ))}
      </span>
    </span>
  );
});
