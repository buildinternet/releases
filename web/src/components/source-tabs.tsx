"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { tabButtonClass } from "@/lib/styles";

interface SourceTabsProps {
  hasHighlights: boolean;
}

export function SourceTabs({ hasHighlights }: SourceTabsProps) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const activeTab = searchParams.get("tab") ?? (hasHighlights ? "highlights" : "releases");

  function setTab(tab: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "highlights") {
      params.delete("tab");
      params.delete("page");
    } else {
      params.set("tab", tab);
      params.delete("page");
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <div className="flex gap-5 border-b border-stone-200 dark:border-stone-800 mt-5">
      {hasHighlights && (
        <button
          onClick={() => setTab("highlights")}
          className={tabButtonClass(activeTab === "highlights")}
        >
          Highlights
        </button>
      )}
      <button
        onClick={() => setTab("releases")}
        className={tabButtonClass(activeTab === "releases")}
      >
        All Releases
      </button>
    </div>
  );
}
