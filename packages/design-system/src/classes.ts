/**
 * The Releases design vocabulary as module-level class strings — ported verbatim
 * from the web app's `account/ui.tsx`. These ARE the design system: the app styles
 * with these constants rather than wrapper components, so they're exported here
 * alongside the components (which are thin wrappers over the same strings) for
 * callers that prefer the raw classes (e.g. styling an `<a>` like a button).
 *
 * They reference the brand tokens defined in `styles.css` (`--accent`,
 * `--accent-soft`, `--on-accent`) plus Tailwind's warm-stone palette.
 */

/** Mono eyebrow label — section kickers and rail headings. Pair with a color. */
export const eyebrowClass = "font-mono text-[11px] uppercase tracking-[0.16em]";

/** Accent-tinted eyebrow — the org-surface variant (`eyebrowClass` + brand accent). */
export const orgEyebrowClass = `${eyebrowClass} text-[var(--accent)]`;

/** Bordered rounded container (cards, list wrappers). */
export const cardClass = "rounded-xl border border-stone-200 dark:border-stone-800";

export const fieldLabelClass =
  "mb-1.5 block text-[13px] font-medium text-stone-900 dark:text-stone-100";

export const inputClass =
  "h-10 w-full rounded-[9px] border border-stone-200 bg-white px-3 text-sm text-stone-900 outline-none transition focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";

export const textareaClass =
  "w-full rounded-[9px] border border-stone-200 bg-white px-3 py-2.5 text-sm leading-6 text-stone-900 outline-none transition focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";

/** Filled accent action (h-[38px]). */
export const primaryButtonClass =
  "inline-flex h-[38px] items-center justify-center rounded-[9px] bg-[var(--accent)] px-[18px] text-[13px] font-semibold text-[var(--on-accent)] transition hover:brightness-110 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60";

/** Bordered neutral action (h-[38px]). */
export const secondaryButtonClass =
  "inline-flex h-[38px] items-center justify-center gap-2 rounded-[9px] border border-stone-200 bg-white px-4 text-[13px] font-medium text-stone-800 transition hover:border-stone-300 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:border-stone-600";

/** Compact bordered neutral action (h-9) — table-row + inline controls. */
export const smallButtonClass =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 text-[12.5px] font-medium text-stone-700 transition hover:border-stone-300 hover:text-stone-900 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:border-stone-600 dark:hover:text-stone-100";

/** Compact filled accent action (h-9) — pairs with {@link smallButtonClass}. */
export const smallPrimaryButtonClass =
  "inline-flex h-9 items-center justify-center rounded-lg bg-[var(--accent)] px-3 text-[12.5px] font-semibold text-[var(--on-accent)] transition hover:brightness-110 active:scale-[0.96] disabled:cursor-not-allowed disabled:opacity-60";

/** Quiet link-style destructive control (row actions like Remove/Revoke). */
export const dangerLinkClass =
  "rounded-md px-1.5 py-1 text-[13px] text-stone-400 transition hover:text-red-600 disabled:opacity-50 dark:text-stone-500 dark:hover:text-red-400";

/** Bordered red "confirm destructive" button shown after a Remove/Disconnect click. */
export const confirmRemoveButtonClass =
  "inline-flex h-8 items-center rounded-lg border border-red-300 bg-white px-3 text-[12.5px] font-medium text-red-700 transition hover:bg-red-50 active:scale-[0.96] disabled:opacity-60 dark:border-red-500/40 dark:bg-stone-950 dark:text-red-400 dark:hover:bg-red-950/30";

/** Rounded list container with internal dividers (paired with {@link listRowClass}). */
export const listCardClass = `overflow-hidden ${cardClass}`;

/** One row inside a {@link listCardClass} — top divider collapses on the first row. */
export const listRowClass =
  "flex items-center gap-3.5 border-t border-stone-200 px-4 py-3.5 first:border-t-0 dark:border-stone-800";
