import type { FetchLogStatus } from "@buildinternet/releases-core/schema";

export interface FetchLogEntry {
  id: string;
  sourceId: string;
  sessionId?: string | null;
  sourceName?: string;
  sourceSlug?: string;
  orgName?: string;
  orgSlug?: string;
  releasesFound: number;
  releasesInserted: number;
  durationMs?: number;
  // Canonical status set (single source of truth in core's schema) so the
  // label/style maps below fail compilation if a new status is ever added
  // without them. `blocked` = Cloudflare challenge (#1171); `crawl_timeout` =
  // the /crawl job threw/timed out instead of returning pages (#1341).
  status: FetchLogStatus;
  error?: string;
  rawContent?: string;
  createdAt: string;
}

export type FetchLogStatusFilter = FetchLogEntry["status"] | "all";

// Per-status tallies are populated by the API only for the statuses it counts;
// keep it partial so streamed-in statuses (blocked / crawl_timeout) can be
// accumulated client-side without a missing-key type error.
export type FetchLogStatusCounts = Partial<Record<FetchLogEntry["status"], number>>;

export interface FetchLogResponse {
  entries: FetchLogEntry[];
  nextCursor: string | null;
  totalCount?: number;
  statusCounts?: FetchLogStatusCounts;
}

export function formatFetchDuration(ms?: number | null): string {
  if (ms == null) return "-";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${minutes}m ${secs}s`;
}

const STATUS_STYLES: Record<FetchLogEntry["status"], string> = {
  success: "text-green-600",
  error: "text-red-500",
  no_change: "text-stone-400",
  dry_run: "text-blue-500",
  // Degraded-but-not-broken states: amber, distinct from healthy gray and hard-error red.
  blocked: "text-amber-500",
  crawl_timeout: "text-amber-500",
  // The crawl body still matches a previously-failed extraction input — same
  // unresolved-underlying-issue signal as blocked/crawl_timeout, just with no
  // fresh attempt made (#1852 follow-up).
  skipped: "text-amber-500",
};

const STATUS_LABELS: Record<FetchLogEntry["status"], string> = {
  success: "Success",
  error: "Error",
  no_change: "No change",
  dry_run: "Dry run",
  blocked: "Blocked",
  crawl_timeout: "Crawl timeout",
  skipped: "Skipped (unchanged failure)",
};

export function FetchStatusBadge({ status }: { status: FetchLogEntry["status"] }) {
  return (
    <span className={STATUS_STYLES[status] ?? "text-stone-400"}>
      {STATUS_LABELS[status] ?? status}
    </span>
  );
}

export function FetchLogResultCell({ log }: { log: FetchLogEntry }) {
  if (log.status === "no_change") return <span className="text-stone-400">no changes</span>;
  if (log.status === "error")
    return <span className="text-red-500">{log.error?.slice(0, 40) ?? "failed"}</span>;
  // Degraded states carry an error message and 0 releases — show the reason
  // rather than the misleading "—" that empty rows otherwise render.
  if (log.status === "blocked" || log.status === "crawl_timeout" || log.status === "skipped")
    return (
      <span className="text-amber-500">{log.error?.slice(0, 40) ?? STATUS_LABELS[log.status]}</span>
    );
  if (log.releasesInserted > 0)
    return <span className="text-green-600">+{log.releasesInserted}</span>;
  if (log.releasesFound > 0) return <span>{log.releasesFound} found</span>;
  return <span className="text-stone-400">—</span>;
}

export function FetchLogDetail({ log }: { log: FetchLogEntry }) {
  return (
    <div className="bg-stone-900 text-stone-300 px-4 py-3 max-h-64 overflow-y-auto font-mono text-xs leading-relaxed border-b border-stone-200 dark:border-stone-800">
      <div className="grid grid-cols-2 gap-x-8 gap-y-1 mb-2">
        <div>
          <span className="text-stone-500">Source ID:</span> {log.sourceId}
        </div>
        <div>
          <span className="text-stone-500">Duration:</span> {formatFetchDuration(log.durationMs)}
        </div>
        <div>
          <span className="text-stone-500">Releases found:</span> {log.releasesFound}
        </div>
        <div>
          <span className="text-stone-500">Releases inserted:</span> {log.releasesInserted}
        </div>
        {log.orgName && (
          <div>
            <span className="text-stone-500">Organization:</span> {log.orgName}
          </div>
        )}
      </div>
      {log.error && (
        <div className="mt-2">
          <div className="text-stone-500 mb-1">Error:</div>
          <div className="text-red-400 whitespace-pre-wrap">{log.error}</div>
        </div>
      )}
      {log.rawContent && (
        <div className="mt-2">
          <div className="text-stone-500 mb-1">Raw content preview:</div>
          <div className="max-h-48 overflow-y-auto text-stone-400 whitespace-pre-wrap">
            {log.rawContent.slice(0, 2000)}
            {log.rawContent.length > 2000 ? "\n..." : ""}
          </div>
        </div>
      )}
      {!log.error && !log.rawContent && (
        <div className="text-stone-600">No additional details available.</div>
      )}
    </div>
  );
}

export const FETCH_LOG_FILTER_BUTTONS: { value: FetchLogStatusFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "success", label: "Success" },
  { value: "error", label: "Errors" },
  { value: "no_change", label: "No change" },
  { value: "dry_run", label: "Dry runs" },
];

/** Relative time: "5m ago" / "in 3h" / "—". Shared by the fetch-plan panel and the workflow drawer. */
export function relativeTime(iso: string | null, now: number = Date.now()): string {
  if (!iso) return "—";
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return "—";
  const diffMs = ts - now;
  const past = diffMs < 0;
  const mins = Math.round(Math.abs(diffMs) / 60_000);
  const label =
    mins < 60
      ? `${mins}m`
      : mins < 1440
        ? `${Math.round(mins / 60)}h`
        : `${Math.round(mins / 1440)}d`;
  return past ? `${label} ago` : `in ${label}`;
}
