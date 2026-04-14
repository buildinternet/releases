"use client";

import { useEffect, useState } from "react";
import {
  type FetchLogEntry,
  type FetchLogStatusFilter,
  FetchStatusBadge,
  FetchLogResultCell,
  FetchLogDetail,
  formatFetchDuration,
  FETCH_LOG_FILTER_BUTTONS,
} from "./fetch-log-shared";

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  if (sameDay) return time;
  return `${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })} ${time}`;
}

export function OrgFetchLogView({ apiUrl, apiKey, orgSlug }: { apiUrl: string; apiKey?: string; orgSlug: string }) {
  const [logs, setLogs] = useState<FetchLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FetchLogStatusFilter>("all");
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const headers: Record<string, string> = {};
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    fetch(`${apiUrl}/v1/status/fetch-log?org=${encodeURIComponent(orgSlug)}`, { headers })
      .then((r) => {
        if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
        return r.json();
      })
      .then((data) => {
        if (cancelled) return;
        setLogs(data as FetchLogEntry[]);
        setLoading(false);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setLoading(false);
      });
    return () => { cancelled = true; };
  }, [apiUrl, apiKey, orgSlug]);

  if (loading) {
    return <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">Loading fetch log…</div>;
  }
  if (error) {
    return <div className="text-sm text-red-500 py-8 text-center">Failed to load fetch log: {error}</div>;
  }
  if (logs.length === 0) {
    return <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">No fetch log entries for this organization.</div>;
  }

  const filtered = filter === "all" ? logs : logs.filter((l) => l.status === filter);

  return (
    <div className="mt-5">
      <div className="flex gap-1 mb-3">
        {FETCH_LOG_FILTER_BUTTONS.map((f) => {
          const count = f.value === "all" ? logs.length : logs.filter((l) => l.status === f.value).length;
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
        {filtered.map((log) => {
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
      <div className="mt-2 text-[11px] text-stone-400 dark:text-stone-500">
        {filtered.length} of {logs.length} entries
      </div>
    </div>
  );
}
