"use client";

/**
 * Status → Classifications. Fetch failures stay in this tab; each chart has
 * its own boundary so one bad series cannot blank the rest of Status.
 */
import {
  Component,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import Link from "next/link";
import { formatStatusTimestamp } from "./status-shared";
import { ChoiceChart, DispositionChart, ProbabilityHistogram } from "./classifications-charts";
import type {
  ClassificationOrigin,
  ClassificationRecentItem,
  ClassificationSummary,
} from "./classifications-types";
import {
  CLASSIFICATION_ORIGIN_OPTIONS,
  CLASSIFICATIONS_EMPTY_COPY,
  CLASSIFICATIONS_ERROR_COPY,
  CLASSIFICATIONS_LOADING_COPY,
  classificationFailureNote,
  DEFAULT_CLASSIFICATION_ORIGIN,
  EMPTY_MARK,
  classificationRecentUrl,
  classificationSummaryUrl,
  classificationViewState,
  classificationWindow,
  decisionReason,
  formatClassificationCost,
  formatProbability,
  formatSuppressionRate,
  readClassificationRecent,
  readClassificationSummary,
  releaseHref,
  releaseLabel,
  sourceHref,
  sourceLabel,
  type ClassificationDateRange,
  type ClassificationWindow,
} from "./classifications-view";

const ORIGIN_LABELS: Record<ClassificationOrigin, string> = {
  ingest: "Ingest",
  manual: "Manual",
  eval: "Eval",
  all: "All",
};

class ClassificationsRequestError extends Error {
  readonly note: string | null;

  constructor(status: number, note: string | null) {
    super(`classifications ${status}`);
    this.name = "ClassificationsRequestError";
    this.note = note;
  }
}

async function readClassificationsResponse(res: Response): Promise<unknown> {
  if (res.ok) return res.json() as Promise<unknown>;
  const body = await res.json().catch(() => null);
  throw new ClassificationsRequestError(res.status, classificationFailureNote(body));
}

class ClassificationsTabBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ClassificationsTab]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-lg border border-stone-200 dark:border-stone-800 px-4 py-6 text-center">
          <p className="text-sm text-stone-500 dark:text-stone-400 mb-2">
            Classifications failed to render. The rest of Status is unaffected.
          </p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="text-xs text-stone-600 dark:text-stone-400 underline underline-offset-4"
          >
            Try again
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function formatCount(value: number): string {
  if (!Number.isFinite(value)) return EMPTY_MARK;
  return Math.round(value).toLocaleString("en-US");
}

function formatWhen(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return EMPTY_MARK;
  return formatStatusTimestamp(ts);
}

function dispositionClass(disposition: string): string {
  switch (disposition) {
    case "kept":
      return "text-emerald-600 dark:text-emerald-400";
    case "suppressed":
      return "text-amber-600 dark:text-amber-400";
    case "failed":
      return "text-rose-600 dark:text-rose-400";
    default:
      return "text-stone-500 dark:text-stone-400";
  }
}

function OriginControl({
  origin,
  onChange,
}: {
  origin: ClassificationOrigin;
  onChange: (origin: ClassificationOrigin) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-[11px] uppercase tracking-wide text-stone-400 dark:text-stone-500">
        Origin
      </span>
      <div className="flex gap-1">
        {CLASSIFICATION_ORIGIN_OPTIONS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={origin === value}
            onClick={() => onChange(value)}
            className={`px-2.5 py-1 text-xs rounded-full transition-colors ${
              origin === value
                ? "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900"
                : "bg-stone-100 dark:bg-stone-800 text-stone-500 dark:text-stone-400 hover:bg-stone-200 dark:hover:bg-stone-700"
            }`}
          >
            {ORIGIN_LABELS[value]}
          </button>
        ))}
      </div>
    </div>
  );
}

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
    <div className="rounded-lg border border-stone-200 dark:border-stone-800 px-3 py-2 bg-white dark:bg-stone-950/40">
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

function KpiStrip({ totals }: { totals: ClassificationSummary["totals"] }) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
      <Kpi label="Classified" value={formatCount(totals.classified)} />
      <Kpi
        label="Kept"
        value={formatCount(totals.kept)}
        className="text-emerald-600 dark:text-emerald-400"
      />
      <Kpi
        label="Suppressed"
        value={formatCount(totals.suppressed)}
        className="text-amber-600 dark:text-amber-400"
      />
      <Kpi
        label="Failed"
        value={formatCount(totals.failed)}
        className="text-rose-600 dark:text-rose-400"
      />
      <Kpi label="Suppression rate" value={formatSuppressionRate(totals.suppressionRate)} />
      <Kpi label="Cost" value={formatClassificationCost(totals.costUsd)} />
    </div>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return (
    <h3 className="text-xs font-sans font-semibold uppercase tracking-wider text-stone-400 dark:text-stone-500 mb-2">
      {children}
    </h3>
  );
}

function ModelsTable({ models }: { models: ClassificationSummary["models"] }) {
  return (
    <section>
      <SectionHeading>Models</SectionHeading>
      <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-hidden font-mono">
        <div className="grid grid-cols-[1fr_1.4fr_0.6fr_0.8fr] px-4 py-2 border-b border-stone-100 dark:border-stone-800 text-xs font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
          <div>Provider</div>
          <div>Model</div>
          <div>Count</div>
          <div>Cost</div>
        </div>
        {models.length === 0 ? (
          <div className="px-4 py-4 text-xs text-stone-400 dark:text-stone-500">{EMPTY_MARK}</div>
        ) : (
          models.map((row) => (
            <div
              key={`${row.provider}:${row.model}`}
              className="grid grid-cols-[1fr_1.4fr_0.6fr_0.8fr] px-4 py-2.5 text-xs border-b border-stone-100 dark:border-stone-800 items-center"
            >
              <div className="text-stone-700 dark:text-stone-300 truncate">{row.provider}</div>
              <div className="text-stone-500 truncate" title={row.model}>
                {row.model}
              </div>
              <div className="text-stone-500 tabular-nums">{formatCount(row.count)}</div>
              <div className="text-stone-500 tabular-nums">
                {formatClassificationCost(row.costUsd)}
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function SourceCell({ item }: { item: ClassificationRecentItem }) {
  const href = sourceHref(item);
  const label = sourceLabel(item);
  if (!href) return <span className="text-stone-500">{label}</span>;
  return (
    <Link href={href} className="text-stone-900 dark:text-stone-100 hover:underline">
      {label}
    </Link>
  );
}

function ReleaseCell({ item }: { item: ClassificationRecentItem }) {
  const href = releaseHref(item);
  const label = item.releaseTitle?.trim() || releaseLabel(item);
  if (!href) return <span className="text-stone-500">{releaseLabel(item)}</span>;
  return (
    <Link href={href} className="text-stone-900 dark:text-stone-100 hover:underline">
      {label}
    </Link>
  );
}

function RecentTable({ items }: { items: ClassificationRecentItem[] }) {
  return (
    <div className="border border-stone-200 dark:border-stone-800 rounded-lg overflow-x-auto">
      <table className="w-full min-w-[1080px] text-xs font-mono">
        <thead>
          <tr className="border-b border-stone-100 dark:border-stone-800 text-left text-[11px] font-sans font-medium uppercase tracking-wider text-stone-400 dark:text-stone-500">
            <th className="px-3 py-2 font-medium">When</th>
            <th className="px-3 py-2 font-medium">Source</th>
            <th className="px-3 py-2 font-medium">Release</th>
            <th className="px-3 py-2 font-medium">Origin</th>
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Choice</th>
            <th className="px-3 py-2 font-medium">Selected probability</th>
            <th className="px-3 py-2 font-medium">Provider confidence</th>
            <th className="px-3 py-2 font-medium">Disposition</th>
            <th className="px-3 py-2 font-medium">Reason</th>
          </tr>
        </thead>
        <tbody>
          {items.length === 0 ? (
            <tr>
              <td colSpan={10} className="px-3 py-4 text-stone-400 dark:text-stone-500">
                {EMPTY_MARK}
              </td>
            </tr>
          ) : (
            items.map((item, index) => {
              const reason = decisionReason(item);
              return (
                <tr
                  key={`${item.timestamp}:${item.releaseId ?? ""}:${item.sourceId ?? ""}:${index}`}
                  className="border-b border-stone-100 dark:border-stone-800 hover:bg-stone-50 dark:hover:bg-stone-800"
                >
                  <td className="px-3 py-2.5 text-stone-500 whitespace-nowrap">
                    {formatWhen(item.timestamp)}
                  </td>
                  <td className="px-3 py-2.5 max-w-[160px] truncate">
                    <SourceCell item={item} />
                  </td>
                  <td className="px-3 py-2.5 max-w-[200px] truncate">
                    <ReleaseCell item={item} />
                  </td>
                  <td className="px-3 py-2.5 text-stone-500">{item.origin || EMPTY_MARK}</td>
                  <td className="px-3 py-2.5 text-stone-500 max-w-[140px] truncate">
                    {item.model?.trim() || EMPTY_MARK}
                  </td>
                  <td className="px-3 py-2.5 text-stone-500">
                    {item.choice?.trim() || EMPTY_MARK}
                  </td>
                  <td className="px-3 py-2.5 text-stone-500 tabular-nums">
                    {formatProbability(item.selectedChoiceProbability)}
                  </td>
                  <td className="px-3 py-2.5 text-stone-500 tabular-nums">
                    {formatProbability(item.providerConfidence)}
                  </td>
                  <td className={`px-3 py-2.5 capitalize ${dispositionClass(item.disposition)}`}>
                    {item.disposition || EMPTY_MARK}
                  </td>
                  <td className="px-3 py-2.5 text-stone-500 max-w-[220px] truncate" title={reason}>
                    {reason}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>
    </div>
  );
}

function ClassificationsTabInner({
  after,
  dateRange,
}: {
  after: string | null;
  dateRange: ClassificationDateRange;
}) {
  const [origin, setOrigin] = useState<ClassificationOrigin>(DEFAULT_CLASSIFICATION_ORIGIN);
  const [summary, setSummary] = useState<ClassificationSummary | null>(null);
  const [items, setItems] = useState<ClassificationRecentItem[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(false);
  const [errorNote, setErrorNote] = useState<string | null>(null);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const generation = useRef(0);
  const loadMoreAbort = useRef<AbortController | null>(null);
  const rangeRef = useRef<ClassificationWindow | null>(null);

  const queryKey = `${dateRange}|${after ?? ""}|${origin}`;
  const [seenKey, setSeenKey] = useState(queryKey);
  if (seenKey !== queryKey) {
    setSeenKey(queryKey);
    setSummary(null);
    setItems([]);
    setNextCursor(null);
    setError(false);
    setErrorNote(null);
    setLoadMoreError(false);
    setLoading(true);
    setLoadingMore(false);
  }

  useEffect(() => {
    const gen = ++generation.current;
    const controller = new AbortController();
    loadMoreAbort.current?.abort();
    // One window for both requests, and for later pages of this same query.
    const range = classificationWindow({ dateRange, after });
    rangeRef.current = range;

    const summaryUrl = classificationSummaryUrl(range, origin);
    const recentUrl = classificationRecentUrl(range, origin);

    Promise.all([
      fetch(summaryUrl, { signal: controller.signal }).then((res) =>
        readClassificationsResponse(res),
      ),
      fetch(recentUrl, { signal: controller.signal }).then((res) =>
        readClassificationsResponse(res),
      ),
    ])
      .then(([summaryBody, recentBody]) => {
        if (gen !== generation.current) return;
        const nextSummary = readClassificationSummary(summaryBody);
        const nextRecent = readClassificationRecent(recentBody);
        if (!nextSummary || !nextRecent) throw new Error("unexpected classifications payload");
        setSummary(nextSummary);
        setItems(nextRecent.items);
        setNextCursor(nextRecent.nextCursor);
        setLoading(false);
      })
      .catch((err: unknown) => {
        if (gen !== generation.current || isAbort(err)) return;
        console.error("[ClassificationsTab]", err);
        setErrorNote(err instanceof ClassificationsRequestError ? err.note : null);
        setError(true);
        setLoading(false);
      });

    return () => {
      controller.abort();
      loadMoreAbort.current?.abort();
    };
  }, [dateRange, after, origin]);

  const loadMore = useCallback(() => {
    const range = rangeRef.current;
    if (!range || !nextCursor || loadingMore) return;
    const gen = generation.current;
    const controller = new AbortController();
    loadMoreAbort.current?.abort();
    loadMoreAbort.current = controller;
    setLoadingMore(true);
    setLoadMoreError(false);

    fetch(classificationRecentUrl(range, origin, { cursor: nextCursor }), {
      signal: controller.signal,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`recent ${res.status}`);
        return res.json() as Promise<unknown>;
      })
      .then((body) => {
        if (gen !== generation.current) return;
        const page = readClassificationRecent(body);
        if (!page) throw new Error("unexpected classifications page");
        setItems((prev) => [...prev, ...page.items]);
        setNextCursor(page.nextCursor);
        setLoadingMore(false);
      })
      .catch((err: unknown) => {
        if (gen !== generation.current || isAbort(err)) return;
        console.error("[ClassificationsTab]", err);
        setLoadMoreError(true);
        setLoadingMore(false);
      });
  }, [nextCursor, loadingMore, origin]);

  const state = classificationViewState({
    loading,
    error,
    classified: summary ? summary.totals.classified : null,
  });

  return (
    <div className="space-y-4">
      <p className="text-xs text-stone-500 dark:text-stone-400">
        Interest-alert match rate is on{" "}
        <Link href="/admin/semantic-alerts" className="underline underline-offset-4">
          Semantic alerts
        </Link>
        .
      </p>
      <OriginControl origin={origin} onChange={setOrigin} />
      {state === "loading" ? (
        <p className="text-xs text-stone-500">{CLASSIFICATIONS_LOADING_COPY}</p>
      ) : null}
      {state === "error" ? (
        <p className="text-xs text-red-500 py-4">
          {CLASSIFICATIONS_ERROR_COPY}
          {errorNote ? <span className="block mt-1">{errorNote}</span> : null}
        </p>
      ) : null}
      {state === "empty" ? (
        <div className="text-sm text-stone-400 dark:text-stone-500 py-8 text-center">
          {CLASSIFICATIONS_EMPTY_COPY}
        </div>
      ) : null}
      {state === "ready" && summary ? (
        <div className="space-y-4">
          <KpiStrip totals={summary.totals} />
          <DispositionChart series={summary.series} bucket={summary.bucket} />
          <ChoiceChart series={summary.choiceSeries} bucket={summary.bucket} />
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="min-w-0">
              <ProbabilityHistogram
                title="Selected probability"
                histogram={summary.probability.selected}
                threshold={summary.probability.threshold}
                showThreshold
              />
            </div>
            <div className="min-w-0">
              <ProbabilityHistogram
                title="Provider confidence"
                histogram={summary.probability.confidence}
                threshold={summary.probability.threshold}
              />
            </div>
          </div>
          <ModelsTable models={summary.models} />
          <section>
            <SectionHeading>Recent decisions</SectionHeading>
            <RecentTable items={items} />
            {nextCursor ? (
              <div className="mt-3">
                <button
                  type="button"
                  onClick={loadMore}
                  disabled={loadingMore}
                  className="px-2 py-1 text-xs rounded border border-stone-200 dark:border-stone-700 hover:bg-stone-50 dark:hover:bg-stone-800 disabled:opacity-30 disabled:cursor-default"
                >
                  {loadingMore ? "Loading…" : "Load more"}
                </button>
              </div>
            ) : null}
            {loadMoreError ? (
              <p className="mt-2 text-xs text-red-500">Couldn&apos;t load more decisions.</p>
            ) : null}
          </section>
        </div>
      ) : null}
    </div>
  );
}

export function ClassificationsTab(props: {
  after: string | null;
  dateRange: ClassificationDateRange;
}) {
  return (
    <ClassificationsTabBoundary>
      <ClassificationsTabInner {...props} />
    </ClassificationsTabBoundary>
  );
}
