"use client";

import type { CSSProperties } from "react";
import ConveyorBackground from "@/components/conveyor-background";
import { useTheme } from "@/components/theme-provider";

/**
 * Theme-aware wrapper around the generic <ConveyorBackground>.
 *
 * The canvas paints blocks in `baseColor` with very low alpha, so the color has
 * to contrast with the page background or the blocks vanish. The homepage runs
 * light (#fafaf9) and dark (#0c0a09), so white blocks only read in dark mode —
 * in light mode they disappear and all you see is the emerald ship-flash. We
 * pick the block color from the resolved theme: near-black (stone-900) on light,
 * white on dark. The emerald accent reads on both.
 */
export function ConveyorBackdrop({
  intensity = 0.7,
  density = 1,
  style,
}: {
  intensity?: number;
  density?: number;
  style?: CSSProperties;
}) {
  const { resolved } = useTheme();
  const baseColor = resolved === "dark" ? "255,255,255" : "28,25,23";

  return (
    <ConveyorBackground
      baseColor={baseColor}
      intensity={intensity}
      density={density}
      style={style}
    />
  );
}
