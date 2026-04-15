"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { type WeeklyBucket, getProductColor, DAY_MS, WEEK_MS, fmtWeek } from "@/lib/cadence";
import { HoverCard } from "@/components/hover-card";

/* ================================================================
   AI Model launch milestones
   ================================================================ */

interface ModelMilestone {
  name: string;
  date: Date;
  vendor: "claude" | "openai";
}

const MODEL_MILESTONES: ModelMilestone[] = [
  // Claude
  { name: "Claude 3 Opus", date: new Date("2024-03-04"), vendor: "claude" },
  { name: "Claude 3.5 Sonnet", date: new Date("2024-06-20"), vendor: "claude" },
  { name: "Claude 3.5 Sonnet v2", date: new Date("2024-10-22"), vendor: "claude" },
  { name: "Claude 3.5 Haiku", date: new Date("2024-11-04"), vendor: "claude" },
  { name: "Claude 3.7 Sonnet", date: new Date("2025-02-24"), vendor: "claude" },
  { name: "Claude 4 Sonnet & Opus", date: new Date("2025-05-22"), vendor: "claude" },
  { name: "Claude 4.5 Sonnet", date: new Date("2025-09-29"), vendor: "claude" },
  { name: "Claude 4.5 Haiku", date: new Date("2025-10-01"), vendor: "claude" },
  { name: "Claude 4.5 Opus", date: new Date("2025-11-24"), vendor: "claude" },
  { name: "Claude 4.6 Opus", date: new Date("2026-02-05"), vendor: "claude" },
  { name: "Claude 4.6 Sonnet", date: new Date("2026-02-17"), vendor: "claude" },
  // OpenAI
  { name: "GPT-4o", date: new Date("2024-05-13"), vendor: "openai" },
  { name: "GPT-4o mini", date: new Date("2024-07-18"), vendor: "openai" },
  { name: "o1-preview", date: new Date("2024-09-12"), vendor: "openai" },
  { name: "o1", date: new Date("2024-12-05"), vendor: "openai" },
  { name: "o3-mini", date: new Date("2025-01-31"), vendor: "openai" },
  { name: "GPT-4.1", date: new Date("2025-04-14"), vendor: "openai" },
  { name: "o3 & o4-mini", date: new Date("2025-04-16"), vendor: "openai" },
  { name: "o3-pro", date: new Date("2025-06-10"), vendor: "openai" },
  { name: "GPT-5", date: new Date("2025-08-07"), vendor: "openai" },
  { name: "GPT-5-Codex", date: new Date("2025-09-23"), vendor: "openai" },
  { name: "GPT-5.3-Codex", date: new Date("2026-02-01"), vendor: "openai" },
  { name: "GPT-5.4", date: new Date("2026-03-05"), vendor: "openai" },
];

const VENDOR_COLORS = {
  claude: { line: "rgba(217, 119, 56, 0.35)", text: "text-amber-600/60 dark:text-amber-500/50" },
  openai: { line: "rgba(16, 163, 127, 0.35)", text: "text-emerald-600/60 dark:text-emerald-500/50" },
} as const;

type PositionedMilestone = ModelMilestone & { pct: number };

function milestonesInRange(from: Date, to: Date): PositionedMilestone[] {
  const span = to.getTime() - from.getTime();
  if (span <= 0) return [];
  return MODEL_MILESTONES
    .filter((m) => m.date >= from && m.date <= to)
    .map((m) => ({ ...m, pct: ((m.date.getTime() - from.getTime()) / span) * 100 }));
}

const ANNOTATIONS_STORAGE_KEY = "released:show-model-annotations";

function useModelAnnotations() {
  const [show, setShow] = useState(() => {
    if (typeof window === "undefined") return false;
    try { return localStorage.getItem(ANNOTATIONS_STORAGE_KEY) === "1"; } catch { return false; }
  });

  const toggle = useCallback(() => {
    setShow((prev) => {
      const next = !prev;
      try { localStorage.setItem(ANNOTATIONS_STORAGE_KEY, next ? "1" : "0"); } catch {}
      return next;
    });
  }, []);

  return [show, toggle] as const;
}

/* ================================================================
   Shared context — holds the brush state for all subcomponents.
   ================================================================ */

export interface SourceBucketEntry {
  name: string;
  slug: string;
  colorIndex: number;
  buckets: WeeklyBucket[];
}

interface RangeNavigatorCtx {
  /** Normalised 0–1 brush start */
  brushStart: number;
  /** Normalised 0–1 brush end */
  brushEnd: number;
  setBrush: (start: number, end: number) => void;
  min: Date;
  max: Date;
  buckets: WeeklyBucket[];
  /** Per-source bucket data for stacked view — only when multiple sources */
  sourceBuckets: SourceBucketEntry[] | null;
  /** Per-product bucket data for product-grouped stacked view */
  productBuckets: SourceBucketEntry[] | null;
  /** Earliest bucket with data — derived from buckets */
  earliestRelease: Date | null;
  /** Whether to show AI model launch annotations */
  showAnnotations: boolean;
  toggleAnnotations: () => void;
}

const Ctx = createContext<RangeNavigatorCtx | null>(null);

function useNav() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("RangeNavigator subcomponents must be used inside RangeNavigator.Root");
  return ctx;
}

/* ================================================================
   Helpers
   ================================================================ */

const MIN_BRUSH = 0.03;

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function toDate(ctx: { min: Date; max: Date }, pct: number): Date {
  const totalMs = ctx.max.getTime() - ctx.min.getTime();
  return new Date(ctx.min.getTime() + pct * totalMs);
}

function fmtDate(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function fmtMonth(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit", timeZone: "UTC" });
}

function pillCls(active: boolean) {
  return [
    "px-2 py-0.5 rounded text-[10px] transition-colors",
    "focus-visible:outline-2 focus-visible:outline-blue-500 focus-visible:outline-offset-1",
    active
      ? "bg-blue-50 dark:bg-blue-950 border border-blue-300 dark:border-blue-700 text-blue-600 dark:text-blue-400"
      : "bg-stone-50 dark:bg-stone-800 border border-stone-200 dark:border-stone-700 text-stone-500 dark:text-stone-400 hover:border-blue-400 hover:text-blue-500 hover:bg-blue-50 dark:hover:bg-blue-950",
  ].join(" ");
}

/* ================================================================
   Root
   ================================================================ */

interface RootProps {
  min: Date;
  max: Date;
  buckets: WeeklyBucket[];
  sourceBuckets?: SourceBucketEntry[] | null;
  productBuckets?: SourceBucketEntry[] | null;
  value?: [Date, Date];
  defaultValue?: [Date, Date];
  onValueChange?: (range: [Date, Date]) => void;
  children: ReactNode;
  className?: string;
}

function Root({
  min,
  max,
  buckets,
  sourceBuckets,
  productBuckets,
  value,
  defaultValue,
  onValueChange,
  children,
  className,
}: RootProps) {
  const totalMs = max.getTime() - min.getTime();

  // Derive earliest release from the first bucket with count > 0
  const earliestRelease = useMemo(() => {
    const first = buckets.find((b) => b.count > 0);
    return first ? first.weekStart : null;
  }, [buckets]);

  const toNorm = useCallback(
    (d: Date) => (totalMs > 0 ? (d.getTime() - min.getTime()) / totalMs : 0),
    [min, totalMs],
  );

  const [showAnnotations, toggleAnnotations] = useModelAnnotations();

  const controlled = value !== undefined;
  const [internal, setInternal] = useState<[number, number]>(() => {
    if (defaultValue) return [toNorm(defaultValue[0]), toNorm(defaultValue[1])];
    return [0, 1];
  });

  const brushStart = controlled ? toNorm(value[0]) : internal[0];
  const brushEnd = controlled ? toNorm(value[1]) : internal[1];

  const setBrush = useCallback(
    (start: number, end: number) => {
      const s = clamp(start, 0, 1);
      const e = clamp(end, 0, 1);
      if (!controlled) setInternal([s, e]);
      onValueChange?.([toDate({ min, max }, s), toDate({ min, max }, e)]);
    },
    [controlled, min, max, onValueChange],
  );

  return (
    <Ctx.Provider value={{ brushStart, brushEnd, setBrush, min, max, buckets, sourceBuckets: (sourceBuckets && sourceBuckets.length > 1) ? sourceBuckets : null, productBuckets: productBuckets ?? null, earliestRelease, showAnnotations, toggleAnnotations }}>
      <div
        data-slot="range-navigator"
        className={`bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-5 py-4 mb-5 ${className ?? ""}`}
        role="region"
        aria-label="Release timeline range selector"
      >
        {children}
      </div>
    </Ctx.Provider>
  );
}

/* ================================================================
   Header
   ================================================================ */

function Header({ title = "Releases over time" }: { title?: string }) {
  const { brushStart, brushEnd, min, max, showAnnotations, toggleAnnotations } = useNav();
  const startDate = toDate({ min, max }, brushStart);
  const endDate = toDate({ min, max }, brushEnd);

  return (
    <div data-slot="range-navigator-header" className="flex justify-between items-center mb-3">
      <div className="flex items-center gap-2">
        <div data-slot="range-navigator-title" className="text-[13px] font-semibold text-stone-900 dark:text-stone-100">
          {title}
        </div>
        <button
          type="button"
          onClick={toggleAnnotations}
          title={showAnnotations ? "Hide AI model launches" : "Show AI model launches"}
          className={`cursor-pointer flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] transition-colors ${
            showAnnotations
              ? "bg-stone-100 dark:bg-stone-800 text-stone-600 dark:text-stone-300 border border-stone-300 dark:border-stone-600"
              : "text-stone-400 dark:text-stone-600 hover:text-stone-500 dark:hover:text-stone-400 border border-transparent hover:border-stone-200 dark:hover:border-stone-700"
          }`}
        >
          <svg className="w-3 h-3" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            <path d="M8 2v12M4 6v6M12 4v8" />
          </svg>
          <span>AI models</span>
        </button>
      </div>
      <div
        data-slot="range-navigator-dates"
        className="text-xs text-stone-400 dark:text-stone-500 font-mono"
        aria-live="polite"
      >
        {fmtDate(startDate)} → {fmtDate(endDate)}
      </div>
    </div>
  );
}

/* ================================================================
   DetailChart — the main chart showing only the brushed window
   ================================================================ */

const DETAIL_HEIGHT = 120;

type StackMode = "all" | "source" | "product";

function DetailChart() {
  const { buckets, sourceBuckets, productBuckets, brushStart, brushEnd, min, max, earliestRelease, showAnnotations } = useNav();
  const [stackMode, setStackModeRaw] = useState<StackMode>("all");
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set());

  const setStackMode = useCallback((mode: StackMode) => {
    setStackModeRaw(mode);
    setHiddenSources(new Set());
  }, []);

  const showToggle = sourceBuckets !== null && sourceBuckets.length > 1;
  const showProductToggle = productBuckets !== null && productBuckets.length > 0;
  const activeStackBuckets = stackMode === "product" ? productBuckets : sourceBuckets;

  // Build a complete week grid for the brushed window using aggregate data
  const brushedBuckets = useMemo(() => {
    const bucketMap = new Map<number, number>();
    for (const b of buckets) {
      bucketMap.set(b.weekStart.getTime(), b.count);
    }

    const totalMs = max.getTime() - min.getTime();
    const brushStartDate = new Date(min.getTime() + brushStart * totalMs);
    const brushEndDate = new Date(min.getTime() + brushEnd * totalMs);

    const inRange = buckets.filter((b) => {
      const bEndMs = b.weekStart.getTime() + WEEK_MS;
      return bEndMs > brushStartDate.getTime() && b.weekStart.getTime() < brushEndDate.getTime();
    });
    if (inRange.length === 0) return [];

    const gridStart = inRange[0].weekStart.getTime();
    const gridEnd = inRange[inRange.length - 1].weekStart.getTime() + WEEK_MS;

    const complete: WeeklyBucket[] = [];
    for (let ts = gridStart; ts < gridEnd; ts += WEEK_MS) {
      complete.push({
        weekStart: new Date(ts),
        count: bucketMap.get(ts) ?? 0,
      });
    }
    return complete;
  }, [buckets, brushStart, brushEnd, min, max]);

  // Per-source (or per-product) breakdown for each brushed week
  const stackedData = useMemo(() => {
    if (!activeStackBuckets) return null;
    const sourceMaps = activeStackBuckets.map((src) => {
      const map = new Map<number, number>();
      for (const b of src.buckets) {
        map.set(b.weekStart.getTime(), b.count);
      }
      return { ...src, map };
    });

    return brushedBuckets.map((bucket) => {
      const ts = bucket.weekStart.getTime();
      const segments = sourceMaps
        .map((src) => ({
          name: src.name,
          slug: src.slug,
          colorIndex: src.colorIndex,
          count: src.map.get(ts) ?? 0,
        }))
        .filter((s) => s.count > 0 && !hiddenSources.has(s.slug));
      const visibleTotal = segments.reduce((sum, s) => sum + s.count, 0);
      return { weekStart: bucket.weekStart, total: visibleTotal, segments };
    });
  }, [activeStackBuckets, brushedBuckets, hiddenSources]);

  const maxCount = Math.max(...brushedBuckets.map((b) => b.count), 1);

  const visibleMilestones = useMemo(() => {
    if (!showAnnotations || brushedBuckets.length === 0) return [];
    const first = brushedBuckets[0].weekStart;
    const last = new Date(brushedBuckets[brushedBuckets.length - 1].weekStart.getTime() + WEEK_MS);
    return milestonesInRange(first, last);
  }, [showAnnotations, brushedBuckets]);

  // Y-axis ticks — up to 4 ticks spaced nicely
  const yTicks = useMemo(() => {
    if (maxCount <= 1) return [1];
    const steps = [1, 2, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000];
    const ideal = maxCount / 3;
    const step = steps.find((s) => s >= ideal) ?? Math.ceil(ideal);
    const ticks: number[] = [];
    for (let v = step; v <= maxCount; v += step) ticks.push(v);
    if (ticks.length === 0) ticks.push(maxCount);
    return ticks;
  }, [maxCount]);

  // Month labels for the brushed window. Thin to ≤ TARGET_TICKS using natural
  // strides (1/2/3/6/12 mo). Strides ≥ 12 anchor on January so year boundaries stay visible.
  const monthLabels = useMemo(() => {
    if (brushedBuckets.length === 0) return [];
    const first = brushedBuckets[0].weekStart;
    const last = brushedBuckets[brushedBuckets.length - 1].weekStart;
    const span = last.getTime() - first.getTime();
    if (span <= 0) return [];

    const monthsInSpan =
      (last.getFullYear() - first.getFullYear()) * 12 +
      (last.getMonth() - first.getMonth()) + 1;

    const TARGET_TICKS = 10;
    const stride = [1, 2, 3, 6, 12].find((s) => Math.ceil(monthsInSpan / s) <= TARGET_TICKS) ?? 12;

    const labels: { label: string; pct: number }[] = [];
    const mo = new Date(first);
    mo.setDate(1);
    if (mo < first) mo.setMonth(mo.getMonth() + 1);
    while (mo <= last) {
      const m = mo.getMonth();
      const keep = stride === 1 || (stride >= 12 ? m === 0 : m % stride === 0);
      if (keep) {
        labels.push({
          label: stride >= 6
            ? `${mo.getFullYear()}`
            : stride >= 3
              ? `${fmtMonth(mo)} ${String(mo.getFullYear()).slice(2)}`
              : fmtMonth(mo),
          pct: ((mo.getTime() - first.getTime()) / span) * 100,
        });
      }
      mo.setMonth(mo.getMonth() + 1);
    }
    return labels;
  }, [brushedBuckets]);

  if (brushedBuckets.length === 0) {
    const totalMs = max.getTime() - min.getTime();
    const brushStartDate = new Date(min.getTime() + brushStart * totalMs);
    const isBeforeEarliest = earliestRelease && brushStartDate < earliestRelease;

    return (
      <div
        data-slot="detail-chart"
        className="flex flex-col items-center justify-center text-stone-400 text-xs gap-1"
        style={{ height: DETAIL_HEIGHT }}
      >
        <span className="text-stone-500 dark:text-stone-400 font-medium">No data in this range</span>
        {isBeforeEarliest && (
          <span className="text-stone-400 dark:text-stone-500">
            Earliest tracked release: {fmtDate(earliestRelease)}
          </span>
        )}
      </div>
    );
  }

  const isStacked = stackMode !== "all" && stackedData !== null;

  return (
    <div data-slot="detail-chart" className="mb-3">
      {showToggle && (
        <div className="flex justify-end mb-3">
          <div className="flex gap-0">
            <button
              type="button"
              onClick={() => setStackMode("all")}
              className={`cursor-pointer rounded-r-none ${pillCls(stackMode === "all")}`}
            >
              All
            </button>
            {showProductToggle && (
              <button
                type="button"
                onClick={() => setStackMode("product")}
                className={`cursor-pointer rounded-none border-l-0 ${pillCls(stackMode === "product")}`}
              >
                By product
              </button>
            )}
            <button
              type="button"
              onClick={() => setStackMode("source")}
              className={`cursor-pointer rounded-l-none border-l-0 ${pillCls(stackMode === "source")}`}
            >
              By source
            </button>
          </div>
        </div>
      )}

      <div className="flex" style={{ height: DETAIL_HEIGHT }}>
        {/* Y-axis */}
        <div className="relative w-7 shrink-0 mr-1" aria-hidden="true">
          {yTicks.map((v) => (
            <span
              key={v}
              className="absolute right-0 text-[10px] text-stone-500 leading-none"
              style={{ bottom: `${(v / maxCount) * 100}%`, transform: "translateY(50%)" }}
            >
              {v}
            </span>
          ))}
        </div>

        {/* Bars + annotation overlay */}
        <div className="relative flex-1 min-w-0">
          {/* AI model milestone markers */}
          {visibleMilestones.length > 0 && (
            <div className="absolute inset-0 pointer-events-none z-10" aria-hidden="true">
              {visibleMilestones.map((m) => (
                <div
                  key={`${m.vendor}-${m.name}`}
                  className="absolute top-0 bottom-0"
                  style={{ left: `${m.pct}%` }}
                >
                  <div
                    className="absolute top-0 bottom-0 w-px"
                    style={{ backgroundColor: VENDOR_COLORS[m.vendor].line }}
                  />
                  <span
                    className={`absolute top-0 text-[8px] font-medium leading-none whitespace-nowrap ${VENDOR_COLORS[m.vendor].text}`}
                    style={{
                      transform: "rotate(-90deg) translateX(-100%)",
                      transformOrigin: "top left",
                      left: "3px",
                      top: "2px",
                    }}
                  >
                    {m.name}
                  </span>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-end gap-px h-full">
          {brushedBuckets.map((bucket, i) => {
            const visibleCount = isStacked ? stackedData[i].total : bucket.count;
            const h = visibleCount > 0 ? Math.max(2, (visibleCount / maxCount) * DETAIL_HEIGHT) : 0;
            const weekEnd = new Date(bucket.weekStart.getTime() + 6 * DAY_MS);
            const weekSegments = isStacked ? stackedData[i].segments : null;

            return (
              <HoverCard.Root key={i}>
                <HoverCard.Trigger
                  data-slot="detail-bar"
                  data-state={visibleCount === 0 ? "empty" : "filled"}
                  className={`flex-1 rounded-t-sm transition-colors duration-75 ${
                    isStacked
                      ? "data-[state=empty]:bg-stone-100 dark:data-[state=empty]:bg-stone-800"
                      : "data-[state=filled]:bg-blue-500 data-[state=filled]:hover:bg-blue-600 data-[state=empty]:bg-stone-100 dark:data-[state=empty]:bg-stone-800"
                  }`}
                  style={{
                    height: `${h}px`,
                    alignSelf: "flex-end",
                    ...(isStacked && visibleCount > 0
                      ? { display: "flex", flexDirection: "column-reverse" as const, overflow: "hidden" }
                      : {}),
                  }}
                >
                  {isStacked && weekSegments && visibleCount > 0 && (
                    <>
                      {weekSegments.map((seg, si) => (
                        <div
                          key={si}
                          style={{
                            height: `${(seg.count / visibleCount) * 100}%`,
                            backgroundColor: getProductColor(seg.colorIndex),
                            minHeight: 1,
                          }}
                        />
                      ))}
                    </>
                  )}
                </HoverCard.Trigger>
                {bucket.count > 0 && (
                  <HoverCard.Content className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-lg px-3 py-2 min-w-[140px]">
                    <div className="text-[11px] font-medium text-stone-500 dark:text-stone-400 mb-1">
                      {fmtWeek(bucket.weekStart)} – {fmtWeek(weekEnd)}
                    </div>
                    <div className="text-sm font-semibold text-stone-900 dark:text-stone-100">
                      {bucket.count} {bucket.count === 1 ? "release" : "releases"}
                    </div>
                    {isStacked && weekSegments && weekSegments.length > 0 && (
                      <div className="mt-1.5 pt-1.5 border-t border-stone-100 dark:border-stone-800 space-y-0.5">
                        {weekSegments.map((seg, si) => (
                          <div key={si} className="flex items-center gap-1.5 text-[11px] text-stone-600 dark:text-stone-400">
                            <span
                              className="inline-block w-2 h-2 rounded-sm shrink-0"
                              style={{ backgroundColor: getProductColor(seg.colorIndex) }}
                            />
                            <span className="truncate">{seg.name}</span>
                            <span className="ml-auto font-medium tabular-nums">{seg.count}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </HoverCard.Content>
                )}
              </HoverCard.Root>
            );
          })}
          </div>
        </div>
      </div>

      {/* Month labels under the detail chart */}
      {monthLabels.length > 0 && (
        <div className="relative h-4 ml-8" aria-hidden="true">
          {monthLabels.map((l, i) => (
            <span
              key={i}
              className="absolute text-[10px] text-stone-500 font-medium"
              style={{ left: `${l.pct}%` }}
            >
              {l.label}
            </span>
          ))}
        </div>
      )}

      {/* Legend for stacked mode */}
      {isStacked && activeStackBuckets && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 ml-8">
          {activeStackBuckets.map((src) => {
            const isHidden = hiddenSources.has(src.slug);
            return (
              <button
                key={src.slug}
                type="button"
                onClick={() => {
                  setHiddenSources((prev) => {
                    const next = new Set(prev);
                    if (next.has(src.slug)) next.delete(src.slug);
                    else next.add(src.slug);
                    return next;
                  });
                }}
                className={`flex items-center gap-1 cursor-pointer ${isHidden ? "opacity-40" : ""}`}
              >
                <span
                  className="w-2.5 h-2.5 rounded-full shrink-0"
                  style={{ backgroundColor: getProductColor(src.colorIndex) }}
                />
                <span className={`text-[11px] text-stone-600 dark:text-stone-400 ${isHidden ? "line-through" : ""}`}>
                  {src.name}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Overview — the mini sparkline scrubber with brush and year labels
   ================================================================ */

const OVERVIEW_HEIGHT = 32;

function Overview() {
  const { buckets, brushStart, brushEnd, setBrush, min, max, earliestRelease, showAnnotations } = useNav();
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: "left" | "right" | "move";
    startX: number;
    startBS: number;
    startBE: number;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const brushRef = useRef({ brushStart, brushEnd });
  brushRef.current = { brushStart, brushEnd };

  // Fill the full min→max range with weekly buckets so bars align with date-based markers
  const completeBuckets = useMemo(() => {
    const bucketMap = new Map<number, number>();
    for (const b of buckets) {
      bucketMap.set(b.weekStart.getTime(), b.count);
    }
    const result: WeeklyBucket[] = [];
    // Align to the same Monday-start grid the API uses
    const firstWeek = buckets.length > 0 ? buckets[0].weekStart.getTime() : min.getTime();
    const overshoot = firstWeek - min.getTime();
    const gridStart = overshoot <= 0 ? firstWeek : firstWeek - Math.ceil(overshoot / WEEK_MS) * WEEK_MS;
    for (let ts = gridStart; ts < max.getTime(); ts += WEEK_MS) {
      result.push({ weekStart: new Date(ts), count: bucketMap.get(ts) ?? 0 });
    }
    return result;
  }, [buckets, min, max]);

  const maxCount = Math.max(...completeBuckets.map((b) => b.count), 1);
  const bucketCount = completeBuckets.length;
  const gridStartMs = bucketCount > 0 ? completeBuckets[0].weekStart.getTime() : 0;

  const dateToBucketPct = useCallback((d: Date): number => {
    if (bucketCount === 0) return 0;
    const idx = (d.getTime() - gridStartMs) / WEEK_MS;
    return (idx / bucketCount) * 100;
  }, [gridStartMs, bucketCount]);

  const overviewMilestones = useMemo(
    () => (showAnnotations ? milestonesInRange(min, max) : []),
    [showAnnotations, min, max],
  );

  // Year boundary labels — aligned to the bucket grid
  const yearLabels = useMemo(() => {
    if (bucketCount === 0) return [];
    const labels: { year: number; pct: number }[] = [];
    const startYear = min.getFullYear();
    const endYear = max.getFullYear();
    for (let y = startYear + 1; y <= endYear; y++) {
      const jan1 = new Date(y, 0, 1);
      if (jan1 > min && jan1 < max) {
        labels.push({ year: y, pct: dateToBucketPct(jan1) });
      }
    }
    return labels;
  }, [min, max, bucketCount, dateToBucketPct]);

  /* --- Pointer drag --- */

  const onPointerDown = useCallback(
    (e: React.PointerEvent, mode: "left" | "right" | "move") => {
      e.preventDefault();
      e.stopPropagation();
      const { brushStart: bs, brushEnd: be } = brushRef.current;
      dragRef.current = { mode, startX: e.clientX, startBS: bs, startBE: be };
      setIsDragging(true);
      (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    },
    [],
  );

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || !trackRef.current) return;
      const { brushStart: bs, brushEnd: be } = brushRef.current;
      const tw = trackRef.current.getBoundingClientRect().width;
      const dx = (e.clientX - drag.startX) / tw;

      let s = bs;
      let en = be;
      if (drag.mode === "left") {
        s = clamp(drag.startBS + dx, 0, be - MIN_BRUSH);
      } else if (drag.mode === "right") {
        en = clamp(drag.startBE + dx, bs + MIN_BRUSH, 1);
      } else {
        const bw = drag.startBE - drag.startBS;
        const ns = clamp(drag.startBS + dx, 0, 1 - bw);
        s = ns;
        en = ns + bw;
      }
      setBrush(s, en);
    };

    const onUp = () => {
      dragRef.current = null;
      setIsDragging(false);
    };

    document.addEventListener("pointermove", onMove);
    document.addEventListener("pointerup", onUp);
    return () => {
      document.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerup", onUp);
    };
  }, [setBrush]);

  /* --- Track click (re-center) --- */

  const onTrackClick = useCallback(
    (e: React.MouseEvent) => {
      if (dragRef.current) return;
      if ((e.target as HTMLElement).closest('[data-slot="brush-selection"]')) return;
      const track = trackRef.current;
      if (!track) return;
      const { brushStart: bs, brushEnd: be } = brushRef.current;
      const rect = track.getBoundingClientRect();
      const pct = (e.clientX - rect.left) / rect.width;
      const bw = be - bs;
      const ns = clamp(pct - bw / 2, 0, 1 - bw);
      setBrush(ns, ns + bw);
    },
    [setBrush],
  );

  /* --- Keyboard --- */

  const onHandleKeyDown = useCallback(
    (e: React.KeyboardEvent, which: "left" | "right") => {
      const step = e.shiftKey ? 0.1 : 0.02;
      const { brushStart: bs, brushEnd: be } = brushRef.current;
      let s = bs;
      let en = be;
      let handled = true;

      switch (e.key) {
        case "ArrowLeft":
        case "ArrowDown":
          if (which === "left") s = clamp(s - step, 0, en - MIN_BRUSH);
          else en = clamp(en - step, s + MIN_BRUSH, 1);
          break;
        case "ArrowRight":
        case "ArrowUp":
          if (which === "left") s = clamp(s + step, 0, en - MIN_BRUSH);
          else en = clamp(en + step, s + MIN_BRUSH, 1);
          break;
        case "Home":
          if (which === "left") s = 0;
          else en = s + MIN_BRUSH;
          break;
        case "End":
          if (which === "left") s = en - MIN_BRUSH;
          else en = 1;
          break;
        default:
          handled = false;
      }

      if (handled) {
        e.preventDefault();
        setBrush(s, en);
      }
    },
    [setBrush],
  );

  const startDate = toDate({ min, max }, brushStart);
  const endDate = toDate({ min, max }, brushEnd);

  return (
    <div data-slot="overview" className="mb-2">
      {/* Mini sparkline with brush */}
      <div className="relative">
      <div
        ref={trackRef}
        data-slot="overview-track"
        className="relative bg-stone-50 dark:bg-stone-800 rounded cursor-pointer select-none border border-stone-100 dark:border-stone-700"
        style={{ height: OVERVIEW_HEIGHT + 16 }}
        onClick={onTrackClick}
      >
        {/* Mini bars */}
        <div className="absolute inset-x-0 bottom-2 top-2 flex items-end gap-px px-px" aria-hidden="true">
          {completeBuckets.map((bucket, i) => {
            const h = bucket.count > 0 ? Math.max(1, (bucket.count / maxCount) * (OVERVIEW_HEIGHT - 4)) : 0;
            return (
              <div
                key={i}
                className="flex-1 rounded-t-[1px] bg-stone-400 dark:bg-stone-500"
                style={{ height: `${h}px`, alignSelf: "flex-end" }}
              />
            );
          })}
        </div>

        {/* Year boundary lines */}
        {yearLabels.map((yl) => (
          <div
            key={yl.year}
            className="absolute top-0 bottom-0 border-l border-stone-400 dark:border-stone-500"
            style={{ left: `${yl.pct}%` }}
          >
            <span className="absolute -top-0.5 left-1 text-[9px] font-bold text-stone-500 dark:text-stone-400 bg-stone-50 dark:bg-stone-800 px-0.5 rounded-sm">
              {yl.year}
            </span>
          </div>
        ))}

        {/* AI model milestone ticks in overview */}
        {overviewMilestones.map((m) => (
          <div
            key={`${m.vendor}-${m.name}`}
            className="absolute top-1 bottom-1 w-px pointer-events-none"
            style={{ left: `${m.pct}%`, backgroundColor: VENDOR_COLORS[m.vendor].line }}
          />
        ))}

        {/* Earliest release marker line */}
        {earliestRelease && bucketCount > 0 && earliestRelease > min && earliestRelease < max && (
          <div
            className="absolute top-0 bottom-0 border-l border-dashed border-stone-400 dark:border-stone-500 z-[1]"
            style={{ left: `${dateToBucketPct(earliestRelease)}%` }}
          />
        )}

        {/* Left mask */}
        <div
          data-slot="brush-mask"
          className="absolute top-0 bottom-0 left-0 bg-white/75 dark:bg-stone-950/75 pointer-events-none rounded-l"
          style={{ width: `${brushStart * 100}%` }}
        />

        {/* Right mask */}
        <div
          data-slot="brush-mask"
          className="absolute top-0 bottom-0 right-0 bg-white/75 dark:bg-stone-950/75 pointer-events-none rounded-r"
          style={{ width: `${(1 - brushEnd) * 100}%` }}
        />

        {/* Selection region */}
        <div
          data-slot="brush-selection"
          data-state={isDragging ? "dragging" : "idle"}
          className="absolute top-0 bottom-0 bg-blue-500/8 border border-blue-400/40 rounded-sm cursor-grab data-[state=dragging]:cursor-grabbing"
          style={{
            left: `${brushStart * 100}%`,
            width: `${(brushEnd - brushStart) * 100}%`,
          }}
          onPointerDown={(e) => {
            if ((e.target as HTMLElement).getAttribute("data-slot") === "brush-handle") return;
            onPointerDown(e, "move");
          }}
        >
          {/* Left handle */}
          <div
            data-slot="brush-handle"
            className="absolute -left-[5px] -top-0.5 -bottom-0.5 w-2.5 bg-blue-500 rounded-sm cursor-ew-resize z-[3] flex items-center justify-center focus-visible:outline-2 focus-visible:outline-blue-500 focus-visible:outline-offset-2"
            role="slider"
            tabIndex={0}
            aria-label="Range start"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(brushStart * 100)}
            aria-valuetext={fmtDate(startDate)}
            onPointerDown={(e) => onPointerDown(e, "left")}
            onKeyDown={(e) => onHandleKeyDown(e, "left")}
          >
            <span className="block w-0.5 h-2.5 border-l border-r border-white/40" />
          </div>

          {/* Right handle */}
          <div
            data-slot="brush-handle"
            className="absolute -right-[5px] -top-0.5 -bottom-0.5 w-2.5 bg-blue-500 rounded-sm cursor-ew-resize z-[3] flex items-center justify-center focus-visible:outline-2 focus-visible:outline-blue-500 focus-visible:outline-offset-2"
            role="slider"
            tabIndex={0}
            aria-label="Range end"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(brushEnd * 100)}
            aria-valuetext={fmtDate(endDate)}
            onPointerDown={(e) => onPointerDown(e, "right")}
            onKeyDown={(e) => onHandleKeyDown(e, "right")}
          >
            <span className="block w-0.5 h-2.5 border-l border-r border-white/40" />
          </div>
        </div>
      </div>

      {/* Earliest release label positioned outside the clipping track */}
      {earliestRelease && bucketCount > 0 && earliestRelease > min && earliestRelease < max && (() => {
        const pct = dateToBucketPct(earliestRelease);
        return (
          <div className="relative h-3 mt-0.5" aria-hidden="true">
            <span
              className="absolute text-[9px] text-stone-500 dark:text-stone-400 whitespace-nowrap"
              style={{
                left: `${pct}%`,
                transform: pct > 70 ? "translateX(-100%)" : "translateX(0)",
              }}
            >
              ↑ earliest tracked release
            </span>
          </div>
        );
      })()}
      </div>
    </div>
  );
}

/* ================================================================
   QuickRanges
   ================================================================ */

interface QuickRange {
  label: string;
  days: number;
}

const QUICK_RANGES: QuickRange[] = [
  { label: "1 week", days: 7 },
  { label: "2 weeks", days: 14 },
  { label: "1 month", days: 30 },
  { label: "3 months", days: 91 },
  { label: "6 months", days: 182 },
  { label: "1 year", days: 365 },
  { label: "All time", days: 0 },
];

function QuickRanges({ defaultPreset }: { defaultPreset?: string }) {
  const { min, max, brushStart, brushEnd, setBrush } = useNav();
  const totalDays = (max.getTime() - min.getTime()) / DAY_MS;
  const [clickedLabel, setClickedLabel] = useState<string | null>(defaultPreset ?? null);
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  // Clear active preset when brush no longer matches any preset
  useEffect(() => {
    const match = QUICK_RANGES.find((qr) => {
      if (qr.days === 0) return Math.abs(brushStart) < 0.001 && Math.abs(brushEnd - 1) < 0.001;
      const frac = Math.min(qr.days / totalDays, 1);
      const expectedStart = Math.max(0, 1 - frac);
      return Math.abs(brushStart - expectedStart) < 0.005 && Math.abs(brushEnd - 1) < 0.005;
    });
    setClickedLabel(match?.label ?? null);
  }, [brushStart, brushEnd, totalDays]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [open]);

  const applyRange = (qr: QuickRange) => {
    setOpen(false);
    if (qr.days === 0) {
      setBrush(0, 1);
    } else {
      const frac = Math.min(qr.days / totalDays, 1);
      setBrush(Math.max(0, 1 - frac), 1);
    }
  };

  return (
    <div data-slot="quick-ranges" className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="cursor-pointer flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] font-medium border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-700 dark:text-stone-300 hover:border-stone-300 dark:hover:border-stone-600 hover:bg-stone-50 dark:hover:bg-stone-800 transition-colors"
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {clickedLabel ?? "Select range"}
        <svg className="w-3.5 h-3.5 text-stone-400" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 6l4 4 4-4" />
        </svg>
      </button>
      {open && (
        <div
          className="absolute top-full left-0 mt-1 bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-700 rounded-lg shadow-lg py-1 z-20 min-w-[140px]"
          role="listbox"
          aria-label="Time range"
        >
          {QUICK_RANGES.map((qr) => (
            <button
              key={qr.label}
              type="button"
              role="option"
              aria-selected={clickedLabel === qr.label}
              className={`cursor-pointer w-full text-left px-3 py-1.5 text-[12px] transition-colors flex items-center justify-between ${
                clickedLabel === qr.label
                  ? "text-stone-900 dark:text-stone-100 font-medium bg-stone-50 dark:bg-stone-800"
                  : "text-stone-600 dark:text-stone-400 hover:bg-stone-50 dark:hover:bg-stone-800 hover:text-stone-900 dark:hover:text-stone-100"
              }`}
              onClick={() => applyRange(qr)}
            >
              {qr.label}
              {clickedLabel === qr.label && (
                <svg className="w-3.5 h-3.5 text-stone-500" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 8.5l3.5 3.5 6.5-8" />
                </svg>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/* ================================================================
   Export
   ================================================================ */

export const RangeNavigator = {
  Root,
  Header,
  DetailChart,
  Overview,
  QuickRanges,
};
