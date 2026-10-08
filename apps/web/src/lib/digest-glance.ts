import type { DigestCoveredRelease } from "@/lib/api";
import type { ReleaseComposition } from "@buildinternet/releases-api-types";
import type { CatKey } from "@/components/composition-shared";
import { productKeyOf } from "@/lib/digest-reel";

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
 * - Each release is then scaled by what it contains: the
 *   {@link COMPOSITION_WEIGHTS}-weighted mean of its counts, or 0.6 when
 *   composition is missing.
 */

const MEANINGFUL_IMPACT: Record<number, number> = { 3: 2, 4: 3, 5: 4 };
const MINOR_CAP = 4;
const MINOR_SCALE = 8;
const UNKNOWN_COMPOSITION_FACTOR = 0.6;

/** How much one item of each kind counts toward impact (and tile band width). */
export const COMPOSITION_WEIGHTS: Record<CatKey, number> = {
  features: 1,
  enhancements: 0.75,
  fixes: 0.5,
};

/** Rows the "Biggest releases" list shows. */
export const GLANCE_TOP_N = 5;

/** Past this many products, the smallest fold into one "Others" tile. */
export const MAX_GLANCE_TILES = 8;
export const OTHERS_KEY = "others";

/** Anchor of the digest page's "Releases covered" block — fallback for uncited rows. */
export const RELEASES_COVERED_ANCHOR = "releases-covered";

export type GlanceOrg = DigestCoveredRelease["org"];

export interface GlanceProduct {
  /** `productKeyOf` key, or `others`. */
  key: string;
  name: string;
  /** Null for the "Others" group tile. */
  org: GlanceOrg | null;
  releaseCount: number;
  impact: number;
  composition: Record<CatKey, number>;
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

function compositionFactor(c: ReleaseComposition | null | undefined): number {
  const total = c ? c.features + c.enhancements + c.bugs : 0;
  if (!c || total === 0) return UNKNOWN_COMPOSITION_FACTOR;
  const w = COMPOSITION_WEIGHTS;
  return (w.features * c.features + w.enhancements * c.enhancements + w.fixes * c.bugs) / total;
}

function minorBase(importance: number | null | undefined): number {
  return importance === 2 ? 1 : 0.5;
}

function isMeaningful(importance: number | null | undefined): importance is 3 | 4 | 5 {
  return importance != null && importance >= 3;
}

/** Impact per release (same order as input). Exported for tests. */
export function releaseImpacts(
  releases: readonly DigestCoveredRelease[],
  keys: readonly string[] = releases.map(productKeyOf),
): number[] {
  const factors = releases.map((r) => compositionFactor(r.composition));
  const pool = new Map<string, number>();
  releases.forEach((r, i) => {
    if (isMeaningful(r.importance)) return;
    pool.set(keys[i], (pool.get(keys[i]) ?? 0) + minorBase(r.importance) * factors[i]);
  });
  return releases.map((r, i) => {
    if (isMeaningful(r.importance)) return MEANINGFUL_IMPACT[r.importance] * factors[i];
    const sum = pool.get(keys[i]) ?? 0;
    if (sum === 0) return 0;
    const capped = MINOR_CAP * (1 - Math.exp(-sum / MINOR_SCALE));
    return minorBase(r.importance) * factors[i] * (capped / sum);
  });
}

export function emptyProduct(key: string, name: string, org: GlanceOrg | null): GlanceProduct {
  return {
    key,
    name,
    org,
    releaseCount: 0,
    impact: 0,
    composition: { features: 0, enhancements: 0, fixes: 0 },
    flames: [],
  };
}

/** Fold `src` (a product, or one release's contribution) into `into`. */
export function addInto(
  into: GlanceProduct,
  src: Pick<GlanceProduct, "releaseCount" | "impact" | "composition" | "flames">,
) {
  into.releaseCount += src.releaseCount;
  into.impact += src.impact;
  for (const k of Object.keys(into.composition) as CatKey[]) {
    into.composition[k] += src.composition[k];
  }
  into.flames.push(...src.flames);
}

/** One release's share of its product tile, given its impact. */
export function releaseContribution(
  r: DigestCoveredRelease,
  impact: number,
): Pick<GlanceProduct, "releaseCount" | "impact" | "composition" | "flames"> {
  const c = r.composition;
  return {
    releaseCount: 1,
    impact,
    composition: {
      features: c?.features ?? 0,
      enhancements: c?.enhancements ?? 0,
      fixes: c?.bugs ?? 0,
    },
    flames: r.importance === 4 || r.importance === 5 ? [r.importance] : [],
  };
}

export function buildGlance(releases: readonly DigestCoveredRelease[]): {
  /** Impact descending. */
  products: GlanceProduct[];
  /** Every release, importance descending then impact descending. */
  ranked: GlanceRankedRelease[];
} {
  const keys = releases.map(productKeyOf);
  const impacts = releaseImpacts(releases, keys);
  const byKey = new Map<string, GlanceProduct>();
  releases.forEach((r, i) => {
    let p = byKey.get(keys[i]);
    if (!p) {
      p = emptyProduct(keys[i], r.product?.name ?? r.org.name, r.org);
      byKey.set(keys[i], p);
    }
    addInto(p, releaseContribution(r, impacts[i]));
  });

  let products = [...byKey.values()].sort((a, b) => b.impact - a.impact);
  const groupOf = new Map(products.map((p) => [p.key, p.key]));
  if (products.length > MAX_GLANCE_TILES) {
    const others = emptyProduct(OTHERS_KEY, "Others", null);
    for (const p of products.slice(MAX_GLANCE_TILES - 1)) {
      groupOf.set(p.key, OTHERS_KEY);
      addInto(others, p);
    }
    products = [...products.slice(0, MAX_GLANCE_TILES - 1), others];
  }
  for (const p of products) p.flames.sort((a, b) => b - a);

  const ranked = releases
    .map((release, i) => ({
      release,
      groupKey: groupOf.get(keys[i])!,
      productName: byKey.get(keys[i])!.name,
      impact: impacts[i],
    }))
    .sort(
      (a, b) => (b.release.importance ?? 0) - (a.release.importance ?? 0) || b.impact - a.impact,
    );

  return { products, ranked };
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
