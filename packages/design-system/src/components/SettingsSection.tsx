import type { ReactNode } from "react";
import { Eyebrow } from "./Eyebrow";

/**
 * SettingsSection — per-panel chrome for the settings surface. Renders the
 * panel header: mono accent eyebrow (`group`) → title → optional description.
 * Server-safe (no directive); route `page.tsx` wrappers which are Server
 * Components can render this directly.
 */
export interface SettingsSectionProps {
  /** Short mono eyebrow label identifying the settings group (e.g. "Account"). */
  group: string;
  /** Panel heading rendered as an `<h1>`. */
  title: string;
  /** Optional sentence below the heading; capped at 60ch. */
  description?: ReactNode;
  children: ReactNode;
}

/** SettingsSection — per-panel header chrome for the settings surface. @category Layout */
export function SettingsSection({ group, title, description, children }: SettingsSectionProps) {
  return (
    <div>
      <header className="mb-9">
        <Eyebrow tone="accent" className="mb-2.5">
          {group}
        </Eyebrow>
        <h1 className="text-[25px] font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          {title}
        </h1>
        {description && (
          <p className="mt-2 max-w-[60ch] text-sm leading-relaxed text-stone-600 dark:text-stone-300">
            {description}
          </p>
        )}
      </header>
      {children}
    </div>
  );
}

/**
 * PanelGrid — panel body layout.
 *
 * With an `aside`, renders a two-column grid (content + 264px rail) capped at
 * 1000px. Without one, a single column capped at 720px — matching the source
 * design's `--panel-max` per layout.
 */
export interface PanelGridProps {
  children: ReactNode;
  /** Optional context rail rendered as the second column on wide screens. */
  aside?: ReactNode;
}

/** PanelGrid — panel body layout, one or two columns depending on `aside`. @category Layout */
export function PanelGrid({ children, aside }: PanelGridProps) {
  if (!aside) {
    return <div className="max-w-[720px]">{children}</div>;
  }
  return (
    <div className="grid max-w-[1000px] grid-cols-1 gap-x-14 gap-y-9 lg:grid-cols-[minmax(0,1fr)_264px]">
      <div className="min-w-0">{children}</div>
      {aside}
    </div>
  );
}
