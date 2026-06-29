import type { ReactNode } from "react";

/**
 * PreviewBanner — accent-soft callout used to mark a panel as a not-yet-shipped
 * preview. `icon` is an optional ReactNode slotted into a small accent-tinted
 * square on the left.
 */
export interface PreviewBannerProps {
  title: string;
  children?: ReactNode;
  /** Optional icon slotted into the accent-tinted square on the left. */
  icon?: ReactNode;
}

/** PreviewBanner — accent-soft callout marking a panel as a preview. @category Feedback */
export function PreviewBanner({ title, children, icon }: PreviewBannerProps) {
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

/**
 * SuccessBanner — green confirmation banner shown after a successful action.
 */
export interface SuccessBannerProps {
  children: ReactNode;
}

/** SuccessBanner — green confirmation banner shown after a successful action. @category Feedback */
export function SuccessBanner({ children }: SuccessBannerProps) {
  return (
    <div className="rounded-xl border border-green-600/30 bg-green-50 p-4 dark:border-green-500/30 dark:bg-green-950/40">
      <p className="text-sm font-medium text-green-800 dark:text-green-300">{children}</p>
    </div>
  );
}

/**
 * ErrorText — inline validation error shown beneath a field or form section.
 * Carries `role="alert"` so screen readers announce it on mount.
 */
export interface ErrorTextProps {
  children: ReactNode;
}

/** ErrorText — inline validation error with `role="alert"`. @category Feedback */
export function ErrorText({ children }: ErrorTextProps) {
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {children}
    </p>
  );
}
