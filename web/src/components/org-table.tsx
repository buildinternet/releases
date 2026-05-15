"use client";

import { useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { OrgListItem } from "@/lib/api";
import { HoverCard } from "@/components/hover-card";
import { OrgAvatar } from "@/components/org-avatar";
import { Sparkline } from "@/components/sparkline";
import { AbsoluteDateTooltip } from "@/components/date-tooltip";

type SortKey = "name" | "recentReleaseCount" | "lastActivity";
type SortDir = "asc" | "desc";

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) {
    return (
      <svg
        className="inline ml-1 text-stone-300 dark:text-stone-600"
        width="10"
        height="14"
        viewBox="0 0 10 14"
        fill="currentColor"
      >
        <path d="M5 0L9 5H1L5 0Z" opacity="0.5" />
        <path d="M5 14L1 9H9L5 14Z" opacity="0.5" />
      </svg>
    );
  }
  return (
    <svg className="inline ml-1" width="10" height="14" viewBox="0 0 10 14" fill="currentColor">
      {dir === "asc" ? <path d="M5 0L9 5H1L5 0Z" /> : <path d="M5 14L1 9H9L5 14Z" />}
    </svg>
  );
}

function OrgHoverContent({ org }: { org: OrgListItem }) {
  return (
    <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-lg p-3 w-[220px]">
      <div className="space-y-2.5">
        {org.domain && (
          <div className="text-[11px] text-stone-400 dark:text-stone-500">{org.domain}</div>
        )}
        {org.topProducts?.length > 0 && (
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-1">
              Products
            </div>
            <div className="flex flex-wrap gap-1">
              {org.topProducts.map((name) => (
                <span
                  key={name}
                  className="text-[11px] px-1.5 py-0.5 rounded bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-400"
                >
                  {name}
                </span>
              ))}
            </div>
          </div>
        )}
        <div className="flex gap-4">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-0.5">
              Sources
            </div>
            <div className="text-sm font-medium font-mono tabular-nums text-stone-900 dark:text-stone-100">
              {org.sourceCount}
            </div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-0.5">
              Releases
            </div>
            <div className="text-sm font-medium font-mono tabular-nums text-stone-900 dark:text-stone-100">
              {org.releaseCount.toLocaleString()}
            </div>
          </div>
          {org.recentReleaseCount > 0 && (
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-0.5">
                Last 30d
              </div>
              <div className="text-sm font-medium font-mono tabular-nums text-stone-900 dark:text-stone-100">
                {org.recentReleaseCount}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export function OrgTable({ orgs }: { orgs: OrgListItem[] }) {
  const router = useRouter();
  const [sortKey, setSortKey] = useState<SortKey>("name");
  const [sortDir, setSortDir] = useState<SortDir>("asc");

  function toggleSort(key: SortKey) {
    if (sortKey === key) {
      setSortDir(sortDir === "asc" ? "desc" : "asc");
    } else {
      setSortKey(key);
      setSortDir(key === "name" ? "asc" : "desc");
    }
  }

  const sorted = useMemo(
    () =>
      [...orgs].toSorted((a, b) => {
        const dir = sortDir === "asc" ? 1 : -1;
        if (sortKey === "name") {
          const av = (a.name ?? "").toLowerCase();
          const bv = (b.name ?? "").toLowerCase();
          return av < bv ? -dir : av > bv ? dir : 0;
        }
        if (sortKey === "lastActivity") {
          const av = a.lastActivity ?? "";
          const bv = b.lastActivity ?? "";
          return av < bv ? -dir : av > bv ? dir : 0;
        }
        if (sortKey === "recentReleaseCount") {
          return ((a.recentReleaseCount ?? 0) - (b.recentReleaseCount ?? 0)) * dir;
        }
        return 0;
      }),
    [orgs, sortKey, sortDir],
  );

  const th =
    "px-4 py-2.5 text-xs font-medium text-stone-500 dark:text-stone-400 cursor-pointer select-none hover:text-stone-700 dark:hover:text-stone-300 transition-colors";

  return (
    <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/50">
            <th className={`${th} text-left`} onClick={() => toggleSort("name")}>
              Name
              <SortIcon active={sortKey === "name"} dir={sortDir} />
            </th>
            <th
              className={`${th} text-right hidden sm:table-cell`}
              onClick={() => toggleSort("recentReleaseCount")}
            >
              Last 30d
              <SortIcon active={sortKey === "recentReleaseCount"} dir={sortDir} />
            </th>
            <th className={`${th} hidden md:table-cell`}>
              <span className="sr-only">Activity</span>
            </th>
            <th className={`${th} text-right`} onClick={() => toggleSort("lastActivity")}>
              <HoverCard.Root>
                <HoverCard.Trigger className="inline">
                  <span>
                    <svg
                      className="inline mr-1 text-stone-400 dark:text-stone-500 -mt-px"
                      width="12"
                      height="12"
                      viewBox="0 0 16 16"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    >
                      <circle cx="8" cy="8" r="6.5" />
                      <path d="M8 5v3.5M8 10.5v.5" strokeLinecap="round" />
                    </svg>
                    Last Release
                    <SortIcon active={sortKey === "lastActivity"} dir={sortDir} />
                  </span>
                </HoverCard.Trigger>
                <HoverCard.Content side="bottom" align="end" sideOffset={4}>
                  <div className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-lg px-3 py-2 text-[11px] text-stone-500 dark:text-stone-400 w-[200px] font-normal">
                    Based on last lookup. May be missing newer releases.
                  </div>
                </HoverCard.Content>
              </HoverCard.Root>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((org, i) => (
            <tr
              key={org.slug}
              onClick={() => router.push(`/${org.slug}`)}
              className={`cursor-pointer hover:bg-stone-50 dark:hover:bg-stone-800/50 transition-colors ${i < sorted.length - 1 ? "border-b border-stone-100 dark:border-stone-800/50" : ""}`}
            >
              <td className="px-4 py-2.5 font-medium text-stone-900 dark:text-stone-100">
                <HoverCard.Root>
                  <HoverCard.Trigger>
                    <span className="inline-flex items-center gap-2 min-w-0">
                      {org.avatarUrl && (
                        <OrgAvatar
                          avatarUrl={org.avatarUrl}
                          githubHandle={null}
                          name={org.name}
                          size={18}
                        />
                      )}
                      <span className="truncate">{org.name}</span>
                    </span>
                  </HoverCard.Trigger>
                  <HoverCard.Content side="bottom" align="start" sideOffset={4}>
                    <OrgHoverContent org={org} />
                  </HoverCard.Content>
                </HoverCard.Root>
              </td>
              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-stone-600 dark:text-stone-400 hidden sm:table-cell">
                {org.recentReleaseCount > 0 ? org.recentReleaseCount.toLocaleString() : "\u2014"}
              </td>
              <td
                className={`px-4 py-2.5 hidden md:table-cell ${org.recentReleaseCount > 0 ? "text-stone-500 dark:text-stone-400" : "text-stone-300 dark:text-stone-700"}`}
              >
                <Sparkline data={org.sparkline ?? []} width={80} height={24} id={org.slug} />
              </td>
              <td className="px-4 py-2.5 text-right font-mono tabular-nums text-stone-500 dark:text-stone-400 text-xs whitespace-nowrap">
                <AbsoluteDateTooltip iso={org.lastActivity} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
