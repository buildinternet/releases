import { CATS } from "@/components/composition-shared";

/**
 * Treemap band colors, derived from the shared composition palette so the
 * glance card and the release-page micro-bar stay one system. Fixes are
 * softened toward the tile surface: a red band reads as "alarm" at treemap
 * scale, and most weeks are fix-heavy. Ink is fixed-dark on the saturated
 * green/blue fills (they don't change between themes) and `--fg-2` on the
 * softened red, which does.
 */

export type GlanceSegmentKey = "features" | "enhancements" | "fixes";

export interface GlanceSegmentStyle {
  key: GlanceSegmentKey;
  one: string;
  many: string;
  legend: string;
  background: string;
  ink: string;
}

const color = (key: GlanceSegmentKey) => CATS.find((c) => c.key === key)!.color;

export const FIXES_SOFTENED = `color-mix(in oklch, ${color("fixes")} 30%, var(--surface-2))`;

export const GLANCE_SEGMENTS: GlanceSegmentStyle[] = [
  {
    key: "features",
    one: "feature",
    many: "features",
    legend: "Features",
    background: color("features"),
    ink: "#0c0a09",
  },
  {
    key: "enhancements",
    one: "enhancement",
    many: "enhancements",
    legend: "Enhancements",
    background: color("enhancements"),
    ink: "#0c0a09",
  },
  {
    key: "fixes",
    one: "fix",
    many: "fixes",
    legend: "Fixes",
    background: FIXES_SOFTENED,
    ink: "var(--fg-2)",
  },
];

export const GLANCE_SEGMENT_BY_KEY = Object.fromEntries(
  GLANCE_SEGMENTS.map((s) => [s.key, s]),
) as Record<GlanceSegmentKey, GlanceSegmentStyle>;
