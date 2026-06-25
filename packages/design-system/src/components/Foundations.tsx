/**
 * Foundations — design-token reference cards for the Releases design system.
 *
 * Each named export is a self-contained showcase card that documents a slice
 * of the token vocabulary. Cards are intended to be rendered side-by-side in
 * the design tool to communicate the system to contributors and engineers.
 * All token values are consumed via CSS custom properties through Tailwind
 * arbitrary-value utilities — no color literals appear in this file.
 */
import { cx } from "../cx";

/* ── Shared class constants ─────────────────────────────────────────────── */

const card = "rounded-xl border border-stone-100 bg-white p-6 shadow-sm";
const sectionLabel = "font-mono text-[10px] uppercase tracking-[0.14em] text-stone-400 mb-2";
const tokenName = "font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400 mt-1.5";
const roleNote = "text-[11px] text-stone-400 mt-0.5";
const cardHeading = "font-mono text-[11px] uppercase tracking-[0.16em] text-stone-400 mb-5";

/* ─────────────────────────────────────────────────────────────────────────
   1. BrandColors
   ───────────────────────────────────────────────────────────────────────── */

/**
 * BrandColors — swatches for the three brand-accent tokens.
 *
 * `--accent` (brand blue) is shown as a filled block with `--on-accent`
 * (#fff) text to demonstrate the contrast pair; `--accent-soft` is shown as
 * the low-alpha wash applied to active/hover backgrounds throughout the UI.
 * @category Foundations
 */
export function BrandColors({ className }: { className?: string }) {
  return (
    <div className={cx(card, className)}>
      <p className={cardHeading}>Brand Colors</p>
      <div className="flex gap-4">
        {/* --accent + --on-accent pair */}
        <div className="flex-1">
          <div className="flex h-20 items-center justify-center rounded-lg bg-[var(--accent)]">
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--on-accent)]">
              --on-accent
            </span>
          </div>
          <p className={tokenName}>--accent</p>
          <p className={roleNote}>Brand blue · Primary actions &amp; links</p>
        </div>

        {/* --accent-soft */}
        <div className="flex-1">
          <div className="flex h-20 items-center justify-center rounded-lg border border-stone-100 bg-[var(--accent-soft)]">
            <span className="font-mono text-[11px] uppercase tracking-[0.16em] text-[var(--accent)]">
              wash
            </span>
          </div>
          <p className={tokenName}>--accent-soft</p>
          <p className={roleNote}>9 % alpha wash · Active backgrounds</p>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   2. ProductPalette
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Statically enumerated so Tailwind's content scanner detects each
 * arbitrary-value class at build time. Never interpolate these dynamically.
 */
const PRODUCT_SWATCHES: Array<{ bgClass: string; family: string }> = [
  { bgClass: "bg-[var(--color-product-0)]", family: "blue" },
  { bgClass: "bg-[var(--color-product-1)]", family: "green" },
  { bgClass: "bg-[var(--color-product-2)]", family: "amber" },
  { bgClass: "bg-[var(--color-product-3)]", family: "red" },
  { bgClass: "bg-[var(--color-product-4)]", family: "purple" },
  { bgClass: "bg-[var(--color-product-5)]", family: "pink" },
  { bgClass: "bg-[var(--color-product-6)]", family: "cyan" },
  { bgClass: "bg-[var(--color-product-7)]", family: "orange" },
];

/**
 * ProductPalette — eight categorical color swatches for multi-product charts.
 *
 * Maps `--color-product-0` through `--color-product-7` to their color-family
 * names. These tokens are used wherever releases from distinct products need a
 * harmonious but visually distinct color signal (charts, badges, sparklines).
 * @category Foundations
 */
export function ProductPalette({ className }: { className?: string }) {
  return (
    <div className={cx(card, className)}>
      <p className={cardHeading}>Product Palette</p>
      <div className="grid grid-cols-8 gap-2">
        {PRODUCT_SWATCHES.map(({ bgClass, family }, i) => (
          <div key={i} className="flex flex-col items-center">
            <div className={`h-12 w-full rounded-lg ${bgClass}`} />
            <p className="mt-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-stone-400">
              {i}
            </p>
            <p className="text-center text-[10px] leading-tight text-stone-400">{family}</p>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   3. SurfaceTokens
   ───────────────────────────────────────────────────────────────────────── */

/** Background swatches — statically listed for Tailwind scanning. */
const SURFACE_BG_SWATCHES: Array<{ bgClass: string; token: string; desc: string }> = [
  { bgClass: "bg-[var(--page)]", token: "--page", desc: "page bg" },
  { bgClass: "bg-[var(--surface)]", token: "--surface", desc: "card bg" },
  { bgClass: "bg-[var(--surface-2)]", token: "--surface-2", desc: "subtle fill" },
  { bgClass: "bg-[var(--field)]", token: "--field", desc: "input bg" },
];

/**
 * SurfaceTokens — the org-surface neutral ramp and status indicators.
 *
 * Covers all eleven tokens scoped to `.org-surface` in styles.css:
 * background (`--page`, `--surface`, `--surface-2`, `--field`), foreground
 * (`--fg`, `--fg-2`, `--fg-3`), border (`--line`, `--line-2`), and status
 * (`--good`, `--fix`). The inner wrapper carries the `org-surface` class so
 * all custom properties resolve to their light-mode values.
 * @category Foundations
 */
export function SurfaceTokens({ className }: { className?: string }) {
  return (
    <div className={cx(card, className)}>
      <p className={cardHeading}>Surface &amp; Neutral Tokens</p>

      {/* All org-surface vars resolve inside this wrapper */}
      <div className="org-surface space-y-5">
        {/* ── Backgrounds ── */}
        <div>
          <p className={sectionLabel}>backgrounds</p>
          <div className="flex gap-2">
            {SURFACE_BG_SWATCHES.map(({ bgClass, token, desc }) => (
              <div key={token} className="flex-1">
                <div className={`h-10 rounded-md border border-[var(--line)] ${bgClass}`} />
                <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.1em] text-stone-400">
                  {token}
                </p>
                <p className="text-[10px] text-stone-400">{desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* ── Foreground ── */}
        <div>
          <p className={sectionLabel}>foreground</p>
          <div className="space-y-1.5">
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 font-mono text-[10px] tracking-[0.1em] text-stone-400">
                --fg
              </span>
              <span className="text-sm font-semibold text-[var(--fg)]">Primary text</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 font-mono text-[10px] tracking-[0.1em] text-stone-400">
                --fg-2
              </span>
              <span className="text-sm text-[var(--fg-2)]">Secondary text</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 font-mono text-[10px] tracking-[0.1em] text-stone-400">
                --fg-3
              </span>
              <span className="text-sm text-[var(--fg-3)]">Placeholder / muted</span>
            </div>
          </div>
        </div>

        {/* ── Borders ── */}
        <div>
          <p className={sectionLabel}>borders</p>
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 font-mono text-[10px] tracking-[0.1em] text-stone-400">
                --line
              </span>
              <div className="h-px flex-1 bg-[var(--line)]" />
            </div>
            <div className="flex items-center gap-3">
              <span className="w-24 shrink-0 font-mono text-[10px] tracking-[0.1em] text-stone-400">
                --line-2
              </span>
              <div className="h-px flex-1 bg-[var(--line-2)]" />
            </div>
          </div>
        </div>

        {/* ── Status ── */}
        <div>
          <p className={sectionLabel}>status</p>
          <div className="flex gap-5">
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full bg-[var(--good)]" />
              <span className="font-mono text-[10px] tracking-[0.1em] text-stone-400">
                --good · green
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="h-3 w-3 rounded-full bg-[var(--fix)]" />
              <span className="font-mono text-[10px] tracking-[0.1em] text-stone-400">
                --fix · amber
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   4. Typography
   ───────────────────────────────────────────────────────────────────────── */

/**
 * Typography — a three-level type-scale specimen.
 *
 * - **Eyebrow** (`font-mono text-[11px] uppercase tracking-[0.16em]`): the
 *   structural chrome label — section titles, token names, date prefixes.
 *   Uses `--font-mono` (JetBrains Mono via the `@theme` declaration).
 * - **Heading** (`text-[25px] font-semibold tracking-tight`): primary content
 *   title weight used on org pages, release headings, and collection covers.
 * - **Body** (`text-sm leading-relaxed text-stone-600`): prose descriptions,
 *   metadata captions, and supporting copy.
 * @category Foundations
 */
export function Typography({ className }: { className?: string }) {
  return (
    <div className={cx(card, className)}>
      <p className={cardHeading}>Typography</p>
      <div className="space-y-7">
        {/* Eyebrow */}
        <div className="flex items-start gap-4">
          <span className="w-20 shrink-0 font-mono text-[10px] tracking-[0.1em] text-stone-400 pt-0.5">
            eyebrow
          </span>
          <div>
            <p className="font-mono text-[11px] uppercase tracking-[0.16em] text-stone-700">
              Releases · Changelog
            </p>
            <p className="mt-1.5 font-mono text-[10px] tracking-[0.1em] text-stone-400">
              font-mono · 11 px · uppercase · tracking-[0.16em]
            </p>
          </div>
        </div>

        {/* Heading */}
        <div className="flex items-start gap-4">
          <span className="w-20 shrink-0 font-mono text-[10px] tracking-[0.1em] text-stone-400 pt-1.5">
            heading
          </span>
          <div>
            <p className="text-[25px] font-semibold leading-none tracking-tight text-stone-900">
              What shipped this week
            </p>
            <p className="mt-1.5 font-mono text-[10px] tracking-[0.1em] text-stone-400">
              25 px · font-semibold · tracking-tight
            </p>
          </div>
        </div>

        {/* Body */}
        <div className="flex items-start gap-4">
          <span className="w-20 shrink-0 font-mono text-[10px] tracking-[0.1em] text-stone-400 pt-0.5">
            body
          </span>
          <div>
            <p className="text-sm leading-relaxed text-stone-600">
              A curated index of product changelog entries, release notes, and version announcements
              — organised by org and updated automatically as new versions ship.
            </p>
            <p className="mt-1.5 font-mono text-[10px] tracking-[0.1em] text-stone-400">
              text-sm · leading-relaxed · text-stone-600
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────────
   5. Radius
   ───────────────────────────────────────────────────────────────────────── */

/** Statically listed so Tailwind scans every rounded-* utility. */
const RADIUS_SPECIMENS: Array<{ radiusClass: string; label: string; desc: string }> = [
  { radiusClass: "rounded-lg", label: "rounded-lg", desc: "8 px · chips" },
  {
    radiusClass: "rounded-[9px]",
    label: "rounded-[9px]",
    desc: "9 px · inputs / buttons",
  },
  { radiusClass: "rounded-xl", label: "rounded-xl", desc: "12 px · cards" },
  { radiusClass: "rounded-full", label: "rounded-full", desc: "∞ · toggles" },
];

/**
 * Radius — four corner-radius specimens demonstrating the system's rounding ramp.
 *
 * - `rounded-lg` (8 px): compact chips and tight inline elements.
 * - `rounded-[9px]` (9 px): inputs and buttons — one pixel softer than lg.
 * - `rounded-xl` (12 px): card and panel surfaces.
 * - `rounded-full`: toggle switches, avatar badges, and pill labels.
 * @category Foundations
 */
export function Radius({ className }: { className?: string }) {
  return (
    <div className={cx(card, className)}>
      <p className={cardHeading}>Border Radius</p>
      <div className="flex gap-4">
        {RADIUS_SPECIMENS.map(({ radiusClass, label, desc }) => (
          <div key={label} className="flex-1">
            <div className={`h-16 w-full border border-stone-200 bg-stone-50 ${radiusClass}`} />
            <p className="mt-2 font-mono text-[11px] uppercase tracking-[0.12em] text-stone-500">
              {label}
            </p>
            <p className="mt-0.5 text-[11px] text-stone-400">{desc}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
