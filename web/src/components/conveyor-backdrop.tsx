"use client";

import type { CSSProperties } from "react";
import ConveyorBackground from "@/components/conveyor-background";
import { useTheme } from "@/components/theme-provider";

/**
 * Theme-aware wrapper around the generic <ConveyorBackground>.
 *
 * The canvas paints with very low alpha, so the look has to be tuned per theme
 * or the blocks vanish against the page background (light #fafaf9 / dark #0c0a09).
 *
 *   dark  — solid white extruded blocks (the original look; reads on the dark bg).
 *   light — faint near-black wireframe boxes with an occasional solid-green
 *           "shipped" crate. White-filled blocks were invisible on the light bg
 *           (you only saw the green flash); the outline style stays subtle while
 *           the green pop carries the product nod. The green is flash-driven, so
 *           it stays bold even though the outlines are deliberately ghost-faint.
 */
export function ConveyorBackdrop({ style }: { style?: CSSProperties }) {
  const { resolved } = useTheme();

  if (resolved === "dark") {
    return <ConveyorBackground baseColor="255,255,255" intensity={0.7} density={1} style={style} />;
  }

  return (
    <ConveyorBackground
      baseColor="28,25,23"
      variant="outline"
      intensity={0.25}
      density={1}
      shipFrequency={0.5}
      style={style}
    />
  );
}
