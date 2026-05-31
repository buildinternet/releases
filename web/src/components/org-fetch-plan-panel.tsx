"use client";

import { useState, useTransition } from "react";
import {
  setFetchPriorityAction,
  syncFirecrawlAction,
  type ActionResult,
} from "@/app/actions/source-admin";
import { useFetchPlan, type FetchPlanRow } from "./use-fetch-plan";
import { relativeTime } from "./fetch-log-shared";

// Single source of truth for the priority dropdown: drives both the option list
// and the `Priority` union, so a tier can't be added in one place and missed in
// the other. Labels mirror the server's TIER_INTERVALS.
const TIERS = [
  { value: "normal", label: "every 4 hours" },
  { value: "low", label: "every 24 hours" },
  { value: "paused", label: "paused" },
] as const;
type Priority = (typeof TIERS)[number]["value"];

function StarvedBadge({ staleHours }: { staleHours: number | null }) {
  const label =
    staleHours == null
      ? "stale"
      : staleHours >= 48
        ? `${Math.round(staleHours / 24)}d stale`
        : `${Math.round(staleHours)}h stale`;
  return (
    <span
      className="ml-1.5 text-[10px] font-sans uppercase tracking-wide text-red-500"
      title="Queued for the managed scrape sweep but not fetched within the staleness window — the sweep isn't draining it. Usually a change-detector that flaps every poll, a binding session cap, or a page better served by Firecrawl or a feed URL. Check this source's config."
    >
      starved · {label}
    </span>
  );
}

function NextDueCell({ row, now }: { row: FetchPlanRow; now: number }) {
  if (row.plan.cadence === "firecrawl-webhook")
    return <span className="text-stone-400">webhook</span>;
  if (row.plan.paused) return <span className="text-stone-400">—</span>;
  return (
    <span className="text-stone-500">
      {relativeTime(row.state.nextDueAt, now)}
      {row.state.backedOff && (
        <span className="ml-1.5 text-[10px] font-sans uppercase tracking-wide text-amber-500">
          backed off
        </span>
      )}
    </span>
  );
}

function PlanRowItem({
  row,
  orgSlug,
  now,
  onChanged,
  onSelectSource,
}: {
  row: FetchPlanRow;
  orgSlug: string;
  now: number;
  onChanged: () => void;
  onSelectSource?: (id: string) => void;
}) {
  const [pending, startTransition] = useTransition();
  const [err, setErr] = useState<string | null>(null);
  const isFirecrawl = row.plan.strategy === "firecrawl";

  function run(action: () => Promise<ActionResult>) {
    setErr(null);
    startTransition(async () => {
      const res = await action();
      if (!res.ok) setErr(res.error);
      else onChanged();
    });
  }

  function onPriorityChange(priority: Priority) {
    run(() => setFetchPriorityAction({ orgSlug, sourceSlug: row.slug, priority }));
  }

  function onFirecrawlToggle(next: boolean) {
    if (
      next &&
      !window.confirm(
        `Enable Firecrawl for "${row.name}"? This provisions an external monitor that bills Firecrawl credits.`,
      )
    ) {
      return;
    }
    run(() => syncFirecrawlAction({ orgSlug, sourceId: row.id, enabled: next }));
  }

  return (
    <div className="grid grid-cols-[2fr_1.5fr_1.2fr_1fr_1fr] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 last:border-b-0 items-center">
      <div className="text-stone-900 dark:text-stone-100">
        <a
          href={`/source/${row.slug}`}
          className="hover:underline text-stone-900 dark:text-stone-100"
        >
          {row.name}
        </a>
        <button
          type="button"
          onClick={() => onSelectSource?.(row.id)}
          className="ml-2 text-[10px] font-sans px-1.5 py-0.5 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800"
          title="Show ingestion workflow"
        >
          Flow
        </button>
        {row.sweep.starved && <StarvedBadge staleHours={row.sweep.staleHours} />}
        {err && <div className="text-[10px] font-sans text-red-500 mt-0.5">{err}</div>}
      </div>
      <div className="text-stone-500 flex items-center gap-2">
        {row.plan.strategyLabel}
        <button
          type="button"
          disabled={pending}
          onClick={() => onFirecrawlToggle(!isFirecrawl)}
          className="text-[10px] font-sans px-1.5 py-0.5 rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-40"
          title="Toggle Firecrawl monitoring"
        >
          {isFirecrawl ? "Disable FC" : "Enable FC"}
        </button>
      </div>
      <div className="text-stone-500">
        {isFirecrawl ? (
          row.plan.intervalLabel
        ) : (
          <select
            value={row.fetchPriority}
            disabled={pending}
            onChange={(e) => onPriorityChange(e.target.value as Priority)}
            className="bg-transparent border border-stone-200 dark:border-stone-700 rounded px-1 py-0.5 disabled:opacity-40"
          >
            {TIERS.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        )}
      </div>
      <div className="text-stone-400">{relativeTime(row.state.lastPolledAt, now)}</div>
      <div>
        <NextDueCell row={row} now={now} />
      </div>
    </div>
  );
}

export function OrgFetchPlanPanel({
  orgSlug,
  onSelectSource,
}: {
  orgSlug: string;
  onSelectSource?: (id: string) => void;
}) {
  const { rows, loading, error, refetch } = useFetchPlan(orgSlug);
  const now = Date.now();

  if (loading && rows.length === 0) {
    return (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-4">Loading fetch plan…</div>
    );
  }
  if (error && rows.length === 0) {
    return <div className="text-sm text-red-500 py-4">Failed to load fetch plan: {error}</div>;
  }
  if (rows.length === 0) return null;

  return (
    <div className="mb-6">
      <h2 className="text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-2">
        Fetch plan
      </h2>
      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[2fr_1.5fr_1.2fr_1fr_1fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
          <div>Source</div>
          <div>Strategy</div>
          <div>Interval</div>
          <div>Last poll</div>
          <div>Next due</div>
        </div>
        {rows.map((row) => (
          <PlanRowItem
            key={row.id}
            row={row}
            orgSlug={orgSlug}
            now={now}
            onChanged={refetch}
            onSelectSource={onSelectSource}
          />
        ))}
      </div>
    </div>
  );
}
