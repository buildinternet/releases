"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
/** Shape accepted by the heatmap — works with both OrgHeatmap and SourceHeatmap. */
export interface HeatmapData {
  range: { from: string; to: string };
  dailyCounts: Array<{ date: string; count: number }>;
  total: number;
}

const MIN_CELL_SIZE = 7;
const MAX_CELL_SIZE = 13;
const CELL_GAP = 3;
const MAX_WEEKS = 52;
const DAYS = 7;
const DAY_LABEL_WIDTH = 32;

/** Day labels shown beside the grid (Mon, Wed, Fri visible; others hidden for spacing). */
const DAY_LABELS = [
  { label: "Sun", visible: false },
  { label: "Mon", visible: true },
  { label: "Tue", visible: false },
  { label: "Wed", visible: true },
  { label: "Thu", visible: false },
  { label: "Fri", visible: true },
  { label: "Sat", visible: false },
];

function getLevel(count: number): number {
  return Math.min(count, 4);
}

const LEVEL_COLORS = [
  "var(--color-heat-0, #e7e5e4)",
  "var(--color-heat-1, rgba(56, 132, 244, 0.25))",
  "var(--color-heat-2, rgba(56, 132, 244, 0.50))",
  "var(--color-heat-3, rgba(56, 132, 244, 0.75))",
  "var(--color-heat-4, rgba(56, 132, 244, 1.0))",
];

function formatTooltipDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

function formatMonth(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00Z");
  return d.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
}

interface CellData {
  date: string;
  count: number;
  level: number;
  col: number;
  row: number;
}

interface MonthLabel {
  text: string;
  col: number;
}

function buildGrid(heatmap: HeatmapData, visibleWeeks: number): { cells: CellData[]; monthLabels: MonthLabel[] } {
  const countMap = new Map<string, number>();
  for (const entry of heatmap.dailyCounts) {
    countMap.set(entry.date, entry.count);
  }

  // All date math in UTC to match the API's DATE() output
  const todayMs = Date.UTC(
    parseInt(heatmap.range.to.slice(0, 4)),
    parseInt(heatmap.range.to.slice(5, 7)) - 1,
    parseInt(heatmap.range.to.slice(8, 10)),
  );
  const todayDay = new Date(todayMs).getUTCDay();
  // Shift start forward by one week so the last column lands on the current week.
  // The last column is a partial week ending on today — future dates are skipped.
  const startMs = todayMs - ((visibleWeeks - 1) * 7 + todayDay) * 86400000;

  const cells: CellData[] = [];
  const monthLabels: MonthLabel[] = [];
  let lastMonth = -1;

  outer: for (let week = 0; week < visibleWeeks; week++) {
    for (let day = 0; day < DAYS; day++) {
      const ms = startMs + (week * 7 + day) * 86400000;
      if (ms > todayMs) break outer;
      const d = new Date(ms);
      const key = d.toISOString().slice(0, 10);
      const count = countMap.get(key) ?? 0;

      cells.push({
        date: key,
        count,
        level: getLevel(count),
        col: week,
        row: day,
      });

      if (day === 0 && d.getUTCMonth() !== lastMonth) {
        lastMonth = d.getUTCMonth();
        monthLabels.push({ text: formatMonth(key), col: week });
      }
    }
  }

  return { cells, monthLabels };
}

/** Find the date of the earliest release with count > 0 from the heatmap data. */
function findEarliestRelease(heatmap: HeatmapData): string | null {
  const withCounts = heatmap.dailyCounts.filter((d) => d.count > 0);
  if (withCounts.length === 0) return null;
  withCounts.sort((a, b) => a.date.localeCompare(b.date));
  return withCounts[0].date;
}

interface ReleaseHeatmapProps {
  heatmap: HeatmapData;
  trackingSince?: string | null;
}

export function ReleaseHeatmap({ heatmap, trackingSince }: ReleaseHeatmapProps) {
  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(MIN_CELL_SIZE);
  const [visibleWeeks, setVisibleWeeks] = useState(MAX_WEEKS);

  // Compute cell size and visible weeks to fit the container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function measure() {
      // clientWidth includes padding — subtract it to get the actual content box width
      const cs = getComputedStyle(el!);
      const contentWidth = el!.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      const available = contentWidth - DAY_LABEL_WIDTH - 8; // 8px for flex gap
      const sizeAt52 = Math.floor((available + CELL_GAP) / MAX_WEEKS - CELL_GAP);
      if (sizeAt52 >= MIN_CELL_SIZE) {
        // All 52 weeks fit — use the largest cell size that works
        setCellSize(Math.min(MAX_CELL_SIZE, sizeAt52));
        setVisibleWeeks(MAX_WEEKS);
      } else {
        // Not enough room for 52 weeks at MIN_CELL_SIZE — reduce weeks to fit
        const weeks = Math.max(12, Math.floor((available + CELL_GAP) / (MIN_CELL_SIZE + CELL_GAP)));
        setCellSize(MIN_CELL_SIZE);
        setVisibleWeeks(weeks);
      }
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const { cells, monthLabels } = useMemo(() => buildGrid(heatmap, visibleWeeks), [heatmap, visibleWeeks]);

  // Use trackingSince if provided, otherwise fall back to earliest release in data.
  // Normalize to YYYY-MM-DD to match cell date format.
  const trackingStart = useMemo(() => {
    const raw = trackingSince ?? findEarliestRelease(heatmap);
    return raw ? raw.slice(0, 10) : null;
  }, [trackingSince, heatmap]);

  const handleMouseEnter = useCallback((e: React.MouseEvent<SVGSVGElement>, cell: CellData, isPreTracking: boolean, isEarliestTracked: boolean) => {
    const label = cell.count === 0 ? "No releases" : cell.count === 1 ? "1 release" : `${cell.count} releases`;
    let text = `${label} on ${formatTooltipDate(cell.date)}`;
    if (isEarliestTracked) {
      text += " · Earliest tracked release";
    } else if (isPreTracking) {
      text += " · Before tracking";
    }
    setTooltip({
      text,
      x: e.clientX,
      y: e.clientY,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  const weeks = useMemo(() => {
    const result: CellData[][] = Array.from({ length: visibleWeeks }, () => []);
    for (const cell of cells) {
      result[cell.col].push(cell);
    }
    return result;
  }, [cells, visibleWeeks]);

  // SVG pattern ID for pre-tracking stripe
  const patternId = "heatmap-stripe";

  return (
    <div ref={containerRef} className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-5 py-4 mb-5">
      {/* SVG defs for stripe pattern */}
      <svg width="0" height="0" className="absolute">
        <defs>
          <pattern id={patternId} width="4" height="4" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)">
            <rect width="4" height="4" fill="var(--color-heat-0, #e7e5e4)" />
            <line x1="0" y1="0" x2="0" y2="4" stroke="rgba(255,255,255,0.08)" strokeWidth="2" />
          </pattern>
        </defs>
      </svg>

      {/* Header */}
      <div className="flex justify-between items-center mb-3">
        <span className="text-xs text-stone-500 dark:text-stone-400">
          <strong className="text-stone-900 dark:text-stone-100 font-semibold">{heatmap.total}</strong>
          {" "}releases in the last year
        </span>
        <span className="text-[11px] text-stone-400 dark:text-stone-500">
          {heatmap.range.from} &mdash; {heatmap.range.to}
        </span>
      </div>

      {/* Grid */}
      <div className="flex gap-2">
        {/* Day labels */}
        <div className="flex flex-col shrink-0" style={{ gap: CELL_GAP, width: DAY_LABEL_WIDTH }}>
          {DAY_LABELS.map((d) => (
            <div
              key={d.label}
              className="text-stone-400 dark:text-stone-500 flex items-center"
              style={{ height: cellSize, fontSize: 9, visibility: d.visible ? "visible" : "hidden" }}
            >
              {d.label}
            </div>
          ))}
        </div>

        {/* Heatmap grid + month labels */}
        <div className="min-w-0 flex-1">
          {/* Month labels */}
          <div className="relative" style={{ height: 14 }}>
            {monthLabels.map((ml, i) => (
              <span
                key={i}
                className="absolute text-stone-400 dark:text-stone-500"
                style={{ left: ml.col * (cellSize + CELL_GAP), fontSize: 9 }}
              >
                {ml.text}
              </span>
            ))}
          </div>

          {/* Cell grid */}
          <div className="flex overflow-hidden" style={{ gap: CELL_GAP }}>
            {weeks.map((weekCells, wi) => (
              <div key={wi} className="flex flex-col" style={{ gap: CELL_GAP }}>
                {weekCells.map((cell) => {
                  const isPreTracking = trackingStart ? cell.date < trackingStart : false;
                  const isEarliestTracked = trackingStart ? cell.date === trackingStart : false;

                  return (
                    <svg
                      key={cell.date}
                      width={cellSize}
                      height={cellSize}
                      className="rounded-[2px]"
                      onMouseEnter={(e) => handleMouseEnter(e, cell, isPreTracking, isEarliestTracked)}
                      onMouseLeave={handleMouseLeave}
                    >
                      <rect
                        width={cellSize}
                        height={cellSize}
                        rx={2}
                        fill={isPreTracking ? `url(#${patternId})` : LEVEL_COLORS[cell.level]}
                      />
                    </svg>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Footer — legend */}
      <div className="flex justify-end items-center gap-1 mt-2.5">
        <span className="text-[10px] text-stone-400 dark:text-stone-500 mr-0.5">Less</span>
        {LEVEL_COLORS.map((color, i) => (
          <div
            key={i}
            className="rounded-[2px]"
            style={{ width: cellSize, height: cellSize, background: color }}
          />
        ))}
        <span className="text-[10px] text-stone-400 dark:text-stone-500 ml-0.5">More</span>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed pointer-events-none z-50 bg-stone-800 dark:bg-stone-700 border border-stone-600 dark:border-stone-500 rounded px-2.5 py-1.5 text-[11px] text-stone-100 whitespace-nowrap shadow-lg"
          style={{ left: tooltip.x + 12, top: tooltip.y - 30 }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
