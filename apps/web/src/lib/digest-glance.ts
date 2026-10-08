import type { DigestCoveredRelease } from "@/lib/api";
import type { ReleaseComposition } from "@buildinternet/releases-api-types";
import { sectionProducts } from "@/lib/digest-reel";

/**
 * "Week at a glance" math for a weekly collection digest: per-release impact,
 * per-product rollups (the treemap tiles), and the importance-ranked release
 * list. Pure — the card component only renders what this returns.
 *
 * Impact for one release, scoped to the week:
 * - Meaningful (importance 3/4/5) counts 2/3/4.
 * - Minor (importance null/1/2) has a base of 0.5/0.5/1. A product's minor
 *   releases share one pool that saturates at `4·(1−e^(−sum/8))`, split back
 *   across them in proportion to their base — ten patch releases can't
 *   outweigh one landmark.
 * - Each release is then scaled by what it contains:
 *   `(features + 0.75·enhancements + 0.5·fixes) / total`, or 0.6 when
 *   composition is missing.
 */

const MEANINGFUL_IMPACT: Record<number, number> = { 3: 2, 4: 3, 5: 4 };
const MINOR_CAP = 4;
const MINOR_SCALE = 8;
const UNKNOWN_COMPOSITION_FACTOR = 0.6;

/** Past this many products, the smallest fold into one "Others" tile. */
export const MAX_GLANCE_TILES = 8;
export const OTHERS_KEY = "others";

export type GlanceOrg = DigestCoveredRelease["org"];

export interface GlanceComposition {
  features: number;
  enhancements: number;
  fixes: number;
}

export interface GlanceProduct {
  /** `sectionProducts` key (product slug, else `org:<slug>`), or `others`. */
  key: string;
  name: string;
  /** Null for the "Others" group tile. */
  org: GlanceOrg | null;
  releaseCount: number;
  impact: number;
  composition: GlanceComposition;
  /** True when at least one release carried composition counts. */
  hasComposition: boolean;
  /** One entry per release scored 4 or 5, highest first. */
  flames: (4 | 5)[];
}

export interface GlanceRankedRelease {
  release: DigestCoveredRelease;
  /** Tile this release belongs to — `others` when its product was folded. */
  groupKey: string;
  productName: string;
  impact: number;
}

export interface Glance {
  /** Impact descending. */
  products: GlanceProduct[];
  /** Every release, importance descending then impact descending. */
  ranked: GlanceRankedRelease[];
}

function productKey(r: DigestCoveredRelease): string {
  return sectionProducts({ releases: [r] })[0].key;
}

function compositionFactor(c: ReleaseComposition | null | undefined): number {
  if (!c) return UNKNOWN_COMPOSITION_FACTOR;
  const total = c.features + c.enhancements + c.bugs;
  if (total === 0) return UNKNOWN_COMPOSITION_FACTOR;
  return (c.features + 0.75 * c.enhancements + 0.5 * c.bugs) / total;
}

function minorBase(importance: number | null | undefined): number {
  return importance === 2 ? 1 : 0.5;
}

function isMeaningful(importance: number | null | undefined): importance is 3 | 4 | 5 {
  return importance != null && importance >= 3;
}

/** Impact per release (same order as input). Exported for tests. */
export function releaseImpacts(releases: readonly DigestCoveredRelease[]): number[] {
  const factors = releases.map((r) => compositionFactor(r.composition));
  const pool = new Map<string, number>();
  releases.forEach((r, i) => {
    if (isMeaningful(r.importance)) return;
    const key = productKey(r);
    pool.set(key, (pool.get(key) ?? 0) + minorBase(r.importance) * factors[i]);
  });
  return releases.map((r, i) => {
    if (isMeaningful(r.importance)) return MEANINGFUL_IMPACT[r.importance] * factors[i];
    const sum = pool.get(productKey(r)) ?? 0;
    if (sum === 0) return 0;
    const capped = MINOR_CAP * (1 - Math.exp(-sum / MINOR_SCALE));
    return minorBase(r.importance) * factors[i] * (capped / sum);
  });
}

export function buildGlance(releases: readonly DigestCoveredRelease[]): Glance {
  const impacts = releaseImpacts(releases);
  const byKey = new Map<string, GlanceProduct>();
  releases.forEach((r, i) => {
    const key = productKey(r);
    let p = byKey.get(key);
    if (!p) {
      p = {
        key,
        name: r.product?.name ?? r.org.name,
        org: r.org,
        releaseCount: 0,
        impact: 0,
        composition: { features: 0, enhancements: 0, fixes: 0 },
        hasComposition: false,
        flames: [],
      };
      byKey.set(key, p);
    }
    p.releaseCount += 1;
    p.impact += impacts[i];
    if (r.composition) {
      p.hasComposition = true;
      p.composition.features += r.composition.features;
      p.composition.enhancements += r.composition.enhancements;
      p.composition.fixes += r.composition.bugs;
    }
    if (r.importance === 4 || r.importance === 5) p.flames.push(r.importance);
  });

  let products = [...byKey.values()].sort((a, b) => b.impact - a.impact);
  for (const p of products) p.flames.sort((a, b) => b - a);

  const groupOf = new Map(products.map((p) => [p.key, p.key]));
  if (products.length > MAX_GLANCE_TILES) {
    const kept = products.slice(0, MAX_GLANCE_TILES - 1);
    const rest = products.slice(MAX_GLANCE_TILES - 1);
    const others: GlanceProduct = {
      key: OTHERS_KEY,
      name: "Others",
      org: null,
      releaseCount: 0,
      impact: 0,
      composition: { features: 0, enhancements: 0, fixes: 0 },
      hasComposition: false,
      flames: [],
    };
    for (const p of rest) {
      groupOf.set(p.key, OTHERS_KEY);
      others.releaseCount += p.releaseCount;
      others.impact += p.impact;
      others.composition.features += p.composition.features;
      others.composition.enhancements += p.composition.enhancements;
      others.composition.fixes += p.composition.fixes;
      others.hasComposition ||= p.hasComposition;
      others.flames.push(...p.flames);
    }
    others.flames.sort((a, b) => b - a);
    products = [...kept, others];
  }

  const ranked = releases
    .map((release, i) => ({
      release,
      groupKey: groupOf.get(productKey(release)) ?? productKey(release),
      productName: release.product?.name ?? release.org.name,
      impact: impacts[i],
    }))
    .sort(
      (a, b) => (b.release.importance ?? 0) - (a.release.importance ?? 0) || b.impact - a.impact,
    );

  return { products, ranked };
}

/** Top `n` ranked releases, optionally limited to one tile's group. */
export function topReleases(
  ranked: readonly GlanceRankedRelease[],
  groupKey: string | null,
  n = 5,
): GlanceRankedRelease[] {
  return (groupKey ? ranked.filter((r) => r.groupKey === groupKey) : ranked).slice(0, n);
}

/**
 * Release id → the anchor of the first digest section that cites it, so a
 * list row can jump to where the prose discusses it.
 */
export function releaseSectionAnchors(
  sections: readonly { anchor: string; releaseIds: readonly string[] }[],
): Map<string, string> {
  const out = new Map<string, string>();
  for (const s of sections) {
    for (const id of s.releaseIds) if (!out.has(id)) out.set(id, s.anchor);
  }
  return out;
}
