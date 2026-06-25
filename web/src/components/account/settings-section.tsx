/**
 * Per-panel chrome for the settings surface. `SettingsSection` renders the panel
 * header (mono accent eyebrow → title → description) that each route page wraps
 * its panel in; `PanelGrid` lays the panel body out as a main column with an
 * optional right-hand context rail (the design's aside) that collapses below
 * `lg`. Both are presentational and server-safe (no directive) so the route
 * `page.tsx` wrappers — which are Server Components — can render the header.
 */
import type { ReactNode } from "react";
import { eyebrowClass } from "./ui";

export function SettingsSection({
  group,
  title,
  description,
  children,
}: {
  group: string;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div>
      <header className="mb-9">
        <div className={`${eyebrowClass} mb-2.5 text-[var(--accent)]`}>{group}</div>
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
 * Panel body layout. With an `aside`, renders a two-column grid (content +
 * 264px rail) capped at 1000px; without one, a single column capped at 720px —
 * matching the source design's `--panel-max` per layout.
 */
export function PanelGrid({ children, aside }: { children: ReactNode; aside?: ReactNode }) {
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
