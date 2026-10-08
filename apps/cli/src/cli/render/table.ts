import chalk from "chalk";
import stringWidth from "string-width";
import { stripAnsi } from "../../lib/sanitize.js";

export interface ColumnSpec {
  label: string;
  noTruncate?: boolean;
  alignRight?: boolean;
}

export interface RenderTableInput {
  head: (string | ColumnSpec)[];
  rows: string[][];
  /**
   * Optional per-row continuation lines (TTY only). When `subRows[i]` is set,
   * a second line is printed under row `i`, indented to the start of column 1
   * (col-0 width + one delimiter). Dropped entirely in non-TTY/TSV output.
   */
  subRows?: (string | null | undefined)[];
  /** Print the uppercased header row. Default `true`. */
  showHeader?: boolean;
  maxWidth?: number;
  isTTY?: boolean;
}

const DELIM = "  ";
const DEFAULT_NON_TTY_WIDTH = 80;

function normalizeHead(head: (string | ColumnSpec)[]): ColumnSpec[] {
  return head.map((h) => (typeof h === "string" ? { label: h } : h));
}

function padRight(s: string, width: number): string {
  const pad = width - stringWidth(s);
  return pad > 0 ? s + " ".repeat(pad) : s;
}

function padLeft(s: string, width: number): string {
  const pad = width - stringWidth(s);
  return pad > 0 ? " ".repeat(pad) + s : s;
}

/**
 * Truncate to a visible width, appending an ellipsis. ANSI escape sequences
 * are stripped from the truncated output — preserving them across an arbitrary
 * cut point would require an ANSI-aware slicer (e.g. slice-ansi), and the
 * tradeoff isn't worth the dep for cells that already fall back to plain text
 * only when they overflow.
 */
function truncateToWidth(s: string, width: number): string {
  if (width <= 0) return "";
  if (stringWidth(s) <= width) return s;
  if (width === 1) return "…";
  let out = "";
  let used = 0;
  for (const ch of stripAnsi(s)) {
    const w = stringWidth(ch);
    if (used + w > width - 1) break;
    out += ch;
    used += w;
  }
  return out + "…";
}

function detectMaxWidth(override: number | undefined): number {
  if (typeof override === "number") return override;
  const env = process.env.COLUMNS;
  if (env) {
    const n = Number.parseInt(env, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  if (process.stdout && typeof process.stdout.columns === "number" && process.stdout.columns > 0) {
    return process.stdout.columns;
  }
  return DEFAULT_NON_TTY_WIDTH;
}

function detectIsTTY(override: boolean | undefined): boolean {
  if (typeof override === "boolean") return override;
  return Boolean(process.stdout?.isTTY);
}

function calculateColumnWidths(rows: string[][], cols: ColumnSpec[], maxWidth: number): number[] {
  const numCols = cols.length;
  const delimTotal = DELIM.length * (numCols - 1);
  const maxColWidths: number[] = Array.from({ length: numCols }, () => 0);
  const colWidths: number[] = Array.from({ length: numCols }, () => 0);

  for (const row of rows) {
    for (let c = 0; c < numCols; c++) {
      const w = stringWidth(row[c] ?? "");
      if (w > maxColWidths[c]) maxColWidths[c] = w;
      if (cols[c].noTruncate && w > colWidths[c]) colWidths[c] = w;
    }
  }

  const availWidth = (): number => {
    let used = delimTotal;
    for (let c = 0; c < numCols; c++) used += colWidths[c];
    return maxWidth - used;
  };
  const flexCount = (): number => {
    let n = 0;
    for (let c = 0; c < numCols; c++) if (colWidths[c] === 0) n++;
    return n;
  };

  // Pass 1: short flex columns claim their natural width when it fits under
  // the per-column share. Lets narrow columns "free up" budget for wider ones.
  if (availWidth() > 0) {
    const flex = flexCount();
    if (flex > 0) {
      const perColumn = Math.floor(availWidth() / flex);
      for (let c = 0; c < numCols; c++) {
        if (colWidths[c] === 0 && maxColWidths[c] < perColumn) {
          colWidths[c] = maxColWidths[c];
        }
      }
    }
  }

  // Pass 2: remaining flex columns split the rest equally; columns whose
  // natural width is still under that share take their natural width instead.
  const flexAfterPass1 = flexCount();
  if (flexAfterPass1 > 0) {
    const perColumn = Math.floor(availWidth() / flexAfterPass1);
    for (let c = 0; c < numCols; c++) {
      if (colWidths[c] === 0) {
        if (maxColWidths[c] < perColumn) {
          colWidths[c] = maxColWidths[c];
        } else if (perColumn > 0) {
          colWidths[c] = perColumn;
        }
      }
    }
  }

  // Pass 3: distribute any leftover budget left-to-right, capped by each
  // column's natural width — so we never pad past the actual content.
  let leftover = availWidth();
  for (let c = 0; c < numCols && leftover > 0; c++) {
    const room = maxColWidths[c] - colWidths[c];
    const toAdd = Math.min(room, leftover);
    colWidths[c] += toAdd;
    leftover -= toAdd;
  }

  return colWidths;
}

function renderTSV(rows: string[][]): string {
  return rows.map((r) => r.map((c) => stripAnsi(c)).join("\t")).join("\n");
}

function renderTTY(
  cols: ColumnSpec[],
  rows: string[][],
  maxWidth: number,
  opts: { showHeader: boolean; subRows?: (string | null | undefined)[] },
): string {
  const headerRow = cols.map((c) => chalk.cyan(c.label.toUpperCase()));
  const widthRows = opts.showHeader ? [headerRow, ...rows] : rows;
  const colWidths = calculateColumnWidths(widthRows, cols, maxWidth);
  const numCols = cols.length;
  const lastCol = numCols - 1;

  const renderRow = (row: string[]): string => {
    const parts: string[] = [];
    for (let c = 0; c < numCols; c++) {
      const cell = row[c] ?? "";
      const w = colWidths[c];
      const truncated =
        cols[c].noTruncate || stringWidth(cell) <= w ? cell : truncateToWidth(cell, w);
      // Skip right-padding the last column to avoid trailing whitespace; the
      // final replace() also strips it as a belt-and-braces guard.
      let rendered = truncated;
      if (cols[c].alignRight) rendered = padLeft(truncated, w);
      else if (c < lastCol) rendered = padRight(truncated, w);
      parts.push(rendered);
    }
    return parts.join(DELIM).replace(/\s+$/, "");
  };

  // Continuation lines indent to the start of column 1 (col-0 width + one delim).
  const subIndent = colWidths[0] + DELIM.length;
  const subWidth = Math.max(8, maxWidth - subIndent);

  const out: string[] = [];
  if (opts.showHeader) out.push(renderRow(headerRow));
  rows.forEach((row, i) => {
    out.push(renderRow(row));
    const sub = opts.subRows?.[i];
    if (sub) {
      const clipped = stringWidth(sub) <= subWidth ? sub : truncateToWidth(sub, subWidth);
      out.push(" ".repeat(subIndent) + clipped);
    }
  });
  return out.join("\n");
}

export function renderTable(input: RenderTableInput): string {
  const cols = normalizeHead(input.head);
  if (input.rows.length === 0) return "";
  const isTTY = detectIsTTY(input.isTTY);
  if (!isTTY) return renderTSV(input.rows);
  const maxWidth = detectMaxWidth(input.maxWidth);
  return renderTTY(cols, input.rows, maxWidth, {
    showHeader: input.showHeader ?? true,
    subRows: input.subRows,
  });
}
