"use client";

/**
 * Custom SVG charts for the Classifications tab. Each chart has its own error
 * boundary so a render failure stays inside that panel.
 */
import { Component, useEffect, useRef, useState, type ErrorInfo, type ReactNode } from "react";
import type {
  ClassificationBucket,
  ClassificationChoiceSeriesPoint,
  ClassificationHistogram,
  ClassificationSeriesPoint,
} from "./classifications-types";
import {
  PROBABILITY_THRESHOLD_LABEL,
  thresholdBinIndex,
  visibleChoiceKeys,
} from "./classifications-view";

const CHART_HEIGHT = 180;
const PAD = { t: 16, r: 12, b: 28, l: 36 };

const DISPOSITIONS: { key: keyof ClassificationSeriesPoint; label: string; color: string }[] = [
  { key: "kept", label: "Kept", color: "#10b981" },
  { key: "suppressed", label: "Suppressed", color: "#f59e0b" },
  { key: "failed", label: "Failed", color: "#f43f5e" },
  { key: "skipped", label: "Skipped", color: "#a8a29e" },
];

const CHOICE_COLORS = [
  "#0ea5e9",
  "#8b5cf6",
  "#14b8a6",
  "#f97316",
  "#ec4899",
  "#84cc16",
  "#eab308",
  "#64748b",
];

interface SeriesDef {
  key: string;
  label: string;
  color: string;
}

interface ChartPoint {
  t: string;
  values: Record<string, number>;
}

class ChartErrorBoundary extends Component<
  { children: ReactNode; label: string },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[ClassificationsTab]", this.props.label, error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="rounded-lg border border-stone-200 dark:border-stone-800 px-4 py-6 text-center">
          <p className="text-sm text-stone-500 dark:text-stone-400 mb-2">
            {this.props.label} failed to render.
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

function ChartMessage({ children }: { children: ReactNode }) {
  return (
    <div className="h-full flex items-center justify-center text-xs text-stone-400 dark:text-stone-500 px-4 text-center">
      {children}
    </div>
  );
}

function ChartPanel({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <section className="rounded-lg border border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-950/40 overflow-hidden">
      <div className="px-4 pt-3 pb-2">
        <h3 className="text-sm font-medium text-stone-900 dark:text-stone-100">{title}</h3>
        {subtitle ? (
          <p className="text-xs text-stone-400 dark:text-stone-500 mt-0.5">{subtitle}</p>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Legend({ series }: { series: readonly SeriesDef[] }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 pb-2">
      {series.map((item) => (
        <span
          key={item.key}
          className="inline-flex items-center gap-1.5 text-[11px] text-stone-500 dark:text-stone-400"
        >
          <span className="w-2 h-2 rounded-[2px] shrink-0" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

function niceMax(n: number): number {
  if (n <= 0) return 4;
  if (n <= 4) return Math.ceil(n);
  const power = 10 ** Math.floor(Math.log10(n));
  const magnitude = n / power;
  const nice = magnitude <= 1 ? 1 : magnitude <= 2 ? 2 : magnitude <= 5 ? 5 : 10;
  return nice * power;
}

function formatAxis(n: number): string {
  if (Math.abs(n) >= 1000) {
    const scaled = n / 1000;
    return `${Number.isInteger(scaled) ? scaled : scaled.toFixed(1)}k`;
  }
  if (Number.isInteger(n)) return String(n);
  return String(Math.round(n * 10) / 10);
}

function formatBucketTick(t: string, bucket: ClassificationBucket): string {
  const date = new Date(t);
  if (Number.isNaN(date.getTime())) return "";
  if (bucket === "day") {
    return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
  return date.toLocaleTimeString("en-US", { hour: "numeric", hour12: true });
}

function bucketSubtitle(bucket: ClassificationBucket): string {
  return bucket === "hour" ? "Hourly" : "Daily";
}

function useChartWidth() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const apply = (next: number) => {
      if (next > 0) setWidth(next);
    };
    apply(el.clientWidth);
    const observer = new ResizeObserver((entries) => {
      apply(entries[0]?.contentRect.width ?? 0);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, width };
}

function StackedSvg({
  points,
  series,
  bucket,
  ariaLabel,
}: {
  points: ChartPoint[];
  series: readonly SeriesDef[];
  bucket: ClassificationBucket;
  ariaLabel: string;
}) {
  const { ref, width } = useChartWidth();
  const height = CHART_HEIGHT;
  const plotW = Math.max(1, width - PAD.l - PAD.r);
  const plotH = height - PAD.t - PAD.b;
  const count = points.length;
  const max = niceMax(
    Math.max(
      ...points.map((point) =>
        series.reduce((sum, item) => sum + Math.max(0, point.values[item.key] ?? 0), 0),
      ),
      0,
    ),
  );
  const slot = plotW / Math.max(count, 1);
  const gap = Math.min(2, slot * 0.25);
  const barW = Math.max(1, slot - gap);
  const every = count > 48 ? Math.ceil(count / 8) : count > 24 ? 3 : count > 14 ? 2 : 1;
  const ticks = 4;

  return (
    <div ref={ref} className="w-full h-full">
      <svg width={width} height={height} className="block" role="img" aria-label={ariaLabel}>
        {Array.from({ length: ticks + 1 }, (_, index) => {
          const y = PAD.t + (plotH * index) / ticks;
          const value = max * (1 - index / ticks);
          return (
            <g key={index}>
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
                {formatAxis(value)}
              </text>
            </g>
          );
        })}
        {points.map((point, index) => {
          const x = PAD.l + index * slot + gap / 2;
          let y = PAD.t + plotH;
          const bars: ReactNode[] = [];
          for (const item of series) {
            const value = Math.max(0, point.values[item.key] ?? 0);
            if (value <= 0) continue;
            const barH = (value / max) * plotH;
            y -= barH;
            bars.push(
              <rect key={item.key} x={x} y={y} width={barW} height={barH} fill={item.color}>
                <title>{`${item.label}: ${value}`}</title>
              </rect>,
            );
          }
          return <g key={point.t || index}>{bars}</g>;
        })}
        {points.map((point, index) => {
          if (index % every !== 0 && index !== count - 1) return null;
          return (
            <text
              key={`x-${point.t}`}
              x={PAD.l + index * slot + slot / 2}
              y={PAD.t + plotH + 16}
              textAnchor="middle"
              fontSize={10}
              className="fill-stone-400 dark:fill-stone-500"
            >
              {formatBucketTick(point.t, bucket)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

function SeriesChart({
  title,
  bucket,
  points,
  series,
  ariaLabel,
  empty,
}: {
  title: string;
  bucket: ClassificationBucket;
  points: ChartPoint[];
  series: readonly SeriesDef[];
  ariaLabel: string;
  empty: string;
}) {
  const hasBars =
    points.length > 0 &&
    series.some((item) => points.some((point) => (point.values[item.key] ?? 0) > 0));
  return (
    <ChartPanel title={title} subtitle={bucketSubtitle(bucket)}>
      <Legend series={series} />
      <div className="px-2 sm:px-3" style={{ height: CHART_HEIGHT }}>
        {hasBars ? (
          <StackedSvg points={points} series={series} bucket={bucket} ariaLabel={ariaLabel} />
        ) : (
          <ChartMessage>{empty}</ChartMessage>
        )}
      </div>
    </ChartPanel>
  );
}

export function DispositionChart({
  series,
  bucket,
}: {
  series: ClassificationSeriesPoint[];
  bucket: ClassificationBucket;
}) {
  const points: ChartPoint[] = series.map((point) => ({
    t: point.t,
    values: {
      kept: point.kept ?? 0,
      suppressed: point.suppressed ?? 0,
      failed: point.failed ?? 0,
      skipped: point.skipped ?? 0,
    },
  }));
  return (
    <ChartErrorBoundary label="Disposition chart">
      <SeriesChart
        title="Disposition"
        bucket={bucket}
        points={points}
        series={DISPOSITIONS}
        ariaLabel="Classifications by disposition over time"
        empty="No disposition data in this range."
      />
    </ChartErrorBoundary>
  );
}

export function ChoiceChart({
  series,
  bucket,
}: {
  series: ClassificationChoiceSeriesPoint[];
  bucket: ClassificationBucket;
}) {
  const keys = visibleChoiceKeys(series);
  const palette: SeriesDef[] = keys.map((key, index) => ({
    key,
    label: key,
    color: CHOICE_COLORS[index % CHOICE_COLORS.length] ?? "#64748b",
  }));
  const points: ChartPoint[] = series.map((point) => ({
    t: point.t,
    values: Object.fromEntries(keys.map((key) => [key, point.choices[key] ?? 0])),
  }));
  return (
    <ChartErrorBoundary label="Choice chart">
      <SeriesChart
        title="Choices"
        bucket={bucket}
        points={points}
        series={palette}
        ariaLabel="Choice distribution over time"
        empty="No choice data in this range."
      />
    </ChartErrorBoundary>
  );
}

function HistogramSvg({
  bins,
  threshold,
  showThreshold,
  ariaLabel,
}: {
  bins: ClassificationHistogram["bins"];
  threshold: number;
  showThreshold: boolean;
  ariaLabel: string;
}) {
  const { ref, width } = useChartWidth();
  const height = CHART_HEIGHT;
  const plotW = Math.max(1, width - PAD.l - PAD.r);
  const plotH = height - PAD.t - PAD.b;
  const ordered = bins.toSorted((a, b) => a.start - b.start);
  const domainStart = ordered[0]?.start ?? 0;
  const domainEnd = ordered[ordered.length - 1]?.end ?? 1;
  const span = domainEnd - domainStart || 1;
  const max = niceMax(Math.max(...ordered.map((bin) => Math.max(0, bin.count)), 0));
  const xFor = (value: number) => PAD.l + ((value - domainStart) / span) * plotW;
  const markerIndex = thresholdBinIndex(ordered, threshold);
  const marker = markerIndex >= 0 ? ordered[markerIndex]!.start : threshold;
  const markerX = xFor(marker);
  const ticks = 4;

  return (
    <div ref={ref} className="w-full h-full">
      <svg width={width} height={height} className="block" role="img" aria-label={ariaLabel}>
        {Array.from({ length: ticks + 1 }, (_, index) => {
          const y = PAD.t + (plotH * index) / ticks;
          const value = max * (1 - index / ticks);
          return (
            <g key={index}>
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
                {formatAxis(value)}
              </text>
            </g>
          );
        })}
        {ordered.map((bin) => {
          const barH = max > 0 ? (Math.max(0, bin.count) / max) * plotH : 0;
          if (barH <= 0) return null;
          const x = xFor(bin.start);
          const barW = Math.max(1, xFor(bin.end) - x - 1);
          return (
            <rect
              key={`${bin.start}-${bin.end}`}
              x={x}
              y={PAD.t + plotH - barH}
              width={barW}
              height={barH}
              fill="#a8a29e"
            >
              <title>{`${bin.start}–${bin.end}: ${bin.count}`}</title>
            </rect>
          );
        })}
        {showThreshold && markerX >= PAD.l && markerX <= PAD.l + plotW && (
          <line
            x1={markerX}
            y1={PAD.t}
            x2={markerX}
            y2={PAD.t + plotH}
            stroke="#f59e0b"
            strokeDasharray="3 3"
            strokeWidth={1.5}
          />
        )}
        {ordered.map((bin, index) => {
          if (ordered.length > 8 && index % 2 !== 0 && index !== ordered.length - 1) return null;
          return (
            <text
              key={`x-${bin.start}`}
              x={xFor(bin.start)}
              y={PAD.t + plotH + 16}
              textAnchor="middle"
              fontSize={10}
              className="fill-stone-400 dark:fill-stone-500"
            >
              {bin.start.toFixed(1)}
            </text>
          );
        })}
      </svg>
    </div>
  );
}

export function ProbabilityHistogram({
  title,
  histogram,
  threshold,
  showThreshold = false,
}: {
  title: string;
  histogram: ClassificationHistogram;
  threshold: number;
  showThreshold?: boolean;
}) {
  return (
    <ChartErrorBoundary label={title}>
      <ChartPanel title={title}>
        {showThreshold ? (
          <div className="flex items-center gap-1.5 px-4 pb-2 text-[11px] text-amber-600 dark:text-amber-400">
            <span className="w-3 border-t border-dashed border-amber-500" aria-hidden />
            {PROBABILITY_THRESHOLD_LABEL}
          </div>
        ) : null}
        <div className="px-2 sm:px-3" style={{ height: CHART_HEIGHT }}>
          {histogram.bins.length === 0 ? (
            <ChartMessage>No probability samples.</ChartMessage>
          ) : (
            <HistogramSvg
              bins={histogram.bins}
              threshold={threshold}
              showThreshold={showThreshold}
              ariaLabel={title}
            />
          )}
        </div>
        {histogram.missing > 0 ? (
          <p className="px-4 pb-3 text-[11px] text-stone-400 dark:text-stone-500">
            {histogram.missing.toLocaleString("en-US")} missing
          </p>
        ) : (
          <div className="pb-2" />
        )}
      </ChartPanel>
    </ChartErrorBoundary>
  );
}
