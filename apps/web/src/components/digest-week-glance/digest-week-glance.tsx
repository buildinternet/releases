import Link from "next/link";
import type { CollectionWeeklyDigestDetail, DigestCoveredRelease } from "@/lib/api";
import { buildGlance, GLANCE_TOP_N, releaseSectionAnchors } from "@/lib/digest-glance";
import { ImportanceFlame } from "@/components/importance-marker";
import { GlanceSelection } from "./glance-selection";
import type { GlanceRow, GlanceTile } from "./glance-parts";
import { squarify } from "./treemap-layout";
import { glanceRow, glanceTile } from "./glance-tiles";
import { GLANCE_SEGMENTS } from "./glance-colors";

/** Under this many covered releases the prose says it all — no card. */
const MIN_GLANCE_RELEASES = 3;

/**
 * "The week at a glance" card on a weekly collection digest: a treemap of who
 * shipped what this week (tile area = impact, band = features / enhancements /
 * fixes) above a list of the week's biggest releases. Static per week — all
 * the math runs here on the server; the client island only handles tile
 * selection.
 */
export function DigestWeekGlance({
  releases,
  sections,
  replayHref,
}: {
  releases: DigestCoveredRelease[];
  sections?: CollectionWeeklyDigestDetail["sections"];
  /** The week's replay page. The card (and so the link) needs 3+ releases. */
  replayHref?: string;
}) {
  if (releases.length < MIN_GLANCE_RELEASES) return null;

  const { products, ranked } = buildGlance(releases);
  const anchors = releaseSectionAnchors(sections ?? []);

  // One product filling the whole box says nothing — list only.
  const rects = products.length > 1 ? squarify(products.map((p) => p.impact)) : [];
  const tiles: GlanceTile[] = rects.map((rect, i) => glanceTile(products[i], rect));

  // Ship only rows the island can show: the overall top N plus each tile's top N.
  const perGroup = new Map<string, number>();
  const rows: GlanceRow[] = ranked
    .filter((r, i) => {
      const n = (perGroup.get(r.groupKey) ?? 0) + 1;
      perGroup.set(r.groupKey, n);
      return i < GLANCE_TOP_N || n <= GLANCE_TOP_N;
    })
    .map((r) => glanceRow(r, anchors));

  return (
    <section
      aria-labelledby="week-glance-title"
      className="mt-8 flex flex-col gap-3.5 rounded-[14px] border border-[var(--line)] bg-[var(--surface)] p-[18px]"
    >
      <div className="flex items-center justify-between gap-3">
        <h2
          id="week-glance-title"
          className="text-[15px] font-semibold tracking-tight text-[var(--fg)]"
        >
          The week at a glance
        </h2>
        {replayHref && (
          <Link
            href={replayHref}
            className="inline-flex items-center gap-1.5 rounded-md text-[13px] font-medium text-[var(--fg-2)] transition-colors hover:text-[var(--fg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--accent)]"
          >
            <svg width="12" height="12" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
              <path d="M4.5 2.5v11l9-5.5z" />
            </svg>
            Replay the week
          </Link>
        )}
      </div>
      <GlanceSelection tiles={tiles} rows={rows} legend={<GlanceLegend />} />
    </section>
  );
}

function GlanceLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--fg-2)]">
      {GLANCE_SEGMENTS.map((s) => (
        <span key={s.cat.key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-[2px]"
            style={{
              background: s.background,
              boxShadow: s.cat.key === "fixes" ? "inset 0 0 0 1px var(--line-2)" : undefined,
            }}
          />
          {s.legend}
        </span>
      ))}
      <span className="inline-flex items-center gap-1.5">
        <ImportanceFlame importance={4} />
        Major
      </span>
      <span className="inline-flex items-center gap-1.5">
        <ImportanceFlame importance={5} />
        Landmark
      </span>
      <span className="text-[var(--fg-3)]">Tile size reflects impact</span>
    </div>
  );
}
