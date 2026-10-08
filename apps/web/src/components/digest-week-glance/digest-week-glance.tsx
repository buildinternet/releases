import type { CollectionWeeklyDigestDetail, DigestCoveredRelease } from "@/lib/api";
import {
  buildGlance,
  COMPOSITION_WEIGHTS,
  GLANCE_TOP_N,
  RELEASES_COVERED_ANCHOR,
  releaseSectionAnchors,
} from "@/lib/digest-glance";
import { label } from "@/components/composition-shared";
import { ImportanceFlame } from "@/components/importance-marker";
import { pluralReleases } from "@/lib/formatters";
import { GlanceSelection, type GlanceRow, type GlanceTile } from "./glance-selection";
import { rectToPercent, squarify } from "./treemap-layout";
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
}: {
  releases: DigestCoveredRelease[];
  sections?: CollectionWeeklyDigestDetail["sections"];
}) {
  if (releases.length < MIN_GLANCE_RELEASES) return null;

  const { products, ranked } = buildGlance(releases);
  const anchors = releaseSectionAnchors(sections ?? []);

  // One product filling the whole box says nothing — list only.
  const rects = products.length > 1 ? squarify(products.map((p) => p.impact)) : [];
  const tiles: GlanceTile[] = rects.map((rect, i) => {
    const p = products[i];
    // Band segments are sized by their weighted share of impact and labelled
    // with raw counts.
    const parts = GLANCE_SEGMENTS.map((s) => ({
      s,
      count: p.composition[s.cat.key],
      weight: p.composition[s.cat.key] * COMPOSITION_WEIGHTS[s.cat.key],
    })).filter((x) => x.count > 0);
    const weightTotal = parts.reduce((sum, x) => sum + x.weight, 0);
    const majors = p.flames.length;
    return {
      key: p.key,
      name: p.name,
      org: p.org,
      countLabel: `${p.releaseCount} ${pluralReleases(p.releaseCount)}`,
      flames: p.flames,
      position: rectToPercent(rect),
      segments: parts.map(({ s, count, weight }) => ({
        key: s.cat.key,
        share: (weight / weightTotal) * 100,
        label: label(count, s.cat),
        background: s.background,
        ink: s.ink,
      })),
      ariaLabel: `${p.name}: ${p.releaseCount} ${pluralReleases(p.releaseCount)}${
        majors > 0 ? `, ${majors} major or landmark` : ""
      }. Select to filter the list.`,
    };
  });

  // Ship only rows the island can show: the overall top N plus each tile's top N.
  const perGroup = new Map<string, number>();
  const rows: GlanceRow[] = ranked
    .filter((r, i) => {
      const n = (perGroup.get(r.groupKey) ?? 0) + 1;
      perGroup.set(r.groupKey, n);
      return i < GLANCE_TOP_N || n <= GLANCE_TOP_N;
    })
    .map((r) => ({
      id: r.release.id,
      title: r.release.title,
      importance: r.release.importance ?? null,
      groupKey: r.groupKey,
      productName: r.productName,
      org: r.release.org,
      href: `#${anchors.get(r.release.id) ?? RELEASES_COVERED_ANCHOR}`,
    }));

  return (
    <section
      aria-labelledby="week-glance-title"
      className="mt-8 flex flex-col gap-3.5 rounded-[14px] border border-[var(--line)] bg-[var(--surface)] p-[18px]"
    >
      <h2
        id="week-glance-title"
        className="text-[15px] font-semibold tracking-tight text-[var(--fg)]"
      >
        The week at a glance
      </h2>
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
