"use client";

import { useState } from "react";
import {
  type FetchLogStatusFilter,
  FetchStatusBadge,
  FetchLogResultCell,
  FetchLogDetail,
  formatFetchDuration,
  FETCH_LOG_FILTER_BUTTONS,
} from "./fetch-log-shared";
import { useFetchLog } from "./use-fetch-log";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

export function OrgFetchLogView({ apiUrl, apiKey, orgSlug }: { apiUrl: string; apiKey?: string; orgSlug: string }) {
  const [filter, setFilter] = useState<FetchLogStatusFilter>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const { entries, totalCount, statusCounts, hasMore, loading, error, loadMore } = useFetchLog({
    apiUrl, apiKey, org: orgSlug, status: filter,
  });

  if (loading && entries.length === 0) {
    return <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">Loading fetch log…</div>;
  }
  if (error && entries.length === 0) {
    return <div className="text-sm text-red-500 py-8 text-center">Failed to load fetch log: {error}</div>;
  }
  if (!loading && totalCount === 0) {
    return <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">No fetch log entries for this organization.</div>;
  }

  const activeTotal = filter === "all" ? totalCount : statusCounts[filter];
  const totalLabel = filter === "all" ? "entries" : filter.replace("_", " ");

  return (
    <div className="mt-5">
      <div className="flex gap-1 mb-3">
        {FETCH_LOG_FILTER_BUTTONS.map((f) => {
          const count = f.value === "all" ? totalCount : statusCounts[f.value];
          if (count === 0 && f.value !== "all") return null;
          return (
            <button
              key={f.value}
              onClick={() => setFilter(f.value)}
              className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
                filter === f.value
                  ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                  : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
              }`}
            >
              {f.label} <span className="ml-0.5 opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
          <div>Source</div>
          <div>Time</div>
          <div>Status</div>
          <div>Result</div>
          <div className="text-right">Duration</div>
        </div>
        {entries.map((log) => {
          const isExpanded = expandedIds.has(log.id);
          return (
            <div key={log.id}>
              <button
                onClick={() => setExpandedIds((prev) => {
                  const next = new Set(prev);
                  if (next.has(log.id)) next.delete(log.id);
                  else next.add(log.id);
                  return next;
                })}
                className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2.5 w-full text-left text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors"
              >
                <div className="flex items-start gap-1.5">
                  <span className="text-stone-300 dark:text-stone-600 shrink-0">{isExpanded ? "▾" : "▸"}</span>
                  <div>
                    <div className="text-stone-900 dark:text-stone-100">
                      {log.sourceSlug ? (
                        <a href={`/source/${log.sourceSlug}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>
                          {log.sourceName ?? log.sourceSlug}
                        </a>
                      ) : (
                        <span className="text-stone-500">{log.sourceName ?? log.sourceId}</span>
                      )}
                    </div>
                    {log.sessionId && (
                      <span className="text-[10px] font-sans text-indigo-400 dark:text-indigo-500">agent</span>
                    )}
                  </div>
                </div>
                <div className="text-stone-500">{formatTime(log.createdAt)}</div>
                <div><FetchStatusBadge status={log.status} /></div>
                <div className="text-stone-500"><FetchLogResultCell log={log} /></div>
                <div className="text-stone-400 text-right">{formatFetchDuration(log.durationMs)}</div>
              </button>
              {isExpanded && <FetchLogDetail log={log} />}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-2 text-[11px] text-stone-400 dark:text-stone-500">
        <span>
          Showing {entries.length} of {activeTotal.toLocaleString()} {totalLabel}
        </span>
        {hasMore && (
          <button
            onClick={loadMore}
            disabled={loading}
            className="px-3 py-1 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-40 disabled:cursor-default"
          >
            {loading ? "Loading…" : "Load 25 more"}
          </button>
        )}
      </div>
    </div>
  );
}
