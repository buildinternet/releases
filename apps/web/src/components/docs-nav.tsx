"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";

export type DocsNavItem = {
  label: string;
  href: string;
  /** Collapsible group within the section (API reference areas). */
  group?: string;
  /** HTTP method badge (API reference endpoints). */
  method?: string;
};

export type DocsNavSection = {
  title: string;
  items: DocsNavItem[];
};

const METHOD_COLORS: Record<string, string> = {
  GET: "text-emerald-600 dark:text-emerald-400",
  POST: "text-blue-600 dark:text-blue-400",
  PUT: "text-amber-600 dark:text-amber-400",
  PATCH: "text-amber-600 dark:text-amber-400",
  DELETE: "text-red-600 dark:text-red-400",
};

function NavLink({
  item,
  active,
  onItemClick,
}: {
  item: DocsNavItem;
  active: boolean;
  onItemClick?: () => void;
}) {
  return (
    <Link
      href={item.href}
      onClick={onItemClick}
      className={`flex items-baseline gap-1.5 text-sm py-0.5 transition-colors ${
        active
          ? "text-stone-900 dark:text-stone-100 font-medium"
          : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
      }`}
    >
      {item.method && (
        <span
          className={`w-7 shrink-0 font-mono text-[9px] font-semibold tracking-tight ${METHOD_COLORS[item.method] ?? ""}`}
        >
          {item.method === "DELETE" ? "DEL" : item.method}
        </span>
      )}
      <span className="min-w-0">{item.label}</span>
    </Link>
  );
}

/** Consecutive items sharing a `group` collapse under one heading. */
function groupItems(
  items: DocsNavItem[],
): Array<DocsNavItem | { group: string; items: DocsNavItem[] }> {
  const out: Array<DocsNavItem | { group: string; items: DocsNavItem[] }> = [];
  for (const item of items) {
    const last = out.at(-1);
    if (item.group && last && "items" in last && last.group === item.group) last.items.push(item);
    else if (item.group) out.push({ group: item.group, items: [item] });
    else out.push(item);
  }
  return out;
}

function BackLink({ label, href }: { label: string; href: string }) {
  return (
    <Link
      href={href}
      className="mb-6 flex items-center gap-1 text-sm text-stone-500 transition-colors hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300"
    >
      <span aria-hidden>←</span> {label}
    </Link>
  );
}

function SectionList({
  sections,
  pathname,
  onItemClick,
}: {
  sections: DocsNavSection[];
  pathname: string;
  onItemClick?: () => void;
}) {
  return (
    <>
      {sections.map((section) => (
        <div key={section.title} className="mb-6 last:mb-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-2">
            {section.title}
          </div>
          <ul className="space-y-1">
            {groupItems(section.items).map((entry) => {
              if (!("items" in entry)) {
                return (
                  <li key={entry.href}>
                    <NavLink
                      item={entry}
                      active={pathname === entry.href}
                      onItemClick={onItemClick}
                    />
                  </li>
                );
              }
              const open = entry.items.some((item) => item.href === pathname);
              return (
                <li key={entry.group}>
                  <details open={open} className="group/navgroup">
                    <summary className="flex cursor-pointer list-none items-center justify-between py-0.5 text-sm text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-300 [&::-webkit-details-marker]:hidden">
                      <span className={open ? "text-stone-900 dark:text-stone-100" : undefined}>
                        {entry.group}
                      </span>
                      <svg
                        className="h-3 w-3 shrink-0 transition-transform group-open/navgroup:rotate-90"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                        aria-hidden
                      >
                        <path
                          fillRule="evenodd"
                          d="M7.21 14.77a.75.75 0 01.02-1.06L11.168 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </summary>
                    <ul className="mt-1 mb-2 space-y-1 border-l border-stone-200 pl-2.5 dark:border-stone-800">
                      {entry.items.map((item) => (
                        <li key={item.href}>
                          <NavLink
                            item={item}
                            active={pathname === item.href}
                            onItemClick={onItemClick}
                          />
                        </li>
                      ))}
                    </ul>
                  </details>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

export function DocsNav({
  sections,
  backLink,
  widthClassName = "w-[180px]",
}: {
  sections: DocsNavSection[];
  /** A link above the sections, e.g. back to the main docs from the API reference. */
  backLink?: { label: string; href: string };
  widthClassName?: string;
}) {
  const pathname = usePathname();
  const detailsRef = useRef<HTMLDetailsElement>(null);
  const currentLabel =
    sections.flatMap((s) => s.items).find((item) => item.href === pathname)?.label ?? "Docs";

  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = false;
  }, [pathname]);

  return (
    <>
      <details
        ref={detailsRef}
        className="md:hidden group border border-stone-200 dark:border-stone-800 rounded-md"
      >
        <summary className="flex items-center justify-between px-4 py-2.5 text-sm font-medium cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <span>{currentLabel}</span>
          <svg
            className="w-4 h-4 text-stone-500 transition-transform group-open:rotate-180"
            viewBox="0 0 20 20"
            fill="currentColor"
            aria-hidden
          >
            <path
              fillRule="evenodd"
              d="M5.23 7.21a.75.75 0 011.06.02L10 11.06l3.71-3.83a.75.75 0 111.08 1.04l-4.25 4.39a.75.75 0 01-1.08 0L5.21 8.27a.75.75 0 01.02-1.06z"
              clipRule="evenodd"
            />
          </svg>
        </summary>
        <nav className="px-4 pb-4 pt-2 border-t border-stone-200 dark:border-stone-800">
          {backLink && <BackLink {...backLink} />}
          <SectionList
            sections={sections}
            pathname={pathname}
            onItemClick={() => {
              if (detailsRef.current) detailsRef.current.open = false;
            }}
          />
        </nav>
      </details>
      <nav
        className={`hidden md:block ${widthClassName} shrink-0 sticky top-6 self-start max-h-[calc(100vh-3rem)] overflow-y-auto`}
      >
        {backLink && <BackLink {...backLink} />}
        <SectionList sections={sections} pathname={pathname} />
      </nav>
    </>
  );
}
