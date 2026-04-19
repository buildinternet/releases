"use client";

import { useState } from "react";
import { type FetchLogStatusFilter } from "./fetch-log-shared";
import { FetchLogList } from "./fetch-log-list";
import { useFetchLog } from "./use-fetch-log";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

export function OrgFetchLogView({
  apiUrl,
  apiKey,
  orgSlug,
}: {
  apiUrl: string;
  apiKey?: string;
  orgSlug: string;
}) {
  const [filter, setFilter] = useState<FetchLogStatusFilter>("all");
  const { entries, totalCount, statusCounts, hasMore, loading, error, loadMore } = useFetchLog({
    apiUrl,
    apiKey,
    org: orgSlug,
    status: filter,
  });

  if (loading && entries.length === 0) {
    return (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        Loading fetch log…
      </div>
    );
  }
  if (error && entries.length === 0) {
    return (
      <div className="text-sm text-red-500 py-8 text-center">Failed to load fetch log: {error}</div>
    );
  }
  if (!loading && totalCount === 0) {
    return (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        No fetch log entries for this organization.
      </div>
    );
  }

  return (
    <FetchLogList
      entries={entries}
      totalCount={totalCount}
      statusCounts={statusCounts}
      hasMore={hasMore}
      loading={loading}
      filter={filter}
      onFilterChange={setFilter}
      onLoadMore={loadMore}
      formatTime={formatTime}
      className="mt-5"
    />
  );
}
