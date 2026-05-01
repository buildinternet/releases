"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { SortHeader, type SortState } from "@/components/sort-header";

// ---- Types ----------------------------------------------------------------

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
  authed: boolean | null;
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

type PillTone = "stone" | "blue" | "purple" | "amber" | "emerald" | "indigo";

const PILL_TONE: Record<PillTone, string> = {
  stone: "border-stone-300 text-stone-500 dark:border-stone-700 dark:text-stone-400",
  blue: "border-blue-300 text-blue-600 dark:border-blue-800 dark:text-blue-400",
  purple: "border-purple-300 text-purple-600 dark:border-purple-800 dark:text-purple-400",
  amber: "border-amber-300 text-amber-600 dark:border-amber-800 dark:text-amber-500",
  emerald: "border-emerald-300 text-emerald-600 dark:border-emerald-800 dark:text-emerald-500",
  indigo: "border-indigo-300 text-indigo-600 dark:border-indigo-800 dark:text-indigo-400",
};

function surfaceTone(surface: string): PillTone {
  switch (surface) {
    case "web":
      return "blue";
    case "mcp":
      return "purple";
    case "api":
      return "amber";
    default:
      return "stone";
  }
}

function clientKindTone(kind: string): PillTone {
  switch (kind) {
    case "cli":
      return "indigo";
    case "web-server":
      return "blue";
    case "mcp-claude":
      return "purple";
    default:
      return "stone";
  }
}

/**
 * `external` is the schema default written when no UA-derived signal was
 * available. Treat it as "unknown" and hide the pill rather than labelling
 * unknown traffic with a meaningless bucket.
 */
function shouldRenderClientKind(kind: string): boolean {
  return kind !== "external";
}

function Pill({
  label,
  tone,
  title,
}: {
  label: string;
  tone: PillTone;
  title?: string;
}): React.ReactElement {
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide ${PILL_TONE[tone]}`}
      title={title}
    >
      {label}
    </span>
  );
}

function modeColor(mode: string | null): string {
  switch (mode) {
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

// ---- Shared status helpers ------------------------------------------------

function LoadingState(): React.ReactElement {
  return <div className="text-stone-500 text-xs">Loading...</div>;
}

function ErrorState({ message }: { message: string }): React.ReactElement {
  return <div className="text-red-500 text-xs">{message}</div>;
}

function EmptyState(): React.ReactElement {
  return <div className="text-stone-500 text-xs">No queries recorded yet.</div>;
}

// ---- Top queries section --------------------------------------------------

type TopSortField = "count" | "lastSeen" | "query";

function TopQueriesTable(): React.ReactElement {
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

  if (err) return <ErrorState message={`Error loading top queries: ${err}`} />;
  if (!rows) return <LoadingState />;
  if (rows.length === 0) return <EmptyState />;

  const sorted = rows.toSorted((a, b) => {
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

type RecentSortField = "timestamp" | "durationMs" | "surface" | "mode" | "clientKind";

function RecentQueriesTable(): React.ReactElement {
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

  if (err) return <ErrorState message={`Error loading recent queries: ${err}`} />;
  if (!rows) return <LoadingState />;
  if (rows.length === 0) return <EmptyState />;

  const sorted = rows.toSorted((a, b) => {
    const dir = sort.dir === "asc" ? 1 : -1;
    switch (sort.field) {
      case "timestamp":
        return (a.timestamp - b.timestamp) * dir;
      case "durationMs":
        return ((a.durationMs ?? 0) - (b.durationMs ?? 0)) * dir;
      case "surface":
        return a.surface.localeCompare(b.surface) * dir;
      case "clientKind":
        return a.clientKind.localeCompare(b.clientKind) * dir;
      case "mode":
        return (a.mode ?? "").localeCompare(b.mode ?? "") * dir;
      default:
        return 0;
    }
  });

  return (
    <div>
      <h3 className="text-xs font-sans font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-2">
        Recent Queries (last 50)
      </h3>
      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[2.4fr_1.4fr_0.6fr_0.7fr_1.4fr_0.7fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium">
          <div className="uppercase tracking-wider text-stone-400">Query</div>
          <SortHeader field="clientKind" current={sort} onChange={setSort}>
            Tags
          </SortHeader>
          <SortHeader field="mode" current={sort} onChange={setSort}>
            Mode
          </SortHeader>
          <div className="uppercase tracking-wider text-stone-400">Hits</div>
          <SortHeader field="timestamp" current={sort} onChange={setSort} defaultDir="desc">
            When
          </SortHeader>
          <SortHeader field="durationMs" current={sort} onChange={setSort} defaultDir="desc">
            Duration
          </SortHeader>
        </div>
        {sorted.map((row) => {
          const totalHits =
            (row.orgHits ?? 0) +
            (row.catalogHits ?? 0) +
            (row.releaseHits ?? 0) +
            (row.chunkHits ?? 0);
          const hasHitFields =
            row.orgHits != null ||
            row.catalogHits != null ||
            row.releaseHits != null ||
            row.chunkHits != null;
          const hitsDetail = [
            row.orgHits != null && `${row.orgHits} org`,
            row.catalogHits != null && `${row.catalogHits} cat`,
            row.releaseHits != null && `${row.releaseHits} rel`,
            row.chunkHits != null && `${row.chunkHits} chunk`,
          ]
            .filter(Boolean)
            .join(" · ");

          return (
            <div
              key={row.id}
              className="grid grid-cols-[2.4fr_1.4fr_0.6fr_0.7fr_1.4fr_0.7fr] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors items-center"
            >
              <Link
                href={`/search?q=${encodeURIComponent(row.query)}`}
                className="text-stone-900 dark:text-stone-100 truncate hover:underline"
                title={row.query}
              >
                {row.query}
              </Link>
              <div className="flex flex-wrap gap-1">
                <Pill
                  label={row.surface}
                  tone={surfaceTone(row.surface)}
                  title={`Transport: ${row.surface}`}
                />
                {shouldRenderClientKind(row.clientKind) ? (
                  <Pill
                    label={row.clientKind}
                    tone={clientKindTone(row.clientKind)}
                    title={`Client: ${row.clientKind}`}
                  />
                ) : null}
                {row.authed === true ? (
                  <Pill label="auth" tone="emerald" title="Valid Bearer token" />
                ) : null}
              </div>
              <div className={`capitalize ${modeColor(row.mode)}`}>{row.mode ?? "—"}</div>
              <div className="text-stone-500" title={hitsDetail || undefined}>
                {hasHitFields ? totalHits : "—"}
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

export function SearchQueriesTab(): React.ReactElement {
  return (
    <div className="space-y-8">
      <TopQueriesTable />
      <RecentQueriesTable />
    </div>
  );
}
