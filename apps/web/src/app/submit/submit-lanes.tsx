"use client";

import { useState } from "react";
import { ListingFastLane } from "./listing-fast-lane";
import { SubmitSourceForm } from "./submit-source-form";

type Lane = "manifest" | "url";

const TABS: ReadonlyArray<{ id: Lane; label: string; hint?: string }> = [
  { id: "manifest", label: "Manifest", hint: "recommended" },
  { id: "url", label: "Suggest a URL" },
];

export function SubmitLanes() {
  const [lane, setLane] = useState<Lane>("manifest");

  return (
    <div>
      <div className="flex border-b border-stone-200 dark:border-stone-700" role="tablist">
        {TABS.map((tab) => {
          const active = lane === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`submit-tab-${tab.id}`}
              aria-selected={active}
              aria-controls={`submit-panel-${tab.id}`}
              onClick={() => setLane(tab.id)}
              className={`shrink-0 px-4 py-2.5 text-[13px] font-medium transition-colors ${
                active
                  ? "-mb-px border-b-2 border-stone-900 text-stone-900 dark:border-stone-100 dark:text-stone-100"
                  : "text-stone-400 hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
              }`}
            >
              {tab.label}
              {tab.hint && (
                <span
                  className={`ml-1.5 text-[11px] font-normal ${
                    active
                      ? "text-stone-400 dark:text-stone-500"
                      : "text-stone-300 dark:text-stone-600"
                  }`}
                >
                  ({tab.hint})
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div
        id={`submit-panel-${lane}`}
        role="tabpanel"
        aria-labelledby={`submit-tab-${lane}`}
        className="pt-6"
      >
        {lane === "manifest" ? <ListingFastLane /> : <SubmitSourceForm />}
      </div>
    </div>
  );
}
