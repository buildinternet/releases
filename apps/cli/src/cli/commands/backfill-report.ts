import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import { type SourceBackfillReport } from "../../api/sources.js";

/** ISO timestamp → YYYY-MM-DD, or an em dash when the bound is null. */
export function shortDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : "—";
}

/**
 * Render a {@link SourceBackfillReport} to stderr — shared by the `backfill`
 * (#1285) and `reextract` (#1284) verbs, which return the identical shape. The
 * snapshot line only prints for re-extraction (`via: "snapshot"`); the Firecrawl
 * `guidance` hint only for capped Firecrawl backfills.
 */
export function renderBackfillReport(report: SourceBackfillReport): void {
  const dates = `${shortDate(report.dateRange.from)} … ${shortDate(report.dateRange.to)}`;

  if (report.dryRun) {
    // The whole point of a dry run is "is there content here we don't have?".
    // Omitted rather than guessed when the server predates the field.
    const missing = report.notStored == null ? "" : `, ${report.notStored} not yet stored`;
    logger.info(
      `dry run: ${report.windows} window(s), ${report.extracted} extracted → ${report.deduped} unique${missing}, ` +
        `dates ${dates}, via ${report.via} (nothing written)`,
    );
    logger.info(chalk.dim(`Re-run with --no-dry-run (or --commit) to write.`));
  } else {
    logger.info(
      chalk.green(
        // `?` not `0`: the commit path always sends a number, so a missing one
        // means something went wrong upstream — not that nothing was inserted.
        `backfilled ${report.inserted ?? "?"} release(s) (${report.deduped} submitted, ${report.found} seen) for ${report.source.slug}`,
      ),
    );
    logger.info(chalk.dim(`${report.windows} window(s), dates ${dates}, via ${report.via}`));
  }

  if (report.snapshot) {
    logger.info(
      chalk.dim(
        `snapshot ${report.snapshot.id} captured ${shortDate(report.snapshot.capturedAt)} ` +
          `(${report.snapshot.bytes.toLocaleString()} bytes, ${report.snapshot.format})`,
      ),
    );
  }

  // The route-supplied Firecrawl-ceiling hint is the more specific message —
  // prefer it over the generic "raise --max-windows" note (which doesn't help
  // on the Firecrawl path, where the ceiling clamps regardless).
  if (report.guidance) {
    logger.warn(chalk.yellow(report.guidance));
  } else if (report.cappedAtWindow || report.droppedChars > 0) {
    const reason = report.cappedAtWindow
      ? `hit the ${report.windows}-window cap`
      : "dropped the oldest window(s)";
    logger.warn(
      chalk.yellow(
        `Backfill ${reason}: ~${report.droppedChars.toLocaleString()} chars of older history were not ` +
          `extracted. Raise --max-windows (endpoint max 200) to reach further back.`,
      ),
    );
  }
}
