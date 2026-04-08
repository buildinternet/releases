"use client";

import { useMemo, useState, useCallback, useRef, useEffect } from "react";
import type { OrgHeatmap } from "@/lib/api";

const MIN_CELL_SIZE = 8;
const MAX_CELL_SIZE = 13;
const CELL_GAP = 3;
const WEEKS = 52;
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
  "var(--color-heat-0, #1c2129)",
  "var(--color-heat-1, rgba(56, 132, 244, 0.25))",
  "var(--color-heat-2, rgba(56, 132, 244, 0.50))",
  "var(--color-heat-3, rgba(56, 132, 244, 0.75))",
  "var(--color-heat-4, rgba(56, 132, 244, 1.0))",
];

function formatTooltipDate(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}

function formatMonth(dateStr: string): string {
  const d = new Date(dateStr + "T12:00:00");
  return d.toLocaleDateString("en-US", { month: "short" });
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

function buildGrid(heatmap: OrgHeatmap): { cells: CellData[]; monthLabels: MonthLabel[] } {
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
  const startMs = todayMs - (WEEKS * 7 + todayDay) * 86400000;

  const cells: CellData[] = [];
  const monthLabels: MonthLabel[] = [];
  let lastMonth = -1;

  for (let week = 0; week < WEEKS; week++) {
    for (let day = 0; day < DAYS; day++) {
      const ms = startMs + (week * 7 + day) * 86400000;
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

interface ReleaseHeatmapProps {
  heatmap: OrgHeatmap;
}

export function ReleaseHeatmap({ heatmap }: ReleaseHeatmapProps) {
  const { cells, monthLabels } = useMemo(() => buildGrid(heatmap), [heatmap]);

  const [tooltip, setTooltip] = useState<{ text: string; x: number; y: number } | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [cellSize, setCellSize] = useState(MAX_CELL_SIZE);

  // Compute cell size to fit the container width
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    function measure() {
      const available = el!.clientWidth - DAY_LABEL_WIDTH - 8; // 8px for flex gap
      const size = Math.floor((available + CELL_GAP) / WEEKS - CELL_GAP);
      setCellSize(Math.max(MIN_CELL_SIZE, Math.min(MAX_CELL_SIZE, size)));
    }
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const handleMouseEnter = useCallback((e: React.MouseEvent<HTMLDivElement>, cell: CellData) => {
    const label = cell.count === 0 ? "No releases" : cell.count === 1 ? "1 release" : `${cell.count} releases`;
    setTooltip({
      text: `${label} on ${formatTooltipDate(cell.date)}`,
      x: e.clientX,
      y: e.clientY,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  const gridWidth = WEEKS * (cellSize + CELL_GAP) - CELL_GAP;

  const weeks = useMemo(() => {
    const result: CellData[][] = Array.from({ length: WEEKS }, () => []);
    for (const cell of cells) {
      result[cell.col].push(cell);
    }
    return result;
  }, [cells]);

  return (
    <div ref={containerRef} className="bg-white dark:bg-stone-900 border border-stone-200 dark:border-stone-800 rounded-lg px-5 py-4">
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
          <div className="relative" style={{ height: 14, width: gridWidth }}>
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
          <div className="flex" style={{ gap: CELL_GAP }}>
            {weeks.map((weekCells, wi) => (
              <div key={wi} className="flex flex-col" style={{ gap: CELL_GAP }}>
                {weekCells.map((cell) => (
                  <div
                    key={cell.date}
                    className="rounded-[2px] hover:outline hover:outline-1 hover:outline-stone-400 dark:hover:outline-stone-500 hover:-outline-offset-1"
                    style={{
                      width: cellSize,
                      height: cellSize,
                      background: LEVEL_COLORS[cell.level],
                    }}
                    onMouseEnter={(e) => handleMouseEnter(e, cell)}
                    onMouseLeave={handleMouseLeave}
                  />
                ))}
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
