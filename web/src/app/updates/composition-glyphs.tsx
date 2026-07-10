import type { ReleaseComposition } from "@buildinternet/releases-core/composition";

/**
 * Glyph language for the `/updates` redesign feed (option 8a): a filled dot for
 * new/feature counts, a ring for improved/enhancement counts, a short dash for
 * fixed/bug counts. CSS shapes, not unicode characters, so sizing/color are
 * exact and screen readers get a real text alternative via `title`/`aria-label`
 * rather than reading a glyph character. Explicit scope cut (user decision):
 * no breaking-change diamond/severity glyph.
 */

function NewDot({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-[7px] w-[7px] shrink-0 rounded-full bg-emerald-600 dark:bg-emerald-500 ${className ?? ""}`}
    />
  );
}

function ImprovedRing({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-[8px] w-[8px] shrink-0 rounded-full border-[1.5px] border-stone-400 box-border dark:border-stone-500 ${className ?? ""}`}
    />
  );
}

function FixedDash({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={`inline-block h-[2.5px] w-[9px] shrink-0 rounded-full bg-stone-400 dark:bg-stone-500 ${className ?? ""}`}
    />
  );
}

/**
 * Fixed-order glyph+count row for one feed entry's composition: new, then
 * improved, then fixed — omitting any count that's zero. Renders nothing when
 * every count is zero/missing. Each glyph+count pair carries a `title` (and
 * matching `aria-label`) so the count reads as "3 new" / "1 improved" / "2
 * fixed" to assistive tech, not just a bare number next to a shape.
 */
export function GlyphCounts({
  composition,
  className,
}: {
  composition: ReleaseComposition | null | undefined;
  className?: string;
}) {
  if (!composition) return null;
  const { features, enhancements, bugs } = composition;
  if (features === 0 && enhancements === 0 && bugs === 0) return null;

  return (
    <span className={`inline-flex items-center gap-2 ${className ?? ""}`}>
      {features > 0 && (
        <span
          title={`${features} new`}
          aria-label={`${features} new`}
          className="inline-flex items-center gap-[3px] text-emerald-700 dark:text-emerald-400"
        >
          <NewDot />
          {features}
        </span>
      )}
      {enhancements > 0 && (
        <span
          title={`${enhancements} improved`}
          aria-label={`${enhancements} improved`}
          className="inline-flex items-center gap-[3px]"
        >
          <ImprovedRing />
          {enhancements}
        </span>
      )}
      {bugs > 0 && (
        <span
          title={`${bugs} fixed`}
          aria-label={`${bugs} fixed`}
          className="inline-flex items-center gap-[3px]"
        >
          <FixedDash />
          {bugs}
        </span>
      )}
    </span>
  );
}

/** Rail legend: the three glyphs plus the AI-tallied footnote. No breaking-
 *  change row — explicit scope cut (see module docblock). Hidden on mobile
 *  per the brief (the rail collapses to horizontal chip rows there). */
export function CompositionLegend() {
  return (
    <div>
      <h3 className="mb-2 text-[10.5px] font-bold uppercase tracking-[0.1em] text-stone-400 dark:text-stone-500">
        Legend
      </h3>
      <div className="flex flex-col gap-[7px] px-2.5 text-[12px] text-stone-500 dark:text-stone-400">
        <span className="flex items-center gap-[9px]">
          <NewDot />
          New
        </span>
        <span className="flex items-center gap-[9px]">
          <ImprovedRing />
          Improved
        </span>
        <span className="flex items-center gap-[9px]">
          <FixedDash />
          Fixed
        </span>
        <span className="mt-0.5 border-t border-stone-200 pt-2.5 text-[11px] leading-snug text-stone-400 dark:border-stone-800 dark:text-stone-500">
          AI-tallied from the release notes
        </span>
      </div>
    </div>
  );
}
