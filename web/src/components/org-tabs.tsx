"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";

export function OrgTabs() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const activeTab = searchParams.get("tab") ?? "sources";

  function setTab(tab: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "sources") {
      params.delete("tab");
    } else {
      params.set("tab", tab);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const tabClass = (tab: string) =>
    `pb-2.5 text-[13px] font-medium border-b-2 transition-colors ${
      activeTab === tab
        ? "border-stone-900 dark:border-stone-100 text-stone-900 dark:text-stone-100"
        : "border-transparent text-stone-400 hover:text-stone-600 dark:hover:text-stone-300"
    }`;

  return (
    <div className="flex gap-5 border-b border-stone-200 dark:border-stone-800 mt-5">
      <button onClick={() => setTab("sources")} className={tabClass("sources")}>
        Overview
      </button>
      <button onClick={() => setTab("releases")} className={tabClass("releases")}>
        Releases
      </button>
    </div>
  );
}
