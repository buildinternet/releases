"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export type DocsNavSection = {
  title: string;
  items: { label: string; href: string }[];
};

function SectionList({ sections, pathname }: { sections: DocsNavSection[]; pathname: string }) {
  return (
    <>
      {sections.map((section) => (
        <div key={section.title} className="mb-6 last:mb-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-2">
            {section.title}
          </div>
          <ul className="space-y-1">
            {section.items.map((item) => {
              const active = pathname === item.href;
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    className={`block text-sm py-0.5 transition-colors ${
                      active
                        ? "text-stone-900 dark:text-stone-100 font-medium"
                        : "text-stone-500 dark:text-stone-400 hover:text-stone-700 dark:hover:text-stone-300"
                    }`}
                  >
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </>
  );
}

export function DocsNav({ sections }: { sections: DocsNavSection[] }) {
  const pathname = usePathname();
  const currentLabel =
    sections.flatMap((s) => s.items).find((item) => item.href === pathname)?.label ?? "Docs";

  return (
    <>
      <details className="md:hidden group border border-stone-200 dark:border-stone-800 rounded-md">
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
          <SectionList sections={sections} pathname={pathname} />
        </nav>
      </details>
      <nav className="hidden md:block w-[180px] shrink-0 sticky top-6 self-start">
        <SectionList sections={sections} pathname={pathname} />
      </nav>
    </>
  );
}
