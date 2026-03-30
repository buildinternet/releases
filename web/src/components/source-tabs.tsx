"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";

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
    <div className="flex gap-5 border-b border-stone-200 mt-5">
      {hasHighlights && (
        <button
          onClick={() => setTab("highlights")}
          className={`pb-2.5 text-[13px] font-medium border-b-2 transition-colors ${
            activeTab === "highlights"
              ? "border-stone-900 text-stone-900"
              : "border-transparent text-stone-400 hover:text-stone-600"
          }`}
        >
          Highlights
        </button>
      )}
      <button
        onClick={() => setTab("releases")}
        className={`pb-2.5 text-[13px] font-medium border-b-2 transition-colors ${
          activeTab === "releases"
            ? "border-stone-900 text-stone-900"
            : "border-transparent text-stone-400 hover:text-stone-600"
        }`}
      >
        All Releases
      </button>
    </div>
  );
}
