"use client";

import { useEffect, useState } from "react";
import { formatFetchDuration } from "@/components/fetch-log-shared";

type BatchRun = {
  id: string;
  anthropicBatchId: string;
  caller: string;
  model: string;
  status: "submitted" | "in_progress" | "ended" | "failed";
  requestCountTotal: number;
  requestCountSucceeded: number;
  requestCountErrored: number;
  requestCountExpired: number;
  requestCountCanceled: number;
  createdAt: string;
  endedAt: string | null;
  estCostUsd: number | null;
  actualCostUsd: number | null;
};

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

function formatCreatedAt(iso: string): string {
  const parts = timeFormatter.formatToParts(new Date(iso));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

function formatDuration(createdAt: string, endedAt: string | null): string {
  if (!endedAt) return "—";
  const ms = new Date(endedAt).getTime() - new Date(createdAt).getTime();
  if (ms < 0) return "—";
  return formatFetchDuration(ms);
}

function formatUsd(usd: number | null): string {
  if (usd == null) return "—";
  if (usd >= 0.01) return `$${usd.toFixed(2)}`;
  return `$${usd.toFixed(4)}`;
}

function formatModelName(model: string): string {
  // e.g. "claude-haiku-4-5-20251001" → "Haiku 4.5"
  const match = model.match(/claude-(\w+)-(\d+)-(\d+)/);
  if (match) {
    const name = match[1].charAt(0).toUpperCase() + match[1].slice(1);
    return `${name} ${match[2]}.${match[3]}`;
  }
  return model;
}

function StatusBadge({ status }: { status: BatchRun["status"] }) {
  const map: Record<BatchRun["status"], { label: string; cls: string }> = {
    submitted: { label: "Submitted", cls: "text-stone-400" },
    in_progress: { label: "In progress", cls: "text-blue-500" },
    ended: { label: "Ended", cls: "text-green-600" },
    failed: { label: "Failed", cls: "text-red-500" },
  };
  const { label, cls } = map[status] ?? { label: status, cls: "text-stone-400" };
  return <span className={cls}>{label}</span>;
}

function CallerChip({ caller }: { caller: string }) {
  const cls =
    caller === "script"
      ? "bg-violet-100 text-violet-600 dark:bg-violet-900/30 dark:text-violet-400"
      : caller === "workflow"
        ? "bg-amber-100 text-amber-600 dark:bg-amber-900/30 dark:text-amber-400"
        : "bg-stone-100 text-stone-500 dark:bg-stone-800 dark:text-stone-400";
  return (
    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full ${cls}`}>{caller}</span>
  );
}

export function BatchRunsTab() {
  const [rows, setRows] = useState<BatchRun[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalItems, setTotalItems] = useState<number | null>(null);

  useEffect(() => {
    setRows(null);
    setErr(null);
    const params = new URLSearchParams({ page: String(page), limit: "25" });
    fetch(`/api/proxy/admin/batch-runs?${params}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json();
      })
      .then(
        (data: {
          items: BatchRun[];
          pagination?: { totalPages?: number; totalItems?: number };
        }) => {
          setRows(data.items ?? []);
          setTotalPages(data.pagination?.totalPages ?? 1);
          setTotalItems(data.pagination?.totalItems ?? null);
        },
      )
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, [page]);

  if (err) return <div className="text-red-500 text-xs">Error loading batch runs: {err}</div>;
  if (!rows) return <div className="text-stone-500 text-xs">Loading...</div>;
  if (rows.length === 0 && page === 1)
    return <div className="text-stone-500 text-xs">No batch runs recorded yet.</div>;

  return (
    <div>
      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[1.5fr_1fr_1fr_1.5fr_1fr_1fr_1fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
          <div>Created</div>
          <div>Caller</div>
          <div>Model</div>
          <div>Requests</div>
          <div>Duration</div>
          <div>Cost</div>
          <div>Status</div>
        </div>
        {rows.map((r) => (
          <BatchRunRow key={r.id} row={r} />
        ))}
        {rows.length === 0 && (
          <div className="px-4 py-6 text-xs text-stone-400 dark:text-stone-500 text-center">
            No batch runs on this page.
          </div>
        )}
      </div>

      <div className="flex items-center justify-between mt-3 text-xs text-stone-400 dark:text-stone-500">
        <span>{totalItems != null ? `${totalItems.toLocaleString()} runs` : ""}</span>
        {totalPages > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-2 py-1 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-default"
            >
              Prev
            </button>
            <span>
              {page} / {totalPages}
            </span>
            <button
              onClick={() => setPage((p) => p + 1)}
              disabled={page >= totalPages}
              className="px-2 py-1 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-default"
            >
              Next
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function BatchRunRow({ row }: { row: BatchRun }) {
  const hasErrors = row.requestCountErrored > 0;

  // Build request counts summary: "10 total · 9 ok · 1 err"
  const countParts: string[] = [`${row.requestCountTotal} total`];
  if (row.requestCountSucceeded > 0) countParts.push(`${row.requestCountSucceeded} ok`);
  if (row.requestCountErrored > 0) countParts.push(`${row.requestCountErrored} err`);
  if (row.requestCountExpired > 0) countParts.push(`${row.requestCountExpired} expired`);
  if (row.requestCountCanceled > 0) countParts.push(`${row.requestCountCanceled} canceled`);

  const costTooltip = row.estCostUsd != null ? `est: ${formatUsd(row.estCostUsd)}` : undefined;

  return (
    <div className="grid grid-cols-[1.5fr_1fr_1fr_1.5fr_1fr_1fr_1fr] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 items-center">
      <div className="text-stone-500">{formatCreatedAt(row.createdAt)}</div>
      <div>
        <CallerChip caller={row.caller} />
      </div>
      <div className="text-stone-500">{formatModelName(row.model)}</div>
      <div className={hasErrors ? "text-red-500" : "text-stone-500"}>{countParts.join(" · ")}</div>
      <div className="text-stone-500">{formatDuration(row.createdAt, row.endedAt)}</div>
      <div className="text-stone-500" title={costTooltip}>
        {formatUsd(row.actualCostUsd)}
      </div>
      <div>
        <StatusBadge status={row.status} />
      </div>
    </div>
  );
}
