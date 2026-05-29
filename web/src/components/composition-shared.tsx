import type { CSSProperties } from "react";
import type { ReleaseComposition } from "@buildinternet/releases-api-types";

/**
 * Shared primitives for the release-composition visualizations — the full
 * bar + legend on the detail page ({@link CompositionChip}) and the compact
 * micro-bar in feeds ({@link CompactComposition}). Both encode the same three
 * categories with the same colors, glyphs, and hover tooltip — "one system" —
 * so the encoding is defined exactly once, here.
 *
 * A redundant cue rides alongside color so the breakdown survives grayscale
 * and color-blindness: bar segments can carry a texture (solid / striped /
 * dotted) and the tooltip uses glyphs (`+` feature, `↑` enhancement, wrench
 * fix). Features and fixes are the classic green/red clash — texture and glyph
 * keep them unambiguous without color.
 */

type CatKey = "features" | "enhancements" | "fixes";

export interface CatMeta {
  key: CatKey;
  /** singular / plural noun for the inline label */
  one: string;
  many: string;
  /** plain-language description, shown in the hover tooltip */
  desc: string;
  /** segment + marker color, pulled from the site's product palette */
  color: string;
  /** redundant texture painted over the segment's solid color */
  pattern: "solid" | "stripes" | "dots";
}

// Visual order: new → improved → fixed.
const CATS: CatMeta[] = [
  {
    key: "features",
    one: "feature",
    many: "features",
    desc: "New capabilities",
    color: "var(--color-product-1)", // green
    pattern: "solid",
  },
  {
    key: "enhancements",
    one: "enhancement",
    many: "enhancements",
    desc: "Improvements to existing features",
    color: "var(--color-product-0)", // blue
    pattern: "stripes",
  },
  {
    key: "fixes",
    one: "fix",
    many: "fixes",
    desc: "Bug fixes",
    color: "var(--color-product-3)", // red
    pattern: "dots",
  },
];

export interface CompItem {
  cat: CatMeta;
  count: number;
}

/** Non-zero category items for a release, in visual order. */
export function compositionItems(composition: ReleaseComposition): CompItem[] {
  const counts: Record<CatKey, number> = {
    features: composition.features,
    enhancements: composition.enhancements,
    fixes: composition.bugs,
  };
  return CATS.map((cat) => ({ cat, count: counts[cat.key] })).filter((i) => i.count > 0);
}

export function label(count: number, cat: CatMeta): string {
  return `${count} ${count === 1 ? cat.one : cat.many}`;
}

/** Texture overlay painted over a segment's solid color. */
function patternStyle(pattern: CatMeta["pattern"]): CSSProperties {
  if (pattern === "stripes") {
    return {
      backgroundImage:
        "repeating-linear-gradient(45deg, rgba(0,0,0,0.34) 0 1.5px, transparent 1.5px 4.5px)",
    };
  }
  if (pattern === "dots") {
    return {
      backgroundImage: "radial-gradient(rgba(0,0,0,0.40) 1px, transparent 1.4px)",
      backgroundSize: "4px 4px",
    };
  }
  return {};
}

/**
 * The proportional bar itself — one segment per category, sized by `count`.
 * Shared by the full ({@link CompositionChip}) and compact
 * ({@link CompactComposition}) treatments, which only differ in dimensions,
 * whether segments carry texture, and how they're labelled for AT: pass an
 * `ariaLabel` when there's no accompanying legend text (the compact feed bar),
 * otherwise the bar is decorative (`aria-hidden`) and the legend conveys it.
 */
export function CompositionBar({
  items,
  width,
  height,
  gap,
  minWidth,
  textured = false,
  ariaLabel,
}: {
  items: CompItem[];
  width: number;
  height: number;
  gap: string;
  minWidth: string;
  textured?: boolean;
  ariaLabel?: string;
}) {
  return (
    <span
      {...(ariaLabel ? { role: "img", "aria-label": ariaLabel } : { "aria-hidden": true })}
      className="inline-flex flex-none overflow-hidden"
      style={{ width, height, gap, borderRadius: 9999 }}
    >
      {items.map((i) => (
        <span
          key={i.cat.key}
          style={{
            flexGrow: i.count,
            minWidth,
            background: i.cat.color,
            ...(textured ? patternStyle(i.cat.pattern) : {}),
          }}
        />
      ))}
    </span>
  );
}

/** Lucide wrench — the "fix" glyph. */
function Wrench({ color }: { color: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="12"
      height="12"
      fill="none"
      stroke={color}
      strokeWidth="2.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ display: "block" }}
    >
      <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
    </svg>
  );
}

/** Legend / tooltip marker: `+` feature, `↑` enhancement, wrench fix. */
export function Glyph({ cat }: { cat: CatMeta }) {
  if (cat.key === "fixes") {
    return (
      <span className="inline-flex h-3 w-3 flex-none items-center justify-center">
        <Wrench color={cat.color} />
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="inline-flex h-3 w-3 flex-none items-center justify-center font-mono text-[12px] font-semibold leading-none"
      style={{ color: cat.color }}
    >
      {cat.key === "features" ? "+" : "↑"}
    </span>
  );
}

/**
 * Hover tooltip shared by both treatments — "This release" + a row per category
 * (glyph · count · description) + an AI-tallied footer. Revealed via a named
 * `group/composition` hover so it never collides with other `group` ancestors
 * in a feed row. `align` anchors it to the left or right edge of the trigger
 * (the detail bar sits at the left of its row; the feed bar at the right).
 */
export function CompositionTooltip({
  items,
  align = "left",
}: {
  items: CompItem[];
  align?: "left" | "right";
}) {
  return (
    <span
      role="tooltip"
      className={`pointer-events-none absolute bottom-[calc(100%+9px)] ${align === "right" ? "right-0" : "left-0"} z-50 flex w-max max-w-[300px] translate-y-[3px] flex-col gap-[7px] rounded-[9px] border border-[#2a2e36] bg-[#16181d] px-[13px] py-[11px] text-left opacity-0 shadow-[0_8px_24px_rgba(0,0,0,0.35)] transition-[opacity,transform] duration-[120ms] ease-out group-hover/composition:translate-y-0 group-hover/composition:opacity-100`}
    >
      <span className="font-mono text-[10px] font-medium uppercase tracking-[0.08em] text-[#6f7480]">
        This release
      </span>
      {items.map((i) => (
        <span key={i.cat.key} className="flex items-center gap-2">
          <span className="inline-flex w-[13px] flex-none items-center justify-center">
            <Glyph cat={i.cat} />
          </span>
          <span className="whitespace-nowrap text-[12.5px] font-semibold text-[#e7e5e4]">
            {label(i.count, i.cat)}
          </span>
          <span className="text-[11.5px] text-[#8b8f98]">{i.cat.desc}</span>
        </span>
      ))}
      <span className="mt-[1px] border-t border-[#2a2e36] pt-2 text-[10.5px] text-[#6f7480]">
        AI-tallied from the release notes
      </span>
    </span>
  );
}
