"use client";

import { useEffect, useState } from "react";
import { SortHeader, type SortState } from "@/components/sort-header";

// ---- Types ----------------------------------------------------------------

type SearchSurface = "web" | "mcp" | "api";
type SearchMode = "lexical" | "semantic" | "hybrid";

interface RawSearchQuery {
  id: string;
  timestamp: number;
  surface: string;
  clientKind: string;
  query: string;
  mode: string | null;
  types: string | null;
  organization: string | null;
  entity: string | null;
  orgHits: number | null;
  catalogHits: number | null;
  releaseHits: number | null;
  chunkHits: number | null;
  degraded: boolean | null;
  durationMs: number | null;
  anonId: string | null;
  sessionId: string | null;
  userAgent: string | null;
}

interface TopQuery {
  query: string;
  count: number;
  lastSeen: number;
}

// ---- Formatting helpers ---------------------------------------------------

const timeFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
  timeZoneName: "short",
});

function formatTimestamp(ts: number): string {
  const parts = timeFormatter.formatToParts(new Date(ts));
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("month")} ${get("day")}, ${get("hour")}:${get("minute")} ${get("timeZoneName")}`;
}

function formatDuration(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function surfaceColor(surface: string): string {
  switch (surface as SearchSurface) {
    case "web":
      return "text-blue-500";
    case "mcp":
      return "text-purple-500";
    case "api":
      return "text-amber-500";
    default:
      return "text-stone-400";
  }
}

function modeColor(mode: string | null): string {
  switch (mode as SearchMode | null) {
    case "hybrid":
      return "text-green-600";
    case "semantic":
      return "text-purple-500";
    case "lexical":
      return "text-blue-500";
    default:
      return "text-stone-400";
  }
}

// ---- Top queries section --------------------------------------------------

type TopSortField = "count" | "lastSeen" | "query";

function TopQueriesTable() {
  const [rows, setRows] = useState<TopQuery[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState<TopSortField>>({ field: "count", dir: "desc" });

  useEffect(() => {
    setRows(null);
    setErr(null);
    fetch("/api/proxy/admin/search-queries/top?limit=50")
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<TopQuery[]>;
      })
      .then(setRows)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const sorted: TopQuery[] =
    rows == null
      ? []
      : rows.toSorted((a, b) => {
          const dir = sort.dir === "asc" ? 1 : -1;
          switch (sort.field) {
            case "count":
              return (a.count - b.count) * dir;
            case "lastSeen":
              return (a.lastSeen - b.lastSeen) * dir;
            case "query":
              return a.query.localeCompare(b.query) * dir;
            default:
              return 0;
          }
        });

  if (err) {
    return <div className="text-red-500 text-xs">Error loading top queries: {err}</div>;
  }
  if (!rows) {
    return <div className="text-stone-500 text-xs">Loading...</div>;
  }
  if (rows.length === 0) {
    return <div className="text-stone-500 text-xs">No queries recorded yet.</div>;
  }

  return (
    <div>
      <h3 className="text-xs font-sans font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-2">
        Top Queries (last 7 days)
      </h3>
      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[3fr_0.6fr_1.5fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium">
          <SortHeader field="query" current={sort} onChange={setSort}>
            Query
          </SortHeader>
          <SortHeader field="count" current={sort} onChange={setSort} defaultDir="desc">
            Count
          </SortHeader>
          <SortHeader field="lastSeen" current={sort} onChange={setSort} defaultDir="desc">
            Last Seen
          </SortHeader>
        </div>
        {sorted.map((row) => (
          <div
            key={row.query}
            className="grid grid-cols-[3fr_0.6fr_1.5fr] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors items-center"
          >
            <div className="text-stone-900 dark:text-stone-100 truncate" title={row.query}>
              {row.query}
            </div>
            <div className="text-stone-500">{row.count}</div>
            <div className="text-stone-500">{formatTimestamp(row.lastSeen)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Recent raw queries section -------------------------------------------

type RecentSortField = "timestamp" | "durationMs" | "surface" | "mode";

function RecentQueriesTable() {
  const [rows, setRows] = useState<RawSearchQuery[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState<RecentSortField>>({
    field: "timestamp",
    dir: "desc",
  });

  useEffect(() => {
    setRows(null);
    setErr(null);
    fetch("/api/proxy/admin/search-queries?limit=50")
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return r.json() as Promise<RawSearchQuery[]>;
      })
      .then(setRows)
      .catch((e: unknown) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const sorted: RawSearchQuery[] =
    rows == null
      ? []
      : rows.toSorted((a, b) => {
          const dir = sort.dir === "asc" ? 1 : -1;
          switch (sort.field) {
            case "timestamp":
              return (a.timestamp - b.timestamp) * dir;
            case "durationMs":
              return ((a.durationMs ?? 0) - (b.durationMs ?? 0)) * dir;
            case "surface":
              return a.surface.localeCompare(b.surface) * dir;
            case "mode":
              return (a.mode ?? "").localeCompare(b.mode ?? "") * dir;
            default:
              return 0;
          }
        });

  if (err) {
    return <div className="text-red-500 text-xs">Error loading recent queries: {err}</div>;
  }
  if (!rows) {
    return <div className="text-stone-500 text-xs">Loading...</div>;
  }
  if (rows.length === 0) {
    return <div className="text-stone-500 text-xs">No queries recorded yet.</div>;
  }

  return (
    <div>
      <h3 className="text-xs font-sans font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-2">
        Recent Queries (last 50)
      </h3>
      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[3fr_0.6fr_0.6fr_0.9fr_1.5fr_0.7fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium">
          <SortHeader field="timestamp" current={sort} onChange={setSort} defaultDir="desc">
            Query
          </SortHeader>
          <SortHeader field="surface" current={sort} onChange={setSort}>
            Surface
          </SortHeader>
          <SortHeader field="mode" current={sort} onChange={setSort}>
            Mode
          </SortHeader>
          <div className="uppercase tracking-wider text-stone-400">Hits</div>
          <div className="uppercase tracking-wider text-stone-400">When</div>
          <SortHeader field="durationMs" current={sort} onChange={setSort} defaultDir="desc">
            Duration
          </SortHeader>
        </div>
        {sorted.map((row) => {
          const totalHits = (row.orgHits ?? 0) + (row.catalogHits ?? 0) + (row.releaseHits ?? 0);
          const hitsDetail = [
            row.orgHits != null && `${row.orgHits} org`,
            row.catalogHits != null && `${row.catalogHits} cat`,
            row.releaseHits != null && `${row.releaseHits} rel`,
          ]
            .filter(Boolean)
            .join(" · ");

          return (
            <div
              key={row.id}
              className="grid grid-cols-[3fr_0.6fr_0.6fr_0.9fr_1.5fr_0.7fr] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors items-center"
            >
              <div className="text-stone-900 dark:text-stone-100 truncate" title={row.query}>
                {row.query}
              </div>
              <div className={`capitalize ${surfaceColor(row.surface)}`}>{row.surface}</div>
              <div className={`capitalize ${modeColor(row.mode)}`}>{row.mode ?? "—"}</div>
              <div className="text-stone-500" title={hitsDetail || undefined}>
                {totalHits > 0 ? totalHits : "—"}
              </div>
              <div className="text-stone-500">{formatTimestamp(row.timestamp)}</div>
              <div className="text-stone-500">{formatDuration(row.durationMs)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ---- Tab root -------------------------------------------------------------

export function SearchQueriesTab() {
  return (
    <div className="space-y-8">
      <TopQueriesTable />
      <RecentQueriesTable />
    </div>
  );
}
