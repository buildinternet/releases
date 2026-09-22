"use client";

import { useEffect, useState } from "react";
import type { SemanticAlertSummary } from "@buildinternet/releases-api-types";
import {
  formatMatchRate,
  formatQualityBucket,
  formatQualityCount,
  readSemanticAlertSummary,
  SEMANTIC_ALERT_DAILY_SPEND_APL,
  SEMANTIC_ALERT_QUALITY_EMPTY,
  SEMANTIC_ALERT_QUALITY_ERROR,
  SEMANTIC_ALERT_QUALITY_LOADING,
  SEMANTIC_ALERT_QUALITY_RANGES,
  SEMANTIC_ALERT_WEEKLY_SPEND_APL,
  semanticAlertFailureNote,
  semanticAlertQualityState,
  semanticAlertQualityWindow,
  semanticAlertSummaryUrl,
  type SemanticAlertQualityRange,
} from "./quality-view";

const BAR_COLORS = {
  matched: "bg-emerald-500",
  belowThreshold: "bg-amber-500",
  failed: "bg-rose-500",
} as const;

function Kpi({
  label,
  value,
  className = "",
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className="rounded-lg border border-stone-200 bg-white px-3 py-2 dark:border-stone-800 dark:bg-stone-950/40">
      <div className="text-[10px] uppercase tracking-wide text-stone-400 dark:text-stone-500">
        {label}
      </div>
      <div
        className={`mt-0.5 text-sm font-semibold tabular-nums tracking-tight text-stone-900 dark:text-stone-100 ${className}`}
      >
        {value}
      </div>
    </div>
  );
}

function RangeControl({
  range,
  onChange,
}: {
  range: SemanticAlertQualityRange;
  onChange: (range: SemanticAlertQualityRange) => void;
}) {
  return (
    <div className="flex gap-1">
      {SEMANTIC_ALERT_QUALITY_RANGES.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={range === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-full px-2.5 py-1 text-xs transition-colors ${
            range === option.value
              ? "bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900"
              : "bg-stone-100 text-stone-500 hover:bg-stone-200 dark:bg-stone-800 dark:text-stone-400 dark:hover:bg-stone-700"
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function StackedBar({
  matched,
  belowThreshold,
  failed,
}: {
  matched: number;
  belowThreshold: number;
  failed: number;
}) {
  const total = matched + belowThreshold + failed;
  if (total <= 0) {
    return <div className="h-2 rounded bg-stone-100 dark:bg-stone-800" />;
  }
  return (
    <div className="flex h-2 overflow-hidden rounded bg-stone-100 dark:bg-stone-800">
      {matched > 0 ? (
        <div className={BAR_COLORS.matched} style={{ width: `${(matched / total) * 100}%` }} />
      ) : null}
      {belowThreshold > 0 ? (
        <div
          className={BAR_COLORS.belowThreshold}
          style={{ width: `${(belowThreshold / total) * 100}%` }}
        />
      ) : null}
      {failed > 0 ? (
        <div className={BAR_COLORS.failed} style={{ width: `${(failed / total) * 100}%` }} />
      ) : null}
    </div>
  );
}

export function SemanticAlertQualityReport({ summary }: { summary: SemanticAlertSummary }) {
  const { totals, series, probability, failures } = summary;
  const maxBin = Math.max(...probability.bins.map((bin) => bin.count), 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        <Kpi label="Scored" value={formatQualityCount(totals.scored)} />
        <Kpi
          label="Matched"
          value={formatQualityCount(totals.matched)}
          className="text-emerald-600 dark:text-emerald-400"
        />
        <Kpi label="Match rate" value={formatMatchRate(totals.matchRate)} />
        <Kpi
          label="Below threshold"
          value={formatQualityCount(totals.belowThreshold)}
          className="text-amber-600 dark:text-amber-400"
        />
        <Kpi
          label="Fail-closed"
          value={formatQualityCount(totals.failed)}
          className="text-rose-600 dark:text-rose-400"
        />
      </div>

      <div className="space-y-1.5">
        {series.length === 0 ? (
          <p className="text-xs text-stone-400">No time buckets in this range.</p>
        ) : (
          series.map((point) => (
            <div key={point.t} className="grid grid-cols-[4.5rem_1fr_auto] items-center gap-2">
              <span className="text-[11px] text-stone-500">
                {formatQualityBucket(point.t, summary.bucket)}
              </span>
              <StackedBar
                matched={point.matched}
                belowThreshold={point.belowThreshold}
                failed={point.failed}
              />
              <span className="text-[11px] tabular-nums text-stone-500">
                {formatQualityCount(point.matched + point.belowThreshold + point.failed)}
              </span>
            </div>
          ))
        )}
        <p className="flex flex-wrap gap-3 text-[11px] text-stone-400">
          <span className="inline-flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-sm ${BAR_COLORS.matched}`} />
            Matched
          </span>
          <span className="inline-flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-sm ${BAR_COLORS.belowThreshold}`} />
            Below threshold
          </span>
          <span className="inline-flex items-center gap-1">
            <span className={`inline-block h-2 w-2 rounded-sm ${BAR_COLORS.failed}`} />
            Fail-closed
          </span>
        </p>
      </div>

      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-400">
          P(true) vs 0.80 default
        </h3>
        <div className="mt-2 flex h-16 items-end gap-1">
          {probability.bins.map((bin) => {
            const height = maxBin > 0 ? Math.max(4, (bin.count / maxBin) * 100) : 4;
            const marked = bin.start === probability.defaultThreshold;
            return (
              <div key={bin.start} className="flex flex-1 flex-col items-center gap-1">
                <div
                  className={`w-full rounded-sm ${marked ? "bg-amber-500" : "bg-stone-300 dark:bg-stone-600"}`}
                  style={{ height: `${bin.count > 0 ? height : 4}%` }}
                  title={`${bin.start.toFixed(1)}–${bin.end.toFixed(1)}: ${bin.count}`}
                />
                <span className="text-[10px] text-stone-400">{bin.start.toFixed(1)}</span>
              </div>
            );
          })}
        </div>
        {probability.missing > 0 ? (
          <p className="mt-1 text-[11px] text-stone-400">
            {formatQualityCount(probability.missing)} missing probability
          </p>
        ) : null}
      </div>

      {failures.length > 0 ? (
        <ul className="text-xs text-stone-600 dark:text-stone-400">
          {failures.map((row) => (
            <li key={row.category}>
              {row.category} {formatQualityCount(row.count)}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function SemanticAlertSpendNote() {
  return (
    <div className="space-y-2 text-sm text-stone-600 dark:text-stone-400">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-stone-400">JEV spend</h3>
      <p>
        Cost is not on the counts above. One JEV call covers many alerts, so a per-alert dollar
        figure would over-count. In Axiom, sum <code>costUsd</code> on <code>ai_usage</code> events
        with <code>lane == semantic-alert-match</code>. The same rows have <code>calls</code>,{" "}
        <code>questionCount</code>, and <code>releaseId</code>. Alert query text is not on the
        event.
      </p>
      <details>
        <summary className="cursor-pointer text-xs text-stone-500">Daily and weekly APL</summary>
        <p className="mt-2 text-xs text-stone-500">
          Spend that rises with questions is volume. Spend that rises while questions stay flat is a
          price or model change.
        </p>
        <pre className="mt-2 overflow-x-auto rounded border border-stone-200 bg-stone-50 p-3 text-[11px] leading-relaxed text-stone-700 dark:border-stone-800 dark:bg-stone-950 dark:text-stone-300">
          {SEMANTIC_ALERT_DAILY_SPEND_APL}
          {"\n\n"}
          {SEMANTIC_ALERT_WEEKLY_SPEND_APL}
        </pre>
      </details>
    </div>
  );
}

export function SemanticAlertQualityPanel() {
  const [range, setRange] = useState<SemanticAlertQualityRange>("week");
  const [summary, setSummary] = useState<SemanticAlertSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [errorNote, setErrorNote] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const window = semanticAlertQualityWindow(range);
    setLoading(true);
    setError(false);
    setErrorNote(null);
    fetch(semanticAlertSummaryUrl(window), { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => null)) as unknown;
        if (cancelled) return;
        if (!res.ok) {
          setErrorNote(semanticAlertFailureNote(body));
          throw new Error(`summary ${res.status}`);
        }
        const next = readSemanticAlertSummary(body);
        if (!next) throw new Error("unexpected summary");
        setSummary(next);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (cancelled || (err instanceof Error && err.name === "AbortError")) return;
        setError(true);
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [range]);

  const attempts = summary ? summary.totals.scored + summary.totals.failed : null;
  const state = semanticAlertQualityState({ loading, error, attempts: error ? null : attempts });

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-1">
          <h2 className="text-sm font-medium text-stone-900 dark:text-stone-100">Match quality</h2>
          <p className="max-w-xl text-sm text-stone-600 dark:text-stone-400">
            Sampled Analytics Engine counts (about 90 days). Match rate is matched divided by scored
            — matched plus below threshold. Fail-closed skips notify and stays out of the rate.
          </p>
        </div>
        <RangeControl range={range} onChange={setRange} />
      </div>
      {state === "loading" ? (
        <p className="text-xs text-stone-500">{SEMANTIC_ALERT_QUALITY_LOADING}</p>
      ) : null}
      {state === "error" ? (
        <p className="text-xs text-red-500">
          {SEMANTIC_ALERT_QUALITY_ERROR}
          {errorNote ? <span className="mt-1 block">{errorNote}</span> : null}
        </p>
      ) : null}
      {state === "empty" ? (
        <p className="text-xs text-stone-500">{SEMANTIC_ALERT_QUALITY_EMPTY}</p>
      ) : null}
      {(state === "ready" || state === "empty") && summary ? (
        <SemanticAlertQualityReport summary={summary} />
      ) : null}
      <SemanticAlertSpendNote />
    </section>
  );
}
