"use client";
import { useEffect } from "react";
import { useSourceWorkflow, type RunStatus } from "./use-source-workflow";
import { WorkflowPipeline } from "./workflow-pipeline";
import { relativeTime } from "./fetch-log-shared";

const PILL: Record<string, string> = {
  paused: "border-stone-400 text-stone-500",
  starved: "border-red-400 text-red-500",
  "backed off": "border-amber-400 text-amber-600 dark:text-amber-300",
  scheduled: "border-emerald-400 text-emerald-600 dark:text-emerald-300",
};

const SPARK: Record<RunStatus, string> = {
  success: "bg-emerald-500",
  error: "bg-red-500",
  no_change: "bg-stone-400",
  dry_run: "bg-sky-500",
};

export function SourceWorkflowDrawer({
  sourceId,
  onClose,
}: {
  sourceId: string | null;
  onClose: () => void;
}) {
  const { data, loading, error, refresh } = useSourceWorkflow(sourceId);

  useEffect(() => {
    if (!sourceId) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [sourceId, onClose]);

  if (!sourceId) return null;
  const statePill = data?.state.paused
    ? "paused"
    : data?.sweep.starved
      ? "starved"
      : data?.state.backedOff
        ? "backed off"
        : "scheduled";

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 w-[420px] max-w-[90vw] bg-white dark:bg-stone-950 border-l border-stone-200 dark:border-stone-800 shadow-xl overflow-y-auto p-5">
        <div className="flex items-start justify-between mb-3">
          <div>
            <h2 className="font-mono text-sm text-stone-900 dark:text-stone-100">
              {data?.source.name ?? "…"}
            </h2>
            {data && (
              <div className="mt-1 flex items-center gap-2 text-[10px]">
                <span className="px-1.5 py-0.5 rounded-full border border-stone-300 dark:border-stone-700 text-stone-500">
                  {data.source.strategyLabel}
                </span>
                <span
                  className={`px-1.5 py-0.5 rounded-full border ${PILL[statePill] ?? PILL.scheduled}`}
                >
                  {statePill}
                </span>
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-[11px] text-stone-400 hover:text-stone-600 dark:hover:text-stone-300 font-sans px-1.5 py-0.5 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800"
            aria-label="Close"
          >
            Close
          </button>
        </div>

        {loading && !data && <div className="text-xs text-stone-400 py-6">Loading workflow…</div>}
        {error && (
          <div className="text-xs text-red-500 py-6">
            Failed to load: {error}
            <button
              type="button"
              onClick={() => void refresh()}
              className="ml-2 text-[11px] font-sans text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
            >
              Try again
            </button>
          </div>
        )}

        {data && (
          <>
            <div className="grid grid-cols-2 gap-3 mb-4 text-[11px] font-mono">
              <div>
                <div className="text-[9px] uppercase tracking-wide text-stone-400">Next due</div>
                {data.plan.cadence === "firecrawl-webhook"
                  ? "webhook"
                  : `${relativeTime(data.state.nextDueAt)} · ${data.plan.intervalLabel}`}
              </div>
              <div>
                <div className="text-[9px] uppercase tracking-wide text-stone-400">Last run</div>
                {data.lastRun
                  ? `${relativeTime(data.lastRun.createdAt)} · ${data.lastRun.status}`
                  : "never"}
              </div>
              <div className="col-span-2">
                <div className="text-[9px] uppercase tracking-wide text-stone-400 mb-1">
                  Last {data.sparkline.length} runs
                </div>
                <div className="flex items-end gap-0.5 h-5">
                  {data.sparkline.map((s, i) => (
                    <span
                      key={i}
                      className={`w-1.5 rounded-sm ${SPARK[s]}`}
                      style={{ height: s === "no_change" ? "30%" : "80%" }}
                      title={s}
                    />
                  ))}
                </div>
              </div>
            </div>
            <WorkflowPipeline
              key={data.source.id}
              stages={data.stages}
              lastRun={data.lastRun}
              aiPasses={data.aiPasses}
            />
            <button
              type="button"
              onClick={() => void refresh()}
              className="mt-4 text-[11px] font-sans text-stone-500 hover:text-stone-700 dark:hover:text-stone-300"
            >
              Refresh
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
