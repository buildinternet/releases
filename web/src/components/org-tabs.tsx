"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { tabButtonClass } from "@/lib/styles";

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

  return (
    <div className="flex gap-5 border-b border-stone-200 dark:border-stone-800 mt-5">
      <button onClick={() => setTab("sources")} className={tabButtonClass(activeTab === "sources")}>
        Overview
      </button>
      <button onClick={() => setTab("releases")} className={tabButtonClass(activeTab === "releases")}>
        Releases
      </button>
    </div>
  );
}
