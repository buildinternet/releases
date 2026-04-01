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
import Link from "next/link";
import { type WeeklyBucket, getProductColor, DAY_MS, WEEK_MS, fmtWeek } from "@/lib/cadence";
import { HoverCard } from "@/components/hover-card";

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
  /** Earliest bucket with data — derived from buckets */
  earliestRelease: Date | null;
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
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function fmtMonth(d: Date) {
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" });
}

function pillCls(active: boolean) {
  return [
    "px-2 py-0.5 rounded text-[10px] transition-colors",
    "focus-visible:outline-2 focus-visible:outline-blue-500 focus-visible:outline-offset-1",
    active
      ? "bg-blue-50 border border-blue-300 text-blue-600"
      : "bg-stone-50 border border-stone-200 text-stone-500 hover:border-blue-400 hover:text-blue-500 hover:bg-blue-50",
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
    <Ctx.Provider value={{ brushStart, brushEnd, setBrush, min, max, buckets, sourceBuckets: (sourceBuckets && sourceBuckets.length > 1) ? sourceBuckets : null, earliestRelease }}>
      <div
        data-slot="range-navigator"
        className={`bg-white border border-stone-200 rounded-lg px-5 py-4 mb-5 ${className ?? ""}`}
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
  const { brushStart, brushEnd, min, max } = useNav();
  const startDate = toDate({ min, max }, brushStart);
  const endDate = toDate({ min, max }, brushEnd);

  return (
    <div data-slot="range-navigator-header" className="flex justify-between items-center mb-3">
      <div data-slot="range-navigator-title" className="text-[13px] font-semibold text-stone-900">
        {title}
      </div>
      <div
        data-slot="range-navigator-dates"
        className="text-xs text-blue-500 font-mono"
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

function DetailChart() {
  const { buckets, sourceBuckets, brushStart, brushEnd, min, max, earliestRelease } = useNav();
  const [stacked, setStacked] = useState(false);
  const [hiddenSources, setHiddenSources] = useState<Set<string>>(new Set());

  const showToggle = sourceBuckets !== null && sourceBuckets.length > 1;

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

  // Per-source breakdown for each brushed week (only computed when sourceBuckets exist)
  const stackedData = useMemo(() => {
    if (!sourceBuckets) return null;
    const sourceMaps = sourceBuckets.map((src) => {
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
  }, [sourceBuckets, brushedBuckets, hiddenSources]);

  const maxCount = Math.max(...brushedBuckets.map((b) => b.count), 1);

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

  // Month labels for the brushed window
  const monthLabels = useMemo(() => {
    if (brushedBuckets.length === 0) return [];
    const first = brushedBuckets[0].weekStart;
    const last = brushedBuckets[brushedBuckets.length - 1].weekStart;
    const span = last.getTime() - first.getTime();
    if (span <= 0) return [];

    const labels: { label: string; pct: number }[] = [];
    const mo = new Date(first);
    mo.setDate(1);
    if (mo < first) mo.setMonth(mo.getMonth() + 1);
    while (mo <= last) {
      labels.push({
        label: fmtMonth(mo),
        pct: ((mo.getTime() - first.getTime()) / span) * 100,
      });
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
        <span className="text-stone-500 font-medium">No data in this range</span>
        {isBeforeEarliest && (
          <span className="text-stone-400">
            Earliest tracked release: {fmtDate(earliestRelease)}
          </span>
        )}
      </div>
    );
  }

  const isStacked = stacked && stackedData !== null;

  return (
    <div data-slot="detail-chart" className="mb-3">
      {/* Toggle button — only shown when multiple sources exist */}
      {showToggle && (
        <div className="flex justify-end mb-1.5">
          <div className="flex gap-0">
            <button
              type="button"
              onClick={() => setStacked(false)}
              className={`cursor-pointer rounded-r-none ${pillCls(!stacked)}`}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setStacked(true)}
              className={`cursor-pointer rounded-l-none border-l-0 ${pillCls(stacked)}`}
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

        {/* Bars */}
        <div className="flex items-end gap-px flex-1 min-w-0">
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
                      ? "data-[state=empty]:bg-stone-100"
                      : "data-[state=filled]:bg-blue-500 data-[state=filled]:hover:bg-blue-600 data-[state=empty]:bg-stone-100"
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
                  <HoverCard.Content className="bg-white border border-stone-200 rounded-lg shadow-lg px-3 py-2 min-w-[140px]">
                    <div className="text-[11px] font-medium text-stone-500 mb-1">
                      {fmtWeek(bucket.weekStart)} – {fmtWeek(weekEnd)}
                    </div>
                    <div className="text-sm font-semibold text-stone-900">
                      {bucket.count} {bucket.count === 1 ? "release" : "releases"}
                    </div>
                    {isStacked && weekSegments && weekSegments.length > 0 && (
                      <div className="mt-1.5 pt-1.5 border-t border-stone-100 space-y-0.5">
                        {weekSegments.map((seg, si) => (
                          <div key={si} className="flex items-center gap-1.5 text-[11px] text-stone-600">
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
      {isStacked && sourceBuckets && (
        <div className="flex flex-wrap gap-x-3 gap-y-1 mt-2 ml-8">
          {sourceBuckets.map((src) => {
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
                <span className={`text-[11px] text-stone-600 ${isHidden ? "line-through" : ""}`}>
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
  const { buckets, brushStart, brushEnd, setBrush, min, max, earliestRelease } = useNav();
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

  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const totalMs = max.getTime() - min.getTime();

  // Year boundary labels
  const yearLabels = useMemo(() => {
    if (totalMs <= 0) return [];
    const labels: { year: number; pct: number }[] = [];
    const startYear = min.getFullYear();
    const endYear = max.getFullYear();
    for (let y = startYear + 1; y <= endYear; y++) {
      const jan1 = new Date(y, 0, 1);
      if (jan1 > min && jan1 < max) {
        labels.push({ year: y, pct: ((jan1.getTime() - min.getTime()) / totalMs) * 100 });
      }
    }
    return labels;
  }, [min, max, totalMs]);

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
        className="relative bg-stone-50 rounded cursor-pointer select-none border border-stone-100"
        style={{ height: OVERVIEW_HEIGHT + 16 }}
        onClick={onTrackClick}
      >
        {/* Mini bars */}
        <div className="absolute inset-x-0 bottom-2 top-2 flex items-end gap-px px-px" aria-hidden="true">
          {buckets.map((bucket, i) => {
            const h = bucket.count > 0 ? Math.max(1, (bucket.count / maxCount) * (OVERVIEW_HEIGHT - 4)) : 0;
            return (
              <div
                key={i}
                className="flex-1 rounded-t-[1px] bg-stone-400"
                style={{ height: `${h}px`, alignSelf: "flex-end" }}
              />
            );
          })}
        </div>

        {/* Year boundary lines */}
        {yearLabels.map((yl) => (
          <div
            key={yl.year}
            className="absolute top-0 bottom-0 border-l border-stone-400"
            style={{ left: `${yl.pct}%` }}
          >
            <span className="absolute -top-0.5 left-1 text-[9px] font-bold text-stone-500 bg-stone-50 px-0.5 rounded-sm">
              {yl.year}
            </span>
          </div>
        ))}

        {/* Earliest release marker line */}
        {earliestRelease && totalMs > 0 && earliestRelease > min && earliestRelease < max && (
          <div
            className="absolute top-0 bottom-0 border-l border-dashed border-stone-400 z-[1]"
            style={{ left: `${((earliestRelease.getTime() - min.getTime()) / totalMs) * 100}%` }}
          />
        )}

        {/* Left mask */}
        <div
          data-slot="brush-mask"
          className="absolute top-0 bottom-0 left-0 bg-white/75 pointer-events-none rounded-l"
          style={{ width: `${brushStart * 100}%` }}
        />

        {/* Right mask */}
        <div
          data-slot="brush-mask"
          className="absolute top-0 bottom-0 right-0 bg-white/75 pointer-events-none rounded-r"
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
      {earliestRelease && totalMs > 0 && earliestRelease > min && earliestRelease < max && (() => {
        const pct = ((earliestRelease.getTime() - min.getTime()) / totalMs) * 100;
        return (
          <div className="relative h-3 mt-0.5" aria-hidden="true">
            <span
              className="absolute text-[9px] text-stone-500 whitespace-nowrap"
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
  { label: "1w", days: 7 },
  { label: "2w", days: 14 },
  { label: "1m", days: 30 },
  { label: "3m", days: 91 },
  { label: "All", days: 0 },
];

function QuickRanges({ defaultPreset }: { defaultPreset?: string }) {
  const { min, max, brushStart, brushEnd, setBrush } = useNav();
  const totalDays = (max.getTime() - min.getTime()) / DAY_MS;
  const [clickedLabel, setClickedLabel] = useState<string | null>(defaultPreset ?? null);

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

  return (
    <div data-slot="quick-ranges" className="flex gap-1" role="group" aria-label="Quick range presets">
      {QUICK_RANGES.map((qr) => (
        <button
          key={qr.label}
          data-slot="quick-range-button"
          className={`cursor-pointer ${pillCls(clickedLabel === qr.label)}`}
          onClick={() => {
            setClickedLabel(qr.label);
            if (qr.days === 0) {
              setBrush(0, 1);
            } else {
              const frac = Math.min(qr.days / totalDays, 1);
              setBrush(Math.max(0, 1 - frac), 1);
            }
          }}
        >
          {qr.label}
        </button>
      ))}
    </div>
  );
}

/* ================================================================
   YearSelector
   ================================================================ */

interface YearSelectorProps {
  years: number[];
  currentYear?: number;
  orgSlug: string;
}

function YearSelector({ years, currentYear, orgSlug }: YearSelectorProps) {
  const isTrailing = currentYear === undefined;

  return (
    <div data-slot="year-selector" className="flex gap-1" role="group" aria-label="Year selector">
      <Link
        href={`/${orgSlug}`}
        data-slot="year-button"
        className={`no-underline ${pillCls(isTrailing)}`}
      >
        Last 12mo
      </Link>
      {years.map((year) => {
        const isActive = currentYear === year;
        return (
          <Link
            key={year}
            href={`/${orgSlug}?year=${year}`}
            data-slot="year-button"
            className={`no-underline ${pillCls(isActive)}`}
          >
            {year}
          </Link>
        );
      })}
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
  YearSelector,
};
