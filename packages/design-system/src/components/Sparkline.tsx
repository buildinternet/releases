/** Inline SVG sparkline — smooth line chart for tabular data. */

const DEFAULT_WIDTH = 80;
const DEFAULT_HEIGHT = 24;
const PADDING_Y = 3;
const DOT_RADIUS = 2.5;

/** Sparkline — inline SVG smooth line chart for tabular data. */
export interface SparklineProps {
  data: number[];
  /** Unique id used to scope the SVG gradient (`spark-${id}`). */
  id: string;
  width?: number;
  height?: number;
  color?: string;
  className?: string;
}

/** Sparkline — inline SVG smooth line chart for tabular data. @category Data */
export function Sparkline({
  data,
  id,
  width = DEFAULT_WIDTH,
  height = DEFAULT_HEIGHT,
  color = "currentColor",
  className,
}: SparklineProps) {
  const gradientId = `spark-${id}`;

  if (data.every((v) => v === 0)) {
    return (
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        className={className}
        aria-hidden="true"
      >
        <line
          x1={0}
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="currentColor"
          strokeWidth={1}
          opacity={0.15}
        />
      </svg>
    );
  }

  const max = Math.max(...data);
  const usableHeight = height - PADDING_Y * 2;
  const step = width / (data.length - 1);

  const points = data.map((v, i) => {
    const x = i * step;
    const y = PADDING_Y + usableHeight - (max > 0 ? (v / max) * usableHeight : 0);
    return { x, y };
  });

  const d = buildMonotonePath(points);
  const last = points[points.length - 1];

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity={0.12} />
          <stop offset="100%" stopColor={color} stopOpacity={0} />
        </linearGradient>
      </defs>
      <path d={`${d}L${last.x},${height}L${points[0].x},${height}Z`} fill={`url(#${gradientId})`} />
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx={last.x} cy={last.y} r={DOT_RADIUS} fill={color} />
    </svg>
  );
}

/** Monotone cubic Hermite interpolation — prevents overshooting between points. */
function buildMonotonePath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return `M${points[0].x},${points[0].y}`;

  const n = points.length;
  const dx: number[] = [];
  const dy: number[] = [];
  const m: number[] = [];

  for (let i = 0; i < n - 1; i++) {
    dx.push(points[i + 1].x - points[i].x);
    dy.push(points[i + 1].y - points[i].y);
    m.push(dy[i] / dx[i]);
  }

  const tangents: number[] = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    if (m[i - 1] * m[i] <= 0) {
      tangents.push(0);
    } else {
      tangents.push(
        (3 * (dx[i - 1] + dx[i])) /
          ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]),
      );
    }
  }
  tangents.push(m[n - 2]);

  let path = `M${points[0].x},${points[0].y}`;
  for (let i = 0; i < n - 1; i++) {
    const p0 = points[i];
    const p1 = points[i + 1];
    const d = dx[i] / 3;
    path += `C${p0.x + d},${p0.y + tangents[i] * d},${p1.x - d},${p1.y - tangents[i + 1] * d},${p1.x},${p1.y}`;
  }

  return path;
}
