"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";

type TocItem = { id: string; text: string; level: 2 | 3 };

/**
 * "On this page" rail for docs pages. Reads the rendered article's h2/h3
 * headings from the DOM on mount (they carry stable ids now that the docs
 * markdown pipeline runs `rehype-slug`), so it works for every docs route —
 * markdown-rendered or hand-written `.tsx` — without the server passing heading
 * data down. Renders nothing when a page has fewer than two headings.
 *
 * A scrollspy (IntersectionObserver) highlights the section currently in view.
 */
export function DocsToc() {
  const pathname = usePathname();
  const [items, setItems] = useState<TocItem[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);

  // Collect headings. Keyed off pathname so client navigation between docs
  // pages rebuilds the list.
  useEffect(() => {
    const article = document.querySelector("article");
    if (!article) {
      setItems([]);
      return;
    }
    const headings = Array.from(article.querySelectorAll<HTMLHeadingElement>("h2[id], h3[id]"));
    const next: TocItem[] = headings.map((h) => ({
      id: h.id,
      // `textContent` includes the hover-anchor's accessible label ("Link to
      // this section"); the anchor is the heading's last child, so drop it.
      text:
        (h.querySelector("a[href^='#']")
          ? h.textContent?.replace(/Link to this section$/, "")
          : h.textContent
        )?.trim() ?? "",
      level: h.tagName === "H3" ? 3 : 2,
    }));
    setItems(next.filter((i) => i.id && i.text));
  }, [pathname]);

  // Scrollspy: mark the topmost heading whose section is in view.
  useEffect(() => {
    if (items.length === 0) return;
    const observed = items
      .map((i) => document.getElementById(i.id))
      .filter((el): el is HTMLElement => el != null);
    if (observed.length === 0) return;

    const visible = new Set<string>();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) visible.add(entry.target.id);
          else visible.delete(entry.target.id);
        }
        // Pick the first heading (document order) that's currently visible.
        const firstVisible = items.find((i) => visible.has(i.id));
        if (firstVisible) setActiveId(firstVisible.id);
      },
      // Bias the viewport upward so a heading counts as "active" once it nears
      // the top, and stops counting well before the bottom.
      { rootMargin: "-10% 0% -70% 0%", threshold: 0 },
    );
    for (const el of observed) observer.observe(el);
    return () => observer.disconnect();
  }, [items]);

  if (items.length < 2) return null;

  return (
    <nav
      aria-label="On this page"
      className="hidden xl:block w-52 shrink-0 self-start sticky top-24 max-h-[calc(100vh-8rem)] overflow-y-auto"
    >
      <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-2">
        On this page
      </div>
      <ul className="space-y-1 border-l border-stone-200 dark:border-stone-800">
        {items.map((item) => {
          const active = item.id === activeId;
          return (
            <li key={item.id}>
              <a
                href={`#${item.id}`}
                className={`block border-l -ml-px py-0.5 text-sm transition-colors ${
                  item.level === 3 ? "pl-6" : "pl-3"
                } ${
                  active
                    ? "border-stone-900 text-stone-900 dark:border-stone-100 dark:text-stone-100"
                    : "border-transparent text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300"
                }`}
              >
                {item.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
