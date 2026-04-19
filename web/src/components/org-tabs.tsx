"use client";

import { useSearchParams, useRouter, usePathname } from "next/navigation";
import { tabButtonClass } from "@/lib/styles";

function CodeBrackets() {
  return (
    <svg
      className="inline-block w-3.5 h-3.5 mr-1 -mt-px opacity-40"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M5.5 4 2 8l3.5 4" />
      <path d="M10.5 4 14 8l-3.5 4" />
    </svg>
  );
}

export function OrgTabs({
  hasPlaybook,
  hasFetchLog,
}: {
  hasPlaybook?: boolean;
  hasFetchLog?: boolean;
}) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const activeTab = searchParams.get("tab") ?? "overview";

  function setTab(tab: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (tab === "overview") {
      params.delete("tab");
    } else {
      params.set("tab", tab);
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  return (
    <div className="flex gap-5 border-b border-stone-200 dark:border-stone-800 mt-5">
      <button
        onClick={() => setTab("overview")}
        className={tabButtonClass(activeTab === "overview")}
      >
        Overview
      </button>
      <button
        onClick={() => setTab("releases")}
        className={tabButtonClass(activeTab === "releases")}
      >
        Releases
      </button>
      <button onClick={() => setTab("sources")} className={tabButtonClass(activeTab === "sources")}>
        Sources
      </button>
      {(hasFetchLog || hasPlaybook) && (
        <div className="flex gap-5 ml-auto">
          {hasFetchLog && (
            <button
              onClick={() => setTab("fetch-log")}
              className={tabButtonClass(activeTab === "fetch-log")}
            >
              <CodeBrackets />
              Fetch Log
            </button>
          )}
          {hasPlaybook && (
            <button
              onClick={() => setTab("playbook")}
              className={tabButtonClass(activeTab === "playbook")}
            >
              {!hasFetchLog && <CodeBrackets />}
              Playbook
            </button>
          )}
        </div>
      )}
    </div>
  );
}
