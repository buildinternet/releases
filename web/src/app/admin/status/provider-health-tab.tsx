"use client";

import type { ReactNode } from "react";
import type { ProviderHealthSource } from "@buildinternet/releases-api-types";
import type { ProviderHealthState } from "./use-provider-health";

/** "just now" / "6h ago" / "9d ago" from a day count (fractional days allowed). */
function formatDaysAgo(days: number): string {
  if (days < 1) return "<1d ago";
  if (days < 30) return `${Math.round(days)}d ago`;
  if (days < 365) return `${Math.round(days / 30)}mo ago`;
  return `${(days / 365).toFixed(1)}y ago`;
}

/**
 * Persistent, always-visible summary — deliberately not tab-gated, because
 * the whole point (#2168 postmortem) is that an operator shouldn't have to
 * know to click into a "Health" tab to notice ingest has stopped. Renders
 * nothing when healthy, so a quiet system stays quiet.
 *
 * Subtle-cue styling (dot + color + weight, no new chip row) per house style:
 * chip rows read as noisy — see the incident banner above, which uses the
 * same bordered-panel language for the same reason.
 */
export function ProviderHealthBanner({
  state,
  onOpenHealth,
}: {
  state: ProviderHealthState;
  onOpenHealth: () => void;
}): ReactNode {
  const { data, error } = state;
  if (error) {
    return (
      <div className="mb-3 px-3 py-2 rounded border text-xs flex items-center gap-2 border-stone-200 dark:border-stone-700 bg-stone-50 dark:bg-stone-900/40 text-stone-500 dark:text-stone-400">
        <span className="w-1.5 h-1.5 rounded-full bg-stone-400 shrink-0" aria-hidden="true" />
        <span>Provider health check failed to load — the rest of the dashboard is unaffected.</span>
      </div>
    );
  }
  if (!data || data.meta.overdueSources === 0) return null;

  const { overdueSources, overdueOrgs, overdueThresholdDays } = data.meta;
  // Two or more orgs affected at once is the systemic tell from the outage
  // this surface exists to catch (11 sources across multiple orgs, all
  // frozen at once) — a single overdue source is far more often one flaky
  // scrape target than a provider-wide shutoff, so it reads as a lighter
  // warning rather than an incident.
  const widespread = overdueOrgs >= 2;
  const tone = widespread
    ? "border-red-300 dark:border-red-800 bg-red-50 dark:bg-red-950/40 text-red-900 dark:text-red-300"
    : "border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-900 dark:text-amber-200";
  const dotColor = widespread ? "bg-red-500" : "bg-amber-500";
  const label = widespread ? "possible ingest/provider outage" : "source(s) overdue for evaluation";

  return (
    <div className={`mb-3 px-3 py-2 rounded border text-xs flex items-center gap-2 ${tone}`}>
      <span
        className={`w-1.5 h-1.5 rounded-full shrink-0 ${dotColor}`}
        aria-label={widespread ? "Widespread" : "Isolated"}
        role="img"
      />
      <span className="flex-1">
        <span className="font-medium">{overdueSources}</span> {label} — last successful check frozen
        past {overdueThresholdDays}d, across <span className="font-medium">{overdueOrgs}</span> org
        {overdueOrgs === 1 ? "" : "s"}.
      </span>
      <button type="button" onClick={onOpenHealth} className="shrink-0 font-medium hover:underline">
        View
      </button>
    </div>
  );
}

/**
 * Detail table for the Health tab. Leads with `lastFetchedAt` — the "we
 * successfully evaluated this source" signal — rather than release date, so a
 * healthy-but-quiet source (recently checked, nothing new) never gets
 * confused with a broken one (checks have stopped landing). Only overdue
 * sources are listed; a healthy fleet renders an explicit "all clear" rather
 * than an empty-looking table, so the absence of rows reads as good news, not
 * as a broken query.
 */
export function ProviderHealthTab({ state }: { state: ProviderHealthState }): ReactNode {
  const { data, error, loading } = state;

  if (error) {
    return (
      <div className="text-sm text-red-500 py-8 text-center">
        Failed to load provider health — API may be unreachable.
      </div>
    );
  }
  if (loading && !data) {
    return (
      <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
        Loading provider health…
      </div>
    );
  }
  if (!data) return null;

  const { meta, items } = data;

  return (
    <div>
      <p className="text-xs text-stone-400 dark:text-stone-500 mb-3">
        Sources whose last successful check (<code>last_fetched_at</code>, written on every success
        including no-change) is older than {meta.overdueThresholdDays}d. This is independent of
        release recency — a quiet source that is still being checked is healthy; a source that has
        stopped being checked is not.
      </p>

      <div className="flex items-center gap-4 mb-4 text-xs">
        <SummaryStat label="Active sources" value={meta.totalActiveSources} />
        <SummaryStat
          label="Overdue"
          value={meta.overdueSources}
          tone={meta.overdueSources > 0 ? "warn" : "ok"}
        />
        <SummaryStat
          label="Orgs affected"
          value={`${meta.overdueOrgs} / ${meta.totalOrgs}`}
          tone={meta.overdueOrgs >= 2 ? "danger" : meta.overdueOrgs > 0 ? "warn" : "ok"}
        />
      </div>

      {items.length === 0 ? (
        <div className="text-sm text-green-600 dark:text-green-500 py-8 text-center">
          All active sources have a recent successful check. Nothing overdue.
        </div>
      ) : (
        <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
          <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1.2fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
            <div>Source</div>
            <div>Type</div>
            <div>Priority</div>
            <div>Last checked</div>
            <div></div>
          </div>
          {items.map((s) => (
            <ProviderHealthRow key={s.sourceId} s={s} />
          ))}
        </div>
      )}
    </div>
  );
}

function SummaryStat({
  label,
  value,
  tone = "ok",
}: {
  label: string;
  value: number | string;
  tone?: "ok" | "warn" | "danger";
}): ReactNode {
  const toneClass = {
    ok: "text-stone-900 dark:text-stone-100",
    warn: "text-amber-600 dark:text-amber-400",
    danger: "text-red-500",
  }[tone];
  return (
    <div>
      <div className={`text-base font-semibold ${toneClass}`}>{value}</div>
      <div className="text-stone-400 dark:text-stone-500">{label}</div>
    </div>
  );
}

function ProviderHealthRow({ s }: { s: ProviderHealthSource }): ReactNode {
  // Longer overdue = redder, via font weight + color rather than a new badge.
  const ageClass =
    s.daysSinceFetched >= 14
      ? "text-red-500 font-medium"
      : "text-amber-600 dark:text-amber-400 font-medium";
  return (
    <div className="grid grid-cols-[2fr_1fr_1fr_1fr_1.2fr] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors items-center">
      <div className="min-w-0">
        <div className="text-stone-900 dark:text-stone-100 truncate flex items-center gap-1.5">
          <span
            className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0"
            aria-label="Overdue for evaluation"
            role="img"
          />
          <span className="truncate">{s.name}</span>
        </div>
        <div className="text-stone-400 text-[10px] truncate">
          {(s.orgSlug ?? "—") + " · " + s.sourceSlug}
        </div>
      </div>
      <div className="text-stone-500 capitalize">{s.type}</div>
      <div className="text-stone-500 capitalize">{s.fetchPriority}</div>
      <div className={ageClass} title={s.lastFetchedAt ?? "Never fetched"}>
        {s.lastFetchedAt ? formatDaysAgo(s.daysSinceFetched) : "never"}
      </div>
      <div />
    </div>
  );
}
