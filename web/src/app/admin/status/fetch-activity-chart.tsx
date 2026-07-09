"use client";

/**
 * Admin Status fetch-activity chart.
 *
 * Custom SVG (same family as Sparkline / release-heatmap) — dual-axis overlay,
 * series toggles, facepile hover, click→drill. Fixed heights so selection never
 * reflows the page. Isolated behind a local error boundary so a chart failure
 * cannot take down the rest of Status.
 */
import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { OrgAvatar } from "@/components/org-avatar";
import {
  type FetchLogEntry,
  formatFetchDuration,
  FetchStatusBadge,
} from "@/components/fetch-log-shared";
import { useFetchLog } from "@/components/use-fetch-log";

// ── Types (admin-internal) ───────────────────────────────────────────────────

export interface ActivityTopOrg {
  slug: string;
  name: string;
  avatarUrl: string | null;
  githubHandle: string | null;
  count: number;
}

export interface ActivityBucket {
  t: string;
  success: number;
  error: number;
  no_change: number;
  dry_run: number;
  blocked: number;
  crawl_timeout: number;
  skipped: number;
  total: number;
  releasesInserted: number;
  topOrgs: ActivityTopOrg[];
  orgCount: number;
}

interface ActivityResponse {
  bucket: "hour" | "day";
  after: string;
  before: string;
  buckets: ActivityBucket[];
}

export interface SelectedWindow {
  after: string;
  before: string;
  label: string;
}

// ── Series ───────────────────────────────────────────────────────────────────

type SeriesKey = "success" | "error" | "degraded" | "dry_run" | "no_change";

const SERIES: {
  key: SeriesKey;
  label: string;
  color: string;
  defaultOn: boolean;
  value: (b: ActivityBucket) => number;
}[] = [
  { key: "success", label: "Success", color: "#22c55e", defaultOn: true, value: (b) => b.success },
  { key: "error", label: "Error", color: "#ef4444", defaultOn: true, value: (b) => b.error },
  {
    key: "degraded",
    label: "Degraded",
    color: "#f59e0b",
    defaultOn: true,
    value: (b) => b.blocked + b.crawl_timeout + b.skipped,
  },
  { key: "dry_run", label: "Dry run", color: "#3b82f6", defaultOn: true, value: (b) => b.dry_run },
  {
    key: "no_change",
    label: "No change",
    color: "#78716c",
    defaultOn: false,
    value: (b) => b.no_change,
  },
];

const STACK_ORDER: SeriesKey[] = ["no_change", "dry_run", "degraded", "error", "success"];
const CHART_HEIGHT = 200;
const DRILL_HEIGHT = 260;
const PAD = { t: 12, r: 40, b: 28, l: 36 };

const DEFAULT_ENABLED = Object.fromEntries(SERIES.map((s) => [s.key, s.defaultOn])) as Record<
  SeriesKey,
  boolean
>;

// ── Helpers ──────────────────────────────────────────────────────────────────

function niceMax(n: number): number {
  if (n <= 0) return 4;
  const p = 10 ** Math.floor(Math.log10(n));
  const m = n / p;
  return (m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10) * p;
}

function fmtCount(n: number): string {
  if (n >= 10_000) return `${Math.round(n / 1000)}k`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function bucketEnd(t: string, bucket: "hour" | "day"): string {
  return new Date(Date.parse(t) + (bucket === "day" ? 86_400_000 : 3_600_000)).toISOString();
}

function formatBucketLabel(t: string, bucket: "hour" | "day"): string {
  const d = new Date(t);
  if (bucket === "day") {
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return d.toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
}

function formatWindowLabel(after: string, before: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  return `${new Date(after).toLocaleString("en-US", opts)} – ${new Date(before).toLocaleTimeString(
    "en-US",
    { hour: "numeric", minute: "2-digit" },
  )}`;
}

function signalTotal(b: ActivityBucket, enabled: Record<SeriesKey, boolean>): number {
  return SERIES.reduce((sum, s) => sum + (enabled[s.key] ? s.value(b) : 0), 0);
}

function pickBucket(range: "today" | "week" | "month" | "all"): "hour" | "day" {
  return range === "month" || range === "all" ? "day" : "hour";
}

// ── Error boundary ───────────────────────────────────────────────────────────

class ChartErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[FetchActivityChart]", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="mb-4 rounded-lg border border-stone-200 dark:border-stone-800 px-4 py-6 text-center">
          <p className="text-sm text-stone-500 dark:text-stone-400 mb-2">
            Fetch activity chart failed to render.
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

// ── Public entry ─────────────────────────────────────────────────────────────

export function FetchActivityChart(props: {
  after: string | null;
  dateRange: "today" | "week" | "month" | "all";
  onOpenFetchLog?: (window: SelectedWindow) => void;
}) {
  return (
    <ChartErrorBoundary>
      <FetchActivityChartInner {...props} />
    </ChartErrorBoundary>
  );
}

// ── Chart body ───────────────────────────────────────────────────────────────

function FetchActivityChartInner({
  after,
  dateRange,
  onOpenFetchLog,
}: {
  after: string | null;
  dateRange: "today" | "week" | "month" | "all";
  onOpenFetchLog?: (window: SelectedWindow) => void;
}) {
  const [enabled, setEnabled] = useState(DEFAULT_ENABLED);
  const [showTotalLine, setShowTotalLine] = useState(true);
  const [data, setData] = useState<ActivityResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<SelectedWindow | null>(null);
  const [hover, setHover] = useState<{ index: number; x: number; y: number } | null>(null);

  const bucket = pickBucket(dateRange);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    setSelected(null);

    const qs = new URLSearchParams({ bucket });
    if (after) qs.set("after", after);

    fetch(`/api/proxy/status/fetch-activity?${qs}`, { signal: controller.signal })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return (await res.json()) as ActivityResponse;
      })
      .then((body) => {
        if (!controller.signal.aborted) {
          setData(body);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : String(e));
          setLoading(false);
        }
      });

    return () => controller.abort();
  }, [after, bucket]);

  const buckets = data?.buckets ?? [];
  const bucketKind = data?.bucket ?? bucket;

  const kpis = useMemo(() => {
    let signal = 0;
    let success = 0;
    let inserted = 0;
    let issues = 0;
    for (const b of buckets) {
      signal += signalTotal(b, enabled);
      if (enabled.success) success += b.success;
      inserted += b.releasesInserted;
      if (enabled.error) issues += b.error;
      if (enabled.degraded) issues += b.blocked + b.crawl_timeout + b.skipped;
    }
    return { signal, success, inserted, issues };
  }, [buckets, enabled]);

  const handleBarClick = useCallback(
    (index: number) => {
      const b = buckets[index];
      if (!b) return;
      const before = bucketEnd(b.t, bucketKind);
      const win: SelectedWindow = {
        after: b.t,
        before,
        label: formatWindowLabel(b.t, before),
      };
      setSelected((prev) => (prev?.after === win.after && prev.before === win.before ? null : win));
    },
    [buckets, bucketKind],
  );

  return (
    <div className="mb-4 rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950/40 overflow-hidden">
      <div className="flex items-start justify-between gap-4 px-4 pt-3 pb-2">
        <div className="min-w-0">
          <div className="text-sm font-medium text-stone-900 dark:text-stone-100">
            Fetch activity
          </div>
          <div className="text-xs text-stone-400 dark:text-stone-500 mt-0.5">
            {bucketKind === "hour" ? "Hourly" : "Daily"} · hover for orgs · click to inspect
          </div>
        </div>
        <div className="flex gap-3 shrink-0 text-right">
          <Kpi label="Signal" value={fmtCount(kpis.signal)} />
          <Kpi label="Success" value={fmtCount(kpis.success)} className="text-green-600" />
          <Kpi label="Inserted" value={fmtCount(kpis.inserted)} className="text-sky-500" />
          <Kpi label="Issues" value={fmtCount(kpis.issues)} className="text-red-500" />
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-1 px-4 pb-2">
        <span className="text-[11px] text-stone-400 dark:text-stone-500 mr-1">Show</span>
        {SERIES.map((s) => {
          const on = enabled[s.key];
          return (
            <button
              key={s.key}
              type="button"
              aria-pressed={on}
              onClick={() => setEnabled((prev) => ({ ...prev, [s.key]: !prev[s.key] }))}
              className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] ${
                on
                  ? "text-stone-700 dark:text-stone-200"
                  : "text-stone-400 dark:text-stone-500 opacity-50 line-through"
              }`}
            >
              <span className="w-2 h-2 rounded-[2px] shrink-0" style={{ background: s.color }} />
              {s.label}
            </button>
          );
        })}
        <span className="w-px h-3 bg-stone-200 dark:bg-stone-700 mx-1" aria-hidden />
        <button
          type="button"
          aria-pressed={showTotalLine}
          onClick={() => setShowTotalLine((v) => !v)}
          className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[11px] ${
            showTotalLine
              ? "text-stone-700 dark:text-stone-200"
              : "text-stone-400 dark:text-stone-500 opacity-50 line-through"
          }`}
        >
          <span className="w-3 h-0.5 rounded-full shrink-0 bg-sky-400" aria-hidden />
          Total fetches
        </button>
      </div>

      <div className="px-2 sm:px-3" style={{ height: CHART_HEIGHT }}>
        {loading && !data ? (
          <ChartMessage>Loading activity…</ChartMessage>
        ) : error && !data ? (
          <ChartMessage tone="error">Failed to load activity: {error}</ChartMessage>
        ) : buckets.length === 0 ? (
          <ChartMessage>No fetch activity in this range.</ChartMessage>
        ) : (
          <ActivitySvg
            buckets={buckets}
            bucketKind={bucketKind}
            enabled={enabled}
            showTotalLine={showTotalLine}
            selectedAfter={selected?.after ?? null}
            onHover={setHover}
            onClickBar={handleBarClick}
            height={CHART_HEIGHT}
          />
        )}
      </div>

      {hover && buckets[hover.index] && (
        <HoverCard
          bucket={buckets[hover.index]!}
          bucketKind={bucketKind}
          enabled={enabled}
          x={hover.x}
          y={hover.y}
        />
      )}

      <div
        className="border-t border-stone-100 dark:border-stone-800"
        style={{ height: DRILL_HEIGHT }}
      >
        {selected ? (
          <DrillPanel
            window={selected}
            onClear={() => setSelected(null)}
            onOpenFetchLog={onOpenFetchLog}
          />
        ) : (
          <ChartMessage>Click a bar to inspect sources that moved in that window.</ChartMessage>
        )}
      </div>
    </div>
  );
}

function ChartMessage({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div
      className={`h-full flex items-center justify-center text-xs px-4 text-center ${
        tone === "error" ? "text-red-500" : "text-stone-400 dark:text-stone-500"
      }`}
    >
      {children}
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
    <div className="min-w-[3rem]">
      <div
        className={`text-sm font-semibold tabular-nums tracking-tight text-stone-900 dark:text-stone-100 ${className}`}
      >
        {value}
      </div>
      <div className="text-[10px] uppercase tracking-wide text-stone-400 dark:text-stone-500">
        {label}
      </div>
    </div>
  );
}

// ── SVG ──────────────────────────────────────────────────────────────────────

function ActivitySvg({
  buckets,
  bucketKind,
  enabled,
  showTotalLine,
  selectedAfter,
  onHover,
  onClickBar,
  height,
}: {
  buckets: ActivityBucket[];
  bucketKind: "hour" | "day";
  enabled: Record<SeriesKey, boolean>;
  showTotalLine: boolean;
  selectedAfter: string | null;
  onHover: (h: { index: number; x: number; y: number } | null) => void;
  onClickBar: (index: number) => void;
  height: number;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setWidth(w);
    });
    ro.observe(el);
    setWidth(el.clientWidth || 640);
    return () => ro.disconnect();
  }, []);

  const plotW = Math.max(1, width - PAD.l - PAD.r);
  const plotH = height - PAD.t - PAD.b;
  const n = buckets.length;
  const stackMax = niceMax(Math.max(...buckets.map((b) => signalTotal(b, enabled)), 1));
  const totalMax = niceMax(Math.max(...buckets.map((b) => b.total), 1));
  const gap = Math.max(1, Math.min(3, plotW / n / 6));
  const barW = Math.max(2, plotW / n - gap);
  const selectedIndex = selectedAfter ? buckets.findIndex((b) => b.t === selectedAfter) : -1;
  const every = n > 48 ? 6 : n > 24 ? 3 : n > 14 ? 2 : 1;
  const colorOf = Object.fromEntries(SERIES.map((s) => [s.key, s.color])) as Record<
    SeriesKey,
    string
  >;

  const hitIndex = (clientX: number): number => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return -1;
    const x = clientX - rect.left;
    if (x < PAD.l || x > PAD.l + plotW) return -1;
    return Math.max(0, Math.min(n - 1, Math.floor(((x - PAD.l) / plotW) * n)));
  };

  return (
    <div ref={wrapRef} className="w-full h-full relative">
      <svg
        width={width}
        height={height}
        className="block cursor-pointer"
        role="img"
        aria-label="Fetch activity over time"
        onMouseMove={(e) => {
          const i = hitIndex(e.clientX);
          onHover(i < 0 ? null : { index: i, x: e.clientX, y: e.clientY });
        }}
        onMouseLeave={() => onHover(null)}
        onClick={(e) => {
          const i = hitIndex(e.clientX);
          if (i >= 0) onClickBar(i);
        }}
      >
        {Array.from({ length: 5 }, (_, i) => {
          const y = PAD.t + (plotH * i) / 4;
          const v = Math.round(stackMax * (1 - i / 4));
          return (
            <g key={i}>
              <line
                x1={PAD.l}
                y1={y}
                x2={PAD.l + plotW}
                y2={y}
                stroke="currentColor"
                className="text-stone-200 dark:text-stone-800"
                strokeWidth={1}
              />
              <text
                x={PAD.l - 8}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-stone-400 dark:fill-stone-500"
                fontSize={10}
              >
                {v}
              </text>
              {showTotalLine && (
                <text
                  x={PAD.l + plotW + 6}
                  y={y}
                  textAnchor="start"
                  dominantBaseline="middle"
                  className="fill-sky-400/80"
                  fontSize={10}
                >
                  {Math.round(totalMax * (1 - i / 4))}
                </text>
              )}
            </g>
          );
        })}

        {selectedIndex >= 0 && (
          <rect
            x={PAD.l + (selectedIndex * plotW) / n}
            y={PAD.t}
            width={plotW / n}
            height={plotH}
            className="fill-violet-500/10"
            style={{ stroke: "#a78bfa", strokeOpacity: 0.35 }}
          />
        )}

        {buckets.map((b, i) => {
          const x = PAD.l + (i * plotW) / n + gap / 2;
          let y = PAD.t + plotH;
          const dimmed = selectedIndex >= 0 && selectedIndex !== i;
          const segs: ReactNode[] = [];
          for (const key of STACK_ORDER) {
            if (!enabled[key]) continue;
            const series = SERIES.find((s) => s.key === key)!;
            const v = series.value(b);
            if (!v) continue;
            const h = (v / stackMax) * plotH;
            y -= h;
            segs.push(
              <rect
                key={key}
                x={x}
                y={y}
                width={barW}
                height={Math.max(h, 0.5)}
                fill={colorOf[key]}
                opacity={dimmed ? 0.35 : 1}
              />,
            );
          }
          return <g key={b.t}>{segs}</g>;
        })}

        {showTotalLine && n > 0 && (
          <polyline
            fill="none"
            stroke="#38bdf8"
            strokeWidth={1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            opacity={selectedIndex >= 0 ? 0.7 : 0.95}
            points={buckets
              .map((b, i) => {
                const x = PAD.l + ((i + 0.5) * plotW) / n;
                const y = PAD.t + plotH - (b.total / totalMax) * plotH;
                return `${x},${y}`;
              })
              .join(" ")}
          />
        )}

        {buckets.map((b, i) => {
          if (i % every !== 0 && i !== n - 1) return null;
          return (
            <text
              key={`x-${b.t}`}
              x={PAD.l + ((i + 0.5) * plotW) / n}
              y={PAD.t + plotH + 14}
              textAnchor="middle"
              fontSize={10}
              className={
                i === selectedIndex
                  ? "fill-violet-500 dark:fill-violet-400"
                  : "fill-stone-400 dark:fill-stone-500"
              }
            >
              {formatBucketLabel(b.t, bucketKind)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

// ── Hover ────────────────────────────────────────────────────────────────────

function HoverCard({
  bucket,
  bucketKind,
  enabled,
  x,
  y,
}: {
  bucket: ActivityBucket;
  bucketKind: "hour" | "day";
  enabled: Record<SeriesKey, boolean>;
  x: number;
  y: number;
}) {
  const end = bucketEnd(bucket.t, bucketKind);
  const rows = SERIES.filter((s) => enabled[s.key] && s.value(bucket) > 0);
  const extra = Math.max(0, bucket.orgCount - bucket.topOrgs.length);
  const style: CSSProperties = {
    position: "fixed",
    left: Math.min(x + 14, typeof window !== "undefined" ? window.innerWidth - 280 : x + 14),
    top: Math.min(y + 14, typeof window !== "undefined" ? window.innerHeight - 220 : y + 14),
    zIndex: 50,
    width: 260,
    pointerEvents: "none",
  };

  return (
    <div
      style={style}
      className="rounded-lg border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-950 shadow-lg px-3 py-2.5 text-[11px]"
      role="tooltip"
    >
      <div className="font-medium text-stone-900 dark:text-stone-100 text-xs">
        {formatWindowLabel(bucket.t, end)}
      </div>
      <div className="text-stone-400 dark:text-stone-500 mt-0.5 mb-2">
        {bucket.releasesInserted} inserted · {bucket.total} fetches · {bucket.orgCount} org
        {bucket.orgCount === 1 ? "" : "s"}
      </div>

      {bucket.topOrgs.length > 0 && (
        <>
          <div className="flex items-center gap-2 mb-2">
            <div className="flex -space-x-1.5">
              {bucket.topOrgs.map((o) => (
                <span
                  key={o.slug}
                  title={o.name}
                  className="rounded-full ring-2 ring-white dark:ring-stone-950"
                >
                  <OrgAvatar
                    avatarUrl={o.avatarUrl}
                    githubHandle={o.githubHandle}
                    name={o.name}
                    size={20}
                  />
                </span>
              ))}
            </div>
            {extra > 0 && (
              <span className="text-stone-400 dark:text-stone-500 font-mono tabular-nums">
                +{extra}
              </span>
            )}
          </div>
          <div className="text-stone-500 dark:text-stone-400 mb-2 leading-snug truncate">
            {bucket.topOrgs.map((o) => o.name).join(", ")}
            {extra > 0 ? ` +${extra} more` : ""}
          </div>
        </>
      )}

      <div className="space-y-0.5">
        {rows.map((s) => (
          <div key={s.key} className="flex justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-stone-500 dark:text-stone-400">
              <span className="w-2 h-2 rounded-[2px]" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="tabular-nums font-medium text-stone-800 dark:text-stone-200">
              {s.value(bucket)}
            </span>
          </div>
        ))}
        {rows.length === 0 && (
          <div className="text-stone-400 dark:text-stone-500">No visible series in this bar</div>
        )}
      </div>
      <div className="mt-2 pt-2 border-t border-stone-100 dark:border-stone-800 text-[10px] text-stone-400 dark:text-stone-500">
        Click to inspect sources
      </div>
    </div>
  );
}

// ── Drill ────────────────────────────────────────────────────────────────────

function DrillPanel({
  window,
  onClear,
  onOpenFetchLog,
}: {
  window: SelectedWindow;
  onClear: () => void;
  onOpenFetchLog?: (window: SelectedWindow) => void;
}) {
  const { entries, totalCount, loading, error, hasMore, loadMore } = useFetchLog({
    after: window.after,
    before: window.before,
    status: "all",
    excludeStatus: "no_change",
    pageSize: 30,
  });

  return (
    <div className="h-full flex flex-col">
      <div className="flex items-start justify-between gap-3 px-4 py-2.5 shrink-0">
        <div className="min-w-0">
          <div className="text-xs font-medium text-stone-900 dark:text-stone-100">
            Window activity
          </div>
          <div className="text-[11px] text-stone-400 dark:text-stone-500 truncate">
            {window.label}
            {!loading && totalCount > 0 && (
              <span className="ml-2 tabular-nums">
                · {totalCount} fetch{totalCount === 1 ? "" : "es"} (excl. no-change)
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0">
          {onOpenFetchLog && (
            <button
              type="button"
              onClick={() => onOpenFetchLog(window)}
              className="px-2 py-1 text-[11px] rounded-md bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 font-medium"
            >
              Open in Fetch Log
            </button>
          )}
          <button
            type="button"
            onClick={onClear}
            className="px-2 py-1 text-[11px] rounded-md text-stone-500 dark:text-stone-400 hover:bg-stone-100 dark:hover:bg-stone-800"
          >
            Clear
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-2 min-h-0">
        {loading && entries.length === 0 && <ChartMessage>Loading…</ChartMessage>}
        {error && entries.length === 0 && <ChartMessage tone="error">{error}</ChartMessage>}
        {!loading && !error && entries.length === 0 && (
          <ChartMessage>No signal fetches in this window.</ChartMessage>
        )}
        <ul className="divide-y divide-stone-100 dark:divide-stone-800">
          {entries.map((e) => (
            <DrillRow key={e.id} entry={e} />
          ))}
        </ul>
        {hasMore && (
          <button
            type="button"
            onClick={loadMore}
            disabled={loading}
            className="w-full mt-1 py-1.5 text-[11px] text-stone-500 dark:text-stone-400"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </div>
  );
}

function DrillRow({ entry }: { entry: FetchLogEntry }) {
  const title = entry.orgName
    ? `${entry.orgName}${entry.sourceName ? ` · ${entry.sourceName}` : ""}`
    : (entry.sourceName ?? entry.sourceSlug ?? entry.sourceId);

  return (
    <li className="flex items-center gap-2.5 px-2 py-1.5 text-xs">
      <OrgAvatar
        avatarUrl={null}
        githubHandle={null}
        name={entry.orgName ?? entry.sourceName ?? "?"}
        size={22}
      />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-stone-800 dark:text-stone-200">{title}</div>
        <div className="text-[11px] text-stone-400 dark:text-stone-500 truncate">
          {entry.sourceSlug ?? entry.sourceId}
          {entry.durationMs != null && ` · ${formatFetchDuration(entry.durationMs)}`}
        </div>
      </div>
      <div className="shrink-0 text-right">
        {entry.status === "success" && entry.releasesInserted > 0 ? (
          <span className="text-green-600 font-medium tabular-nums">+{entry.releasesInserted}</span>
        ) : (
          <FetchStatusBadge status={entry.status} />
        )}
      </div>
    </li>
  );
}
