"use client";

import { useEffect, useState } from "react";
import { summarizeForceDrain, type ForceDrainTone } from "./force-drain-helpers";

type ForceDrainRun = {
  startedAt: string;
  status: string;
  notes: string | null;
};

const toneClass: Record<ForceDrainTone, string> = {
  healthy: "text-green-600 dark:text-green-400",
  stranded: "text-amber-600 dark:text-amber-400",
  failed: "text-red-600 dark:text-red-400",
  never: "text-stone-400 dark:text-stone-500",
};

/**
 * Single-line summary of the force-drain sweep (issue #518). Shows the
 * stranded count + last run age so operators can see at a glance whether
 * stale/unreliable sources are piling up. Fails quiet: a 404/error or a pre-
 * flag-flip absence of runs both render harmlessly instead of an alert.
 */
export function ForceDrainTile() {
  const [run, setRun] = useState<ForceDrainRun | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/proxy/admin/cron-runs?cron=force-drain-sweep&limit=1")
      .then((r) => (r.ok ? r.json() : null))
      .then((data: ForceDrainRun[] | null) => {
        if (cancelled) return;
        setRun(data && data.length > 0 ? data[0] : null);
      })
      .catch(() => {
        if (!cancelled) setRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (run === undefined) return null;

  const summary = summarizeForceDrain(run);

  return (
    <div className="text-xs text-stone-500 dark:text-stone-400 mb-4 px-3 py-2 bg-stone-100 dark:bg-stone-800 rounded-md flex items-center gap-2">
      <span className="text-stone-400 dark:text-stone-500">Force-drain:</span>
      <span className={toneClass[summary.tone]}>{summary.label}</span>
    </div>
  );
}
