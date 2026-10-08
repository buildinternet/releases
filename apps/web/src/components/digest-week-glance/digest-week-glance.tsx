import type { CollectionWeeklyDigestDetail, DigestCoveredRelease } from "@/lib/api";
import { buildGlance, releaseSectionAnchors } from "@/lib/digest-glance";
import { ImportanceFlame } from "@/components/importance-marker";
import { GlanceSelection, type GlanceRow, type GlanceTile } from "./glance-selection";
import { rectToPercent, squarify } from "./treemap-layout";
import { GLANCE_SEGMENTS } from "./glance-colors";

/** Under this many covered releases the prose says it all — no card. */
export const MIN_GLANCE_RELEASES = 3;

/** Anchor of the page's "Releases covered" block — fallback for uncited rows. */
export const RELEASES_COVERED_ANCHOR = "releases-covered";

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
  const showTreemap = products.length > 1;

  const rects = squarify(products.map((p) => p.impact));
  const tiles: GlanceTile[] = products.map((p, i) => {
    const majors = p.flames.length;
    const counts = p.composition;
    // Band segments are sized by their weighted share of impact (the same
    // weights as the composition factor) and labelled with raw counts.
    const weights = {
      features: counts.features,
      enhancements: 0.75 * counts.enhancements,
      fixes: 0.5 * counts.fixes,
    };
    const weightTotal = weights.features + weights.enhancements + weights.fixes;
    return {
      key: p.key,
      name: p.name,
      org: p.org,
      releaseCount: p.releaseCount,
      flames: p.flames,
      position: rectToPercent(rects[i]),
      segments:
        weightTotal > 0
          ? GLANCE_SEGMENTS.filter((s) => counts[s.key] > 0).map((s) => ({
              key: s.key,
              share: (weights[s.key] / weightTotal) * 100,
              label: `${counts[s.key]} ${counts[s.key] === 1 ? s.one : s.many}`,
            }))
          : [],
      ariaLabel: `${p.name}: ${p.releaseCount} ${p.releaseCount === 1 ? "release" : "releases"}${
        majors > 0 ? `, ${majors} major or landmark` : ""
      }. Select to filter the list.`,
    };
  });

  const rows: GlanceRow[] = ranked.map((r) => ({
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
      <GlanceSelection
        tiles={showTreemap ? tiles : []}
        rows={rows}
        legend={showTreemap ? <GlanceLegend /> : null}
      />
    </section>
  );
}

function GlanceLegend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-[12px] text-[var(--fg-2)]">
      {GLANCE_SEGMENTS.map((s) => (
        <span key={s.key} className="inline-flex items-center gap-1.5">
          <span
            aria-hidden="true"
            className="h-2.5 w-2.5 rounded-[2px]"
            style={{
              background: s.background,
              boxShadow: s.key === "fixes" ? "inset 0 0 0 1px var(--line-2)" : undefined,
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
