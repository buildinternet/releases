import type { ReleaseComposition } from "@buildinternet/releases-api-types";
import {
  compositionItems,
  label,
  Glyph,
  CompositionBar,
  CompositionTooltip,
} from "./composition-shared";

/**
 * Full release-composition visualization for the release detail header — a
 * proportional bar (one segment per category, sized by share of the changes)
 * with textured segments, an inline glyph legend, and a hover tooltip. See
 * {@link composition-shared} for the shared encoding it draws on.
 *
 * Renders nothing when composition is null/undefined or every count is zero.
 * Zero-count categories are dropped, so a bugfix-only release reads as just
 * "12 fixes".
 */
export function CompositionChip({
  composition,
  className,
}: {
  composition: ReleaseComposition | null | undefined;
  className?: string;
}) {
  if (!composition) return null;
  const items = compositionItems(composition);
  if (items.length === 0) return null;

  return (
    <span className={`group/composition relative inline-flex ${className ?? ""}`}>
      {/* The decorative bar + glyphs are aria-hidden; the legend's plain text
          ("6 features", …) is what a screen reader reads. */}
      <span className="inline-flex items-center gap-[11px]">
        {/* Proportional bar — textured segments, sized by share. */}
        <CompositionBar items={items} width={96} height={8} gap="1.5px" minWidth="3px" textured />
        {/* Inline legend — glyph + count, colored to match its segment. */}
        <span className="inline-flex items-center gap-3 text-[12.5px] text-stone-400 dark:text-stone-500">
          {items.map((i) => (
            <span key={i.cat.key} className="inline-flex items-center gap-1.5">
              <Glyph cat={i.cat} />
              {label(i.count, i.cat)}
            </span>
          ))}
        </span>
      </span>

      <CompositionTooltip items={items} align="left" />
    </span>
  );
}
