/**
 * Shared visual primitives for the account settings surface. The Settings
 * Redesign uses rounded cards, the brand accent (`--accent` / `--accent-soft`,
 * defined in globals.css), and the existing warm-stone palette for light/dark.
 * Class constants are exported (rather than wrapper components) to match the
 * codebase convention of module-level class strings, with a few stateful bits
 * (`Toggle`, `Aside`, banners) as components.
 *
 * No `"use client"` directive: the constants and presentational components are
 * server-safe, and the only interactive piece (`Toggle`) is always rendered
 * inside a `"use client"` panel, so it inherits that boundary. Adding the
 * directive here would (wrongly) make Next treat exported function props like
 * `onChange` as Server Actions.
 */
import type { ReactNode } from "react";

/** Mono eyebrow label — section kickers and rail headings. Pair with a color. */
export const eyebrowClass = "font-mono text-[11px] uppercase tracking-[0.16em]";

/** Bordered rounded container (cards, list wrappers). */
export const cardClass = "rounded-xl border border-stone-200 dark:border-stone-800";

export const fieldLabelClass =
  "mb-1.5 block text-[13px] font-medium text-stone-900 dark:text-stone-100";

export const inputClass =
  "h-10 w-full rounded-[9px] border border-stone-200 bg-white px-3 text-sm text-stone-900 outline-none transition focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";

export const textareaClass =
  "w-full rounded-[9px] border border-stone-200 bg-white px-3 py-2.5 text-sm leading-6 text-stone-900 outline-none transition focus:border-[var(--accent)] disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";

/** Filled accent action. */
export const primaryButtonClass =
  "inline-flex h-[38px] items-center justify-center rounded-[9px] bg-[var(--accent)] px-[18px] text-[13px] font-semibold text-[var(--on-accent)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60";

/** Bordered neutral action (h-[38px]). */
export const secondaryButtonClass =
  "inline-flex h-[38px] items-center justify-center gap-2 rounded-[9px] border border-stone-200 bg-white px-4 text-[13px] font-medium text-stone-800 transition hover:border-stone-300 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-100 dark:hover:border-stone-600";

/** Compact bordered neutral action (h-9) — table-row + inline controls. */
export const smallButtonClass =
  "inline-flex h-9 items-center justify-center gap-1.5 rounded-lg border border-stone-200 bg-white px-3 text-[12.5px] font-medium text-stone-700 transition hover:border-stone-300 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-900 dark:text-stone-200 dark:hover:border-stone-600 dark:hover:text-stone-100";

/** Compact filled accent action (h-9) — pairs with {@link smallButtonClass}. */
export const smallPrimaryButtonClass =
  "inline-flex h-9 items-center justify-center rounded-lg bg-[var(--accent)] px-3 text-[12.5px] font-semibold text-[var(--on-accent)] transition hover:brightness-110 disabled:cursor-not-allowed disabled:opacity-60";

/** Quiet link-style destructive control (row actions like Remove/Revoke). */
export const dangerLinkClass =
  "rounded-md px-1.5 py-1 text-[13px] text-stone-400 transition hover:text-red-600 disabled:opacity-50 dark:text-stone-500 dark:hover:text-red-400";

/** Bordered red "confirm destructive" button shown after a Remove/Disconnect click. */
export const confirmRemoveButtonClass =
  "inline-flex h-8 items-center rounded-lg border border-red-300 bg-white px-3 text-[12.5px] font-medium text-red-700 transition hover:bg-red-50 disabled:opacity-60 dark:border-red-500/40 dark:bg-stone-950 dark:text-red-400 dark:hover:bg-red-950/30";

/** Rounded list container with internal dividers (paired with {@link listRowClass}). */
export const listCardClass = `overflow-hidden ${cardClass}`;

/** One row inside a {@link listCardClass} — top divider collapses on the first row. */
export const listRowClass =
  "flex items-center gap-3.5 border-t border-stone-200 px-4 py-3.5 first:border-t-0 dark:border-stone-800";

/**
 * Accent-soft callout used to mark a panel as a not-yet-shipped preview (the
 * WIP panels withheld from the nav). `icon` is optional.
 */
export function PreviewBanner({
  title,
  children,
  icon,
}: {
  title: string;
  children?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl bg-[var(--accent-soft)] p-4">
      {icon && (
        <span className="flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg bg-[var(--accent)] text-[var(--on-accent)]">
          {icon}
        </span>
      )}
      <div>
        <div className="text-[13.5px] font-semibold text-stone-900 dark:text-stone-100">
          {title}
        </div>
        {children && (
          <p className="mt-1 text-[13px] leading-relaxed text-stone-600 dark:text-stone-300">
            {children}
          </p>
        )}
      </div>
    </div>
  );
}

export function ErrorText({ children }: { children: ReactNode }) {
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {children}
    </p>
  );
}

export function SuccessBanner({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-xl border border-green-600/30 bg-green-50 p-4 dark:border-green-500/30 dark:bg-green-950/40">
      <p className="text-sm font-medium text-green-800 dark:text-green-300">{children}</p>
    </div>
  );
}

/**
 * Pill toggle switch. Accent track when on; controlled via `checked` + `onChange`.
 * `disabled` dims it and blocks interaction (used for not-yet-wired preferences).
 */
export function Toggle({
  checked,
  onChange,
  disabled,
  label,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-[22px] w-[38px] shrink-0 items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked ? "bg-[var(--accent)]" : "bg-stone-300 dark:bg-stone-600"
      }`}
    >
      <span
        className={`absolute top-[3px] h-4 w-4 rounded-full bg-white shadow-sm transition-[left] ${
          checked ? "left-[19px]" : "left-[3px]"
        }`}
      />
    </button>
  );
}

/**
 * Context rail shown beside a panel on wide screens (the design's right-hand
 * aside). Hidden below `lg` so the panel goes full width on smaller viewports.
 */
export function Aside({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside className="hidden self-start rounded-xl bg-stone-100 p-[18px] lg:sticky lg:top-20 lg:block dark:bg-stone-800/50">
      <div className={`${eyebrowClass} mb-2.5 text-stone-400 dark:text-stone-500`}>{label}</div>
      {children}
    </aside>
  );
}
