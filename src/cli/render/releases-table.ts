import chalk from "chalk";
import Table from "cli-table3";
import type { LatestRelease } from "../../api/types.js";
import { stripAnsi } from "../../lib/sanitize.js";

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

export interface RenderOptions {
  /** Append a dimmed summary preview under each title (for tail/latest listings). */
  withSummary?: boolean;
}

export function renderLatestReleasesTable(rows: LatestRelease[], opts: RenderOptions = {}): string {
  const table = new Table({
    head: [
      chalk.cyan("ID"),
      chalk.cyan("Source"),
      chalk.cyan("Title"),
      chalk.cyan("Version"),
      chalk.cyan(opts.withSummary ? "Published At" : "Published"),
    ],
  });

  for (const row of rows) {
    const titleCell = opts.withSummary
      ? stripAnsi(row.title) +
        (row.contentSummary ? `\n${chalk.dim(truncate(row.contentSummary, 120))}` : "")
      : truncate(stripAnsi(row.title), 50);
    const publishedCell = opts.withSummary
      ? (row.publishedAt ?? "-")
      : (row.publishedAt?.slice(0, 10) ?? chalk.dim("—"));

    table.push([
      chalk.dim(row.id.slice(0, 12)),
      `${stripAnsi(row.sourceName)} ${chalk.dim(`(${row.sourceSlug})`)}`,
      titleCell,
      row.version ? stripAnsi(row.version) : opts.withSummary ? "-" : chalk.dim("—"),
      publishedCell,
    ]);
  }

  return table.toString();
}
