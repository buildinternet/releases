"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { tabButtonClass } from "@/lib/styles";

interface SourceTabsProps {
  /** Base path for the tab links, e.g. `/sources/src_…` or `/{org}/{slug}`. */
  base: string;
  hasHighlights: boolean;
  hasChangelog?: boolean;
}

type SourceTab = "releases" | "highlights" | "changelog";

function resolveActiveTab(pathname: string, base: string): SourceTab {
  if (pathname === `${base}/highlights`) return "highlights";
  if (pathname === `${base}/changelog`) return "changelog";
  return "releases";
}

export function SourceTabs({ base, hasHighlights, hasChangelog = false }: SourceTabsProps) {
  const pathname = usePathname() ?? "";
  const activeTab = resolveActiveTab(pathname, base);

  // TODO: revisit default tab once Highlights has a regular publishing rhythm —
  // for now, All Releases (the bare URL) is the default even when Highlights
  // exists.

  return (
    <div className="flex gap-5 border-b border-stone-200 dark:border-stone-800 mt-5">
      {hasHighlights && (
        <Link
          href={`${base}/highlights`}
          className={tabButtonClass(activeTab === "highlights")}
          scroll={false}
        >
          Highlights
        </Link>
      )}
      <Link href={base} className={tabButtonClass(activeTab === "releases")} scroll={false}>
        All Releases
      </Link>
      {hasChangelog && (
        <Link
          href={`${base}/changelog`}
          className={tabButtonClass(activeTab === "changelog")}
          scroll={false}
        >
          Changelog
        </Link>
      )}
    </div>
  );
}
