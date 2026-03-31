"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { type WeeklyBucket } from "@/lib/cadence";

/* ================================================================
   Shared context — holds the brush state for all subcomponents.
   ================================================================ */

interface RangeNavigatorCtx {
  /** Normalised 0–1 brush start */
  brushStart: number;
  /** Normalised 0–1 brush end */
  brushEnd: number;
  setBrush: (start: number, end: number) => void;
  min: Date;
  max: Date;
  buckets: WeeklyBucket[];
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

/* ================================================================
   Root
   ================================================================ */

interface RootProps {
  min: Date;
  max: Date;
  buckets: WeeklyBucket[];
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
  value,
  defaultValue,
  onValueChange,
  children,
  className,
}: RootProps) {
  const totalMs = max.getTime() - min.getTime();

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
    <Ctx.Provider value={{ brushStart, brushEnd, setBrush, min, max, buckets }}>
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
   Chart (bar overview)
   ================================================================ */

function Chart() {
  const { buckets, brushStart, brushEnd } = useNav();
  const maxCount = Math.max(...buckets.map((b) => b.count), 1);
  const total = buckets.length;

  return (
    <div data-slot="range-navigator-chart" className="relative h-16 mb-1" aria-hidden="true">
      <div data-slot="range-navigator-bars" className="flex items-end gap-px h-full w-full">
        {buckets.map((bucket, i) => {
          const h = bucket.count > 0 ? Math.max(2, (bucket.count / maxCount) * 60) : 0;
          const bucketStart = i / total;
          const bucketEnd = (i + 1) / total;
          const inBrush = bucketEnd > brushStart && bucketStart < brushEnd;
          const state = bucket.count === 0 ? "empty" : inBrush ? "in-range" : "out-of-range";

          return (
            <div
              key={i}
              data-slot="range-navigator-bar"
              data-state={state}
              className="flex-1 rounded-t-sm min-h-0 transition-colors duration-100"
              style={{
                height: `${h}px`,
                backgroundColor: state === "empty" ? "transparent" : undefined,
              }}
            />
          );
        })}
      </div>
    </div>
  );
}

/* ================================================================
   MonthLabels
   ================================================================ */

function MonthLabels() {
  const { min, max } = useNav();
  const totalMs = max.getTime() - min.getTime();
  const labels: { label: string; pct: number }[] = [];

  const mo = new Date(min);
  mo.setDate(1);
  if (mo < min) mo.setMonth(mo.getMonth() + 1);
  while (mo < max) {
    labels.push({
      label: fmtMonth(mo),
      pct: ((mo.getTime() - min.getTime()) / totalMs) * 100,
    });
    mo.setMonth(mo.getMonth() + 1);
  }

  return (
    <div data-slot="range-navigator-months" className="relative h-4 mb-2" aria-hidden="true">
      {labels.map((l) => (
        <span
          key={l.label}
          data-slot="range-navigator-month-label"
          className="absolute text-[10px] text-stone-400"
          style={{ left: `${l.pct}%` }}
        >
          {l.label}
        </span>
      ))}
    </div>
  );
}

/* ================================================================
   Brush — the interactive range selector
   ================================================================ */

function Brush() {
  const { brushStart, brushEnd, setBrush, min, max } = useNav();
  const trackRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{
    mode: "left" | "right" | "move";
    startX: number;
    startBS: number;
    startBE: number;
  } | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // Keep brush values in refs so drag listeners read current values without effect churn
  const brushRef = useRef({ brushStart, brushEnd });
  brushRef.current = { brushStart, brushEnd };

  const startDate = toDate({ min, max }, brushStart);
  const endDate = toDate({ min, max }, brushEnd);

  /* --- Pointer drag --- */

  const onPointerDown = useCallback(
    (e: React.PointerEvent, mode: "left" | "right" | "move") => {
      e.preventDefault();
      e.stopPropagation();
      const { brushStart: bs, brushEnd: be } = brushRef.current;
      dragRef.current = {
        mode,
        startX: e.clientX,
        startBS: bs,
        startBE: be,
      };
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

  return (
    <div
      ref={trackRef}
      data-slot="brush-track"
      className="relative h-7 bg-stone-100 rounded cursor-pointer select-none"
      onClick={onTrackClick}
    >
      {/* Left mask */}
      <div
        data-slot="brush-mask"
        className="absolute top-0 bottom-0 left-0 bg-stone-50/60 pointer-events-none rounded-l"
        style={{ width: `${brushStart * 100}%` }}
      />

      {/* Right mask */}
      <div
        data-slot="brush-mask"
        className="absolute top-0 bottom-0 right-0 bg-stone-50/60 pointer-events-none rounded-r"
        style={{ width: `${(1 - brushEnd) * 100}%` }}
      />

      {/* Selection region */}
      <div
        data-slot="brush-selection"
        data-state={isDragging ? "dragging" : "idle"}
        className="absolute top-0 bottom-0 bg-blue-500/10 border border-blue-400/40 rounded-sm cursor-grab data-[state=dragging]:cursor-grabbing"
        style={{
          left: `${brushStart * 100}%`,
          width: `${(brushEnd - brushStart) * 100}%`,
        }}
        onPointerDown={(e) => {
          if (
            (e.target as HTMLElement).getAttribute("data-slot") === "brush-handle"
          )
            return;
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

function QuickRanges() {
  const { min, max, setBrush } = useNav();
  const totalDays = (max.getTime() - min.getTime()) / (24 * 60 * 60 * 1000);

  return (
    <div data-slot="quick-ranges" className="flex gap-1 mt-2" role="group" aria-label="Quick range presets">
      {QUICK_RANGES.map((qr) => (
        <button
          key={qr.label}
          data-slot="quick-range-button"
          className="bg-stone-50 border border-stone-200 text-stone-500 px-2 py-0.5 rounded text-[10px] cursor-pointer transition-colors hover:border-blue-400 hover:text-blue-500 hover:bg-blue-50 focus-visible:outline-2 focus-visible:outline-blue-500 focus-visible:outline-offset-1"
          onClick={() => {
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
   Export
   ================================================================ */

export const RangeNavigator = {
  Root,
  Header,
  Chart,
  MonthLabels,
  Brush,
  QuickRanges,
};
