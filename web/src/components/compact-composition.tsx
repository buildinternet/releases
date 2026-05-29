import type { ReleaseComposition } from "@buildinternet/releases-api-types";
import { compositionItems, label, CompositionBar, CompositionTooltip } from "./composition-shared";

/**
 * Compact, legend-free composition micro-bar for dense release feeds (org /
 * product timelines, collections, categories). A quiet high-level read of a
 * release's shape — solid color segments sized by share — that doesn't compete
 * with the headline; the full breakdown is one hover away via the shared
 * {@link CompositionTooltip}, the same encoding as the detail page.
 *
 * Renders nothing when composition is null/undefined or every count is zero.
 */
export function CompactComposition({
  composition,
  className,
}: {
  composition: ReleaseComposition | null | undefined;
  className?: string;
}) {
  if (!composition) return null;
  const items = compositionItems(composition);
  if (items.length === 0) return null;

  const summary = items.map((i) => label(i.count, i.cat)).join(", ");

  return (
    <span className={`group/composition relative inline-flex items-center ${className ?? ""}`}>
      {/* Micro-bar — solid color segments, no legend, no texture. The
          aria-label carries the breakdown to screen readers (there's no
          visible text to read here, unlike the detail legend). */}
      <CompositionBar
        items={items}
        width={32}
        height={5}
        gap="1.2px"
        minWidth="2px"
        ariaLabel={`Release composition: ${summary}`}
      />

      <CompositionTooltip items={items} align="right" />
    </span>
  );
}
