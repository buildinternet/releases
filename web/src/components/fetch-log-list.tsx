"use client";

import { useState } from "react";
import {
  type FetchLogEntry,
  type FetchLogStatusCounts,
  type FetchLogStatusFilter,
  FetchStatusBadge,
  FetchLogResultCell,
  FetchLogDetail,
  formatFetchDuration,
  FETCH_LOG_FILTER_BUTTONS,
} from "./fetch-log-shared";
import { SortHeader, type SortState } from "./sort-header";
import type { FetchLogSortField } from "./use-fetch-log";

interface Props {
  entries: FetchLogEntry[];
  totalCount: number;
  statusCounts: FetchLogStatusCounts;
  hasMore: boolean;
  loading: boolean;
  filter: FetchLogStatusFilter;
  onFilterChange: (value: FetchLogStatusFilter) => void;
  onLoadMore: () => void;
  sort: SortState<FetchLogSortField>;
  onSortChange: (next: SortState<FetchLogSortField>) => void;
  /** How to render a fetch row's timestamp — dashboard uses a timezone-aware format; org pages use a "today? time : date time" short form. */
  formatTime: (iso: string) => string;
  /** When true, show the org name under the source (for surfaces that span orgs). */
  showOrg?: boolean;
  /** Top margin on the list wrapper, in case the consumer wants extra spacing. */
  className?: string;
}

export function FetchLogList({
  entries,
  totalCount,
  statusCounts,
  hasMore,
  loading,
  filter,
  onFilterChange,
  onLoadMore,
  sort,
  onSortChange,
  formatTime,
  showOrg = false,
  className,
}: Props) {
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  const activeTotal = filter === "all" ? totalCount : statusCounts[filter];
  const totalLabel = filter === "all" ? "entries" : filter.replace("_", " ");

  return (
    <div className={className}>
      <div className="flex gap-1 mb-3">
        {FETCH_LOG_FILTER_BUTTONS.map((f) => {
          const count = f.value === "all" ? totalCount : statusCounts[f.value];
          if (count === 0 && f.value !== "all") return null;
          return (
            <button
              key={f.value}
              onClick={() => onFilterChange(f.value)}
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
          <SortHeader field="createdAt" current={sort} onChange={onSortChange} defaultDir="desc">
            Time
          </SortHeader>
          <div>Status</div>
          <div>Result</div>
          <SortHeader
            field="durationMs"
            current={sort}
            onChange={onSortChange}
            defaultDir="desc"
            alignRight
          >
            Duration
          </SortHeader>
        </div>
        {entries.map((log) => {
          const isExpanded = expandedIds.has(log.id);
          return (
            <div key={log.id}>
              <button
                onClick={() =>
                  setExpandedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(log.id)) next.delete(log.id);
                    else next.add(log.id);
                    return next;
                  })
                }
                className="grid grid-cols-[2fr_1.5fr_1fr_1.5fr_1fr] px-4 py-2.5 w-full text-left text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors"
              >
                <div className="flex items-start gap-1.5">
                  <span className="text-stone-300 dark:text-stone-600 shrink-0">
                    {isExpanded ? "▾" : "▸"}
                  </span>
                  <div>
                    <div className="text-stone-900 dark:text-stone-100">
                      {log.sourceSlug ? (
                        <a
                          href={`/source/${log.sourceSlug}`}
                          className="hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {log.sourceName ?? log.sourceSlug}
                        </a>
                      ) : (
                        <span className="text-stone-500">{log.sourceName ?? log.sourceId}</span>
                      )}
                    </div>
                    {showOrg && log.orgName && <div className="text-stone-400">{log.orgName}</div>}
                    {log.sessionId && (
                      <span className="text-[10px] font-sans text-indigo-400 dark:text-indigo-500">
                        agent
                      </span>
                    )}
                  </div>
                </div>
                <div className="text-stone-500">{formatTime(log.createdAt)}</div>
                <div>
                  <FetchStatusBadge status={log.status} />
                </div>
                <div className="text-stone-500">
                  <FetchLogResultCell log={log} />
                </div>
                <div className="text-stone-400 text-right">
                  {formatFetchDuration(log.durationMs)}
                </div>
              </button>
              {isExpanded && <FetchLogDetail log={log} />}
            </div>
          );
        })}
      </div>

      <div className="flex items-center justify-between mt-3 text-xs text-stone-400 dark:text-stone-500">
        <span>
          Showing {entries.length} of {activeTotal.toLocaleString()} {totalLabel}
        </span>
        {hasMore && (
          <button
            onClick={onLoadMore}
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
