import type { ReplayFrame } from "@/lib/digest-replay";
import {
  GlanceRowLink,
  GlanceTileBody,
  type GlanceRow,
} from "@/components/digest-week-glance/glance-selection";
import { glanceTile } from "@/components/digest-week-glance/glance-tiles";
import { squarify } from "@/components/digest-week-glance/treemap-layout";

/** Virtual box for the aside treemap (it sits beside the river, not full width). */
const BOX = { width: 340, height: 230 };

/**
 * The aside: a squarified map of impact so far plus the biggest releases. On
 * the last frame it is the week-at-a-glance card — same rollup, same rows.
 */
export function ReplayImpactMap({
  frame,
  rows,
  still,
}: {
  frame: ReplayFrame;
  /** `frame.top` as linked rows. */
  rows: GlanceRow[];
  /** Reduced motion: tiles jump instead of growing. */
  still: boolean;
}) {
  // Values stay in the final ranking's order, so tiles grow in place.
  const rects = squarify(
    frame.products.map((p) => p.impact),
    BOX.width,
    BOX.height,
  );
  const tiles = frame.products.flatMap((p, i) =>
    p.impact > 0 ? [glanceTile(p, rects[i], BOX)] : [],
  );

  return (
    <aside aria-label="Impact so far" className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="font-mono text-[10.5px] font-normal uppercase tracking-[0.16em] text-[var(--fg-3)]">
          {frame.ended ? "The week at a glance" : "Impact so far"}
        </h2>
        <InfoCard />
      </div>
      <div className="relative aspect-[340/230] w-full rounded-lg bg-[var(--page)]">
        {tiles.map((tile) => (
          <div
            key={tile.key}
            role="img"
            aria-label={tile.ariaLabel}
            className={`@container absolute overflow-hidden rounded-md bg-[var(--surface-2)] ${
              still
                ? ""
                : "transition-[left,top,width,height] duration-[600ms] ease-out motion-reduce:transition-none"
            }`}
            style={tile.position}
          >
            <GlanceTileBody tile={tile} />
          </div>
        ))}
        {tiles.length === 0 && (
          <span className="absolute inset-0 grid place-items-center text-[13px] text-[var(--fg-3)]">
            Nothing shipped yet
          </span>
        )}
      </div>
      <div className="flex flex-col gap-0.5">
        <h3 className="mb-0.5 ml-2 mt-1 font-mono text-[10.5px] font-normal uppercase tracking-[0.16em] text-[var(--fg-3)]">
          {frame.ended ? "Biggest releases" : "Biggest so far"}
        </h3>
        <ol className="flex flex-col gap-0.5">
          {rows.map((r, i) => (
            <li key={r.id}>
              <GlanceRowLink row={r} n={i + 1} />
            </li>
          ))}
        </ol>
      </div>
    </aside>
  );
}

/** "How tile size works", on hover and on focus. */
function InfoCard() {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label="How tile size works"
        aria-describedby="replay-impact-info"
        className="grid h-[22px] w-[22px] cursor-help place-items-center rounded-full text-[var(--fg-3)] hover:text-[var(--fg)] focus-visible:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-[var(--accent)]"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 16v-4" />
          <path d="M12 8h.01" />
        </svg>
      </button>
      <span
        id="replay-impact-info"
        role="tooltip"
        className="invisible absolute right-0 top-[calc(100%+6px)] z-10 w-60 rounded-lg border border-[var(--line-2)] bg-[var(--surface)] px-3 py-2.5 text-[12px] leading-normal text-[var(--fg-2)] opacity-0 shadow-lg transition-opacity group-hover:visible group-hover:opacity-100 group-has-[:focus-visible]:visible group-has-[:focus-visible]:opacity-100"
      >
        Tile size reflects impact: major releases count most, and a run of small fixes adds only a
        little. Colors show features, enhancements and fixes.
      </span>
    </span>
  );
}
