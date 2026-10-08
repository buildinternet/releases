import { CATS, type CatMeta } from "@/components/composition-shared";

/**
 * Treemap band colors, derived from the shared composition palette so the
 * glance card and the release-page micro-bar stay one system. Fixes are
 * softened toward the tile surface: a red band reads as "alarm" at treemap
 * scale, and most weeks are fix-heavy. Ink is fixed-dark on the saturated
 * green/blue fills (they don't change between themes) and `--fg-2` on the
 * softened red, which does.
 */
export interface GlanceSegmentStyle {
  cat: CatMeta;
  legend: string;
  background: string;
  ink: string;
}

export const GLANCE_SEGMENTS: GlanceSegmentStyle[] = CATS.map((cat) => {
  const fixes = cat.key === "fixes";
  return {
    cat,
    legend: cat.many[0].toUpperCase() + cat.many.slice(1),
    background: fixes ? `color-mix(in oklch, ${cat.color} 30%, var(--surface-2))` : cat.color,
    ink: fixes ? "var(--fg-2)" : "#0c0a09",
  };
});
