"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const sections = [
  {
    title: "Getting Started",
    items: [
      { label: "Overview", href: "/docs" },
      { label: "Installation", href: "/docs/installation" },
    ],
  },
  {
    title: "CLI",
    items: [
      { label: "Browsing & Search", href: "/docs/cli/browsing" },
      { label: "Fetching Releases", href: "/docs/cli/fetching" },
      { label: "Summaries & Comparisons", href: "/docs/cli/analysis" },
    ],
  },
  {
    title: "API",
    items: [
      { label: "REST Endpoints", href: "/docs/api/rest" },
      { label: "MCP Server", href: "/docs/api/mcp" },
    ],
  },
];

export function DocsNav() {
  const pathname = usePathname();

  return (
    <nav className="hidden md:block w-[180px] shrink-0 sticky top-6 self-start">
      {sections.map((section) => (
        <div key={section.title} className="mb-6">
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
    </nav>
  );
}
