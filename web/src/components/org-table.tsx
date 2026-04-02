"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import type { OrgListItem } from "@/lib/api";

type SortKey = "name" | "domain" | "sourceCount" | "releaseCount" | "recentReleaseCount";
type SortDir = "asc" | "desc";

function SortIcon({ active, dir }: { active: boolean; dir: SortDir }) {
  if (!active) {
    return <span className="ml-1 text-stone-300 dark:text-stone-600">↕</span>;
  }
  return <span className="ml-1">{dir === "asc" ? "↑" : "↓"}</span>;
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
      setSortDir(key === "name" || key === "domain" ? "asc" : "desc");
    }
  }

  const sorted = [...orgs].sort((a, b) => {
    const dir = sortDir === "asc" ? 1 : -1;
    if (sortKey === "name" || sortKey === "domain") {
      const av = (a[sortKey] ?? "").toLowerCase();
      const bv = (b[sortKey] ?? "").toLowerCase();
      return av < bv ? -dir : av > bv ? dir : 0;
    }
    return ((a[sortKey] ?? 0) - (b[sortKey] ?? 0)) * dir;
  });

  const th = "px-4 py-2.5 text-xs font-medium text-stone-500 dark:text-stone-400 cursor-pointer select-none hover:text-stone-700 dark:hover:text-stone-300 transition-colors";

  return (
    <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-stone-200 dark:border-stone-800 bg-stone-50 dark:bg-stone-900/50">
            <th className={`${th} text-left`} onClick={() => toggleSort("name")}>
              Name<SortIcon active={sortKey === "name"} dir={sortDir} />
            </th>
            <th className={`${th} text-left hidden sm:table-cell`} onClick={() => toggleSort("domain")}>
              Domain<SortIcon active={sortKey === "domain"} dir={sortDir} />
            </th>
            <th className={`${th} text-right`} onClick={() => toggleSort("sourceCount")}>
              Sources<SortIcon active={sortKey === "sourceCount"} dir={sortDir} />
            </th>
            <th className={`${th} text-right hidden sm:table-cell`} onClick={() => toggleSort("releaseCount")}>
              Releases<SortIcon active={sortKey === "releaseCount"} dir={sortDir} />
            </th>
            <th className={`${th} text-right hidden sm:table-cell`} onClick={() => toggleSort("recentReleaseCount")}>
              Last 30d<SortIcon active={sortKey === "recentReleaseCount"} dir={sortDir} />
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
              <td className="px-4 py-2.5 font-medium text-stone-900 dark:text-stone-100">{org.name}</td>
              <td className="px-4 py-2.5 text-stone-400 dark:text-stone-500 text-xs hidden sm:table-cell">{org.domain ?? "—"}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-stone-600 dark:text-stone-400">{org.sourceCount}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-stone-600 dark:text-stone-400 hidden sm:table-cell">{org.releaseCount.toLocaleString()}</td>
              <td className="px-4 py-2.5 text-right tabular-nums text-stone-600 dark:text-stone-400 hidden sm:table-cell">{(org.recentReleaseCount ?? 0) > 0 ? org.recentReleaseCount.toLocaleString() : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
