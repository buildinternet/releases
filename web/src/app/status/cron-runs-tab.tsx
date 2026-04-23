"use client";

import { useEffect, useState } from "react";
import { FetchStatusBadge, formatFetchDuration } from "@/components/fetch-log-shared";
import { SortHeader, type SortState } from "@/components/sort-header";

type CronRunSortField = "startedAt" | "durationMs" | "cronName";

type CronRun = {
  id: string;
  cronName: string;
  startedAt: string;
  endedAt: string | null;
  durationMs: number | null;
  status: "running" | "done" | "degraded" | "dispatch_failed" | "aborted";
  candidates: number;
  dispatched: number;
  skippedOverCap: number;
  dispatchErrors: number;
  sessionsStarted: string | null;
  dispatchErrorDetail: string | null;
  abortReason: string | null;
  notes: string | null;
};

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

function formatStartedAt(iso: string): string {
  const parts = timeFormatter.formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

export function CronRunsTab() {
  const [rows, setRows] = useState<CronRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState<CronRunSortField>>({
    field: "startedAt",
    dir: "desc",
  });

  useEffect(() => {
    setRows(null);
    setErr(null);
    const params = new URLSearchParams({
      limit: "50",
      sort: sort.field,
      dir: sort.dir,
    });
    fetch(`/api/proxy/admin/cron-runs?${params}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then((data: CronRun[]) => setRows(data))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [sort]);

  if (err) return <div className="text-red-500 text-xs">Error loading cron runs: {err}</div>;
  if (!rows) return <div className="text-stone-500 text-xs">Loading...</div>;
  if (rows.length === 0)
    return <div className="text-stone-500 text-xs">No cron runs recorded yet.</div>;

  return (
    <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
      <div className="grid grid-cols-[1.5fr_1.5fr_0.8fr_1fr_1.5fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium">
        <SortHeader field="cronName" current={sort} onChange={setSort}>
          Cron
        </SortHeader>
        <SortHeader field="startedAt" current={sort} onChange={setSort} defaultDir="desc">
          Started
        </SortHeader>
        <SortHeader field="durationMs" current={sort} onChange={setSort} defaultDir="desc">
          Duration
        </SortHeader>
        <div className="uppercase tracking-wider text-stone-400">Status</div>
        <div className="uppercase tracking-wider text-stone-400">Outcome</div>
      </div>
      {rows.map((r) => (
        <CronRunRow key={r.id} row={r} />
      ))}
    </div>
  );
}

function CronRunRow({ row }: { row: CronRun }) {
  const badge = mapBadge(row.status);
  const outcome =
    row.status === "aborted" && row.abortReason
      ? row.abortReason
      : `${row.dispatched}/${row.candidates}${row.skippedOverCap > 0 ? ` · +${row.skippedOverCap} skipped` : ""}${row.dispatchErrors > 0 ? ` · ${row.dispatchErrors} err` : ""}`;

  return (
    <div className="grid grid-cols-[1.5fr_1.5fr_0.8fr_1fr_1.5fr] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 items-center">
      <div className="text-stone-900 dark:text-stone-100 truncate">{row.cronName}</div>
      <div className="text-stone-500">{formatStartedAt(row.startedAt)}</div>
      <div className="text-stone-500">
        {row.durationMs != null ? formatFetchDuration(row.durationMs) : "—"}
      </div>
      <div>
        <FetchStatusBadge status={badge} />
      </div>
      <div className="text-stone-500" title={row.notes ?? undefined}>
        {outcome}
      </div>
    </div>
  );
}

// Map cron_runs.status to FetchStatusBadge variants ("success"|"error"|"no_change"|"dry_run").
// FetchStatusBadge has no "running" variant, so in-progress runs use "no_change" (neutral).
function mapBadge(status: CronRun["status"]): "success" | "error" | "no_change" | "dry_run" {
  switch (status) {
    case "done":
      return "success";
    case "running":
      return "no_change";
    case "degraded":
      return "no_change";
    case "dispatch_failed":
    case "aborted":
    default:
      return "error";
  }
}
