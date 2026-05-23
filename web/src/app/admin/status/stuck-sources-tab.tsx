"use client";

import { useCallback, useEffect, useState } from "react";
import type { StuckSource, StuckSourcesResponse } from "@buildinternet/releases-api-types";

/** "never" / "<1d ago" / "47d ago" / "3mo ago" / "1.2y ago" from an ISO string. */
function formatRelativeAge(iso: string | null): string {
  if (!iso) return "never";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "never";
  const days = Math.max(0, (Date.now() - t) / 86_400_000);
  if (days < 1) return "<1d ago";
  if (days < 30) return `${Math.round(days)}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

export function StuckSourcesTab() {
  const [rows, setRows] = useState<StuckSource[] | null>(null);
  const [meta, setMeta] = useState<StuckSourcesResponse["meta"] | null>(null);
  const [totalItems, setTotalItems] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [includePaused, setIncludePaused] = useState(false);
  const [page, setPage] = useState(1);
  const [pausing, setPausing] = useState<Set<string>>(new Set());
  const [pauseError, setPauseError] = useState<Record<string, string>>({});
  const perPage = 100;

  useEffect(() => {
    setRows(null);
    setErr(null);
    const params = new URLSearchParams({ limit: String(perPage), page: String(page) });
    if (includePaused) params.set("includePaused", "true");
    const controller = new AbortController();
    fetch(`/api/proxy/admin/sources/stuck?${params}`, { signal: controller.signal })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return (await r.json()) as StuckSourcesResponse;
      })
      .then((data) => {
        if (controller.signal.aborted) return;
        setRows(data.items);
        setMeta(data.meta);
        setTotalItems(data.pagination.totalItems ?? data.items.length);
      })
      .catch((e) => {
        if (controller.signal.aborted) return;
        setErr(e instanceof Error ? e.message : String(e));
      });
    return () => controller.abort();
  }, [includePaused, page]);

  // Pause = PATCH fetchPriority. The typed `src_…` ID is used on the bare path
  // (the legacy bare-slug path was retired in #698). In the default view the
  // row drops out (it's no longer a stuck *candidate*); in the paused-inclusive
  // view it stays visible and just flips to its paused state.
  const pauseSource = useCallback(
    async (s: StuckSource) => {
      setPausing((prev) => new Set(prev).add(s.sourceId));
      setPauseError((prev) => {
        const next = { ...prev };
        delete next[s.sourceId];
        return next;
      });
      try {
        const res = await fetch(`/api/proxy/sources/${s.sourceId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ fetchPriority: "paused" }),
        });
        if (!res.ok) throw new Error(`${res.status}`);
        if (includePaused) {
          setRows((prev) =>
            prev
              ? prev.map((r) => (r.sourceId === s.sourceId ? { ...r, fetchPriority: "paused" } : r))
              : prev,
          );
        } else {
          setRows((prev) => (prev ? prev.filter((r) => r.sourceId !== s.sourceId) : prev));
          setTotalItems((t) => (t != null ? Math.max(0, t - 1) : t));
        }
      } catch (e) {
        setPauseError((prev) => ({
          ...prev,
          [s.sourceId]: e instanceof Error ? e.message : "failed",
        }));
      } finally {
        setPausing((prev) => {
          const next = new Set(prev);
          next.delete(s.sourceId);
          return next;
        });
      }
    },
    [includePaused],
  );

  const explainer = meta
    ? `Sources whose last ${meta.window} fetch attempts all failed (≥${meta.minAttempts} attempts), with no successful fetch in between.`
    : "Sources whose recent fetch attempts all failed, with no successful fetch in between.";
  const totalPages = totalItems != null ? Math.max(1, Math.ceil(totalItems / perPage)) : 1;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3">
        <p className="text-xs text-stone-400 dark:text-stone-500">{explainer}</p>
        <button
          onClick={() => {
            setIncludePaused((v) => !v);
            setPage(1);
          }}
          title="Include sources that are already paused"
          className={`shrink-0 px-2.5 py-1 text-xs rounded-full transition-colors ${
            includePaused
              ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
              : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
          }`}
        >
          Include paused
        </button>
      </div>

      {err && <div className="text-red-500 text-xs">Error loading stuck sources: {err}</div>}
      {!err && !rows && <div className="text-stone-500 text-xs">Loading...</div>}
      {!err && rows && rows.length === 0 && (
        <div className="text-stone-500 dark:text-stone-400 text-sm py-8 text-center">
          No stuck sources.
        </div>
      )}

      {!err && rows && rows.length > 0 && (
        <>
          <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
            <div className="grid grid-cols-[2fr_0.7fr_0.8fr_0.7fr_1fr_2fr_auto] gap-x-4 px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
              <div>Source</div>
              <div>Type</div>
              <div>Priority</div>
              <div className="text-right">Errors</div>
              <div>Last OK</div>
              <div>Last Error</div>
              <div></div>
            </div>
            {rows.map((s) => (
              <StuckRow
                key={s.sourceId}
                s={s}
                pausing={pausing.has(s.sourceId)}
                pauseError={pauseError[s.sourceId]}
                onPause={() => pauseSource(s)}
              />
            ))}
          </div>
          <div className="flex items-center justify-between mt-3 text-xs text-stone-400 dark:text-stone-500">
            <span>
              {totalItems != null ? `${totalItems.toLocaleString()} stuck source(s)` : null}
              {meta ? ` · window=${meta.window} · minAttempts=${meta.minAttempts}` : null}
            </span>
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
        </>
      )}
    </div>
  );
}

function StuckRow({
  s,
  pausing,
  pauseError,
  onPause,
}: {
  s: StuckSource;
  pausing: boolean;
  pauseError?: string;
  onPause: () => void;
}) {
  const isPaused = s.fetchPriority === "paused";
  return (
    <div className="grid grid-cols-[2fr_0.7fr_0.8fr_0.7fr_1fr_2fr_auto] gap-x-4 px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors items-center">
      <div className="min-w-0">
        <div className="text-stone-900 dark:text-stone-100 truncate flex items-center gap-1.5">
          <span className="truncate" title={s.url}>
            {s.name}
          </span>
          {s.isPrimary && (
            <span
              className="shrink-0 text-[10px] font-sans font-medium px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
              title="This source is the org's primary changelog"
            >
              primary
            </span>
          )}
        </div>
        <div className="text-stone-400 text-[10px] truncate">
          {(s.orgSlug ?? "—") + " · " + s.sourceSlug}
        </div>
      </div>
      <div className="text-stone-500 capitalize">{s.type}</div>
      <div className={`capitalize ${isPaused ? "text-stone-400" : "text-stone-500"}`}>
        {s.fetchPriority}
      </div>
      <div
        className="text-right text-red-500"
        title={`${s.recentErrors} of last ${s.recentAttempts} attempts failed`}
      >
        {s.recentErrors}/{s.recentAttempts}
      </div>
      <div
        className={s.lastSuccessAt ? "text-stone-500" : "text-amber-600 dark:text-amber-400"}
        title={s.lastSuccessAt ?? "Never fetched successfully"}
      >
        {formatRelativeAge(s.lastSuccessAt)}
      </div>
      <div className="text-stone-500 truncate" title={s.lastError ?? undefined}>
        {s.lastError ?? "—"}
      </div>
      <div className="flex items-center justify-end gap-2">
        {pauseError && <span className="text-red-500 text-[10px]">{pauseError}</span>}
        {isPaused ? (
          <span className="text-stone-400 text-xs">paused</span>
        ) : (
          <button
            onClick={onPause}
            disabled={pausing}
            className="px-2.5 py-1 text-xs rounded border border-stone-300 dark:border-stone-600 text-stone-600 dark:text-stone-300 hover:bg-stone-100 dark:hover:bg-stone-700 disabled:opacity-40 disabled:cursor-default transition-colors"
          >
            {pausing ? "Pausing..." : "Pause"}
          </button>
        )}
      </div>
    </div>
  );
}
