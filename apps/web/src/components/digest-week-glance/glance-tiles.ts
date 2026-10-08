import {
  COMPOSITION_WEIGHTS,
  RELEASES_COVERED_ANCHOR,
  type GlanceProduct,
  type GlanceRankedRelease,
} from "@/lib/digest-glance";
import { label, type CatKey } from "@/components/composition-shared";
import { pluralReleases } from "@/lib/formatters";
import { GLANCE_SEGMENTS } from "./glance-colors";
import type { GlanceRow, GlanceTile } from "./glance-parts";
import { rectToPercent, TREEMAP_HEIGHT, TREEMAP_WIDTH, type Rect } from "./treemap-layout";

/**
 * Composition band segments, sized by each kind's weighted share of impact
 * and labelled with raw counts. Kinds with no items are left out.
 */
export function bandSegments(composition: Record<CatKey, number>): GlanceTile["segments"] {
  const parts = GLANCE_SEGMENTS.map((s) => ({
    s,
    count: composition[s.cat.key],
    weight: composition[s.cat.key] * COMPOSITION_WEIGHTS[s.cat.key],
  })).filter((x) => x.count > 0);
  const weightTotal = parts.reduce((sum, x) => sum + x.weight, 0);
  return parts.map(({ s, count, weight }) => ({
    key: s.cat.key,
    share: (weight / weightTotal) * 100,
    label: label(count, s.cat),
    background: s.background,
    ink: s.ink,
  }));
}

/**
 * One treemap tile's render data from its product rollup and laid-out rect.
 * Shared by the week-at-a-glance card and the replay's impact map, which pass
 * their own virtual box size.
 */
export function glanceTile(
  p: GlanceProduct,
  rect: Rect,
  box: { width: number; height: number } = { width: TREEMAP_WIDTH, height: TREEMAP_HEIGHT },
): GlanceTile {
  const majors = p.flames.length;
  return {
    key: p.key,
    name: p.name,
    org: p.org,
    countLabel: `${p.releaseCount} ${pluralReleases(p.releaseCount)}`,
    flames: p.flames,
    position: rectToPercent(rect, 2, box.width, box.height),
    segments: bandSegments(p.composition),
    ariaLabel: `${p.name}: ${p.releaseCount} ${pluralReleases(p.releaseCount)}${
      majors > 0 ? `, ${majors} major or landmark` : ""
    }`,
  };
}

/** A "Biggest releases" row, linked to the digest section that cites it. */
export function glanceRow(
  r: GlanceRankedRelease,
  anchors: ReadonlyMap<string, string>,
  base = "",
): GlanceRow {
  return {
    id: r.release.id,
    title: r.release.title,
    importance: r.release.importance ?? null,
    groupKey: r.groupKey,
    productName: r.productName,
    org: r.release.org,
    href: `${base}#${anchors.get(r.release.id) ?? RELEASES_COVERED_ANCHOR}`,
  };
}
