"use client";

import { useState } from "react";
import { type FetchLogStatusFilter } from "./fetch-log-shared";
import { FetchLogList } from "./fetch-log-list";
import { OrgFetchPlanPanel } from "./org-fetch-plan-panel";
import { useFetchLog, type FetchLogSortField } from "./use-fetch-log";
import type { SortState } from "./sort-header";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

export function OrgFetchLogView({ orgSlug }: { orgSlug: string }) {
  const [filter, setFilter] = useState<FetchLogStatusFilter>("all");
  const [sort, setSort] = useState<SortState<FetchLogSortField>>({
    field: "createdAt",
    dir: "desc",
  });
  const { entries, totalCount, statusCounts, hasMore, loading, error, loadMore } = useFetchLog({
    org: orgSlug,
    status: filter,
    sort: sort.field,
    dir: sort.dir,
  });

  let logBody;
  if (loading && entries.length === 0) {
    logBody = (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        Loading fetch log…
      </div>
    );
  } else if (error && entries.length === 0) {
    logBody = (
      <div className="text-sm text-red-500 py-8 text-center">Failed to load fetch log: {error}</div>
    );
  } else if (!loading && totalCount === 0) {
    logBody = (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        No fetch log entries for this organization.
      </div>
    );
  } else {
    logBody = (
      <FetchLogList
        entries={entries}
        totalCount={totalCount}
        statusCounts={statusCounts}
        hasMore={hasMore}
        loading={loading}
        filter={filter}
        onFilterChange={setFilter}
        onLoadMore={loadMore}
        sort={sort}
        onSortChange={setSort}
        formatTime={formatTime}
      />
    );
  }

  return (
    <div className="mt-5">
      <OrgFetchPlanPanel orgSlug={orgSlug} />
      {logBody}
    </div>
  );
}
