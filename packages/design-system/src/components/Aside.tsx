import type { ReactNode } from "react";
import { Eyebrow } from "./Eyebrow";

/**
 * Aside — context rail shown beside a panel on wide screens (the design's
 * right-hand aside). Hidden below `lg` so the panel goes full width on smaller
 * viewports; sticky at `top-20` on large screens so it scrolls with the page.
 *
 * `label` is rendered as a mono eyebrow heading above the rail content.
 * @category Layout
 */
export function Aside({ label, children }: { label: string; children: ReactNode }) {
  return (
    <aside className="hidden self-start rounded-xl bg-stone-100 p-[18px] lg:sticky lg:top-20 lg:block dark:bg-stone-800/50">
      <Eyebrow className="mb-2.5 text-stone-400 dark:text-stone-500">{label}</Eyebrow>
      {children}
    </aside>
  );
}
