import { Command } from "commander";
import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import { findSource, reextractSource } from "../../api/sources.js";
import { sourceNotFound } from "../suggest.js";
import { writeJson } from "../../lib/output.js";
import { parsePositiveIntFlag } from "../../lib/flags.js";
import { renderBackfillReport } from "./backfill-report.js";

type ReextractOpts = {
  snapshotId?: string;
  maxWindows?: string;
  dryRun?: boolean; // commander: defaults to true; `--no-dry-run` sets false
  commit?: boolean; // alias for --no-dry-run
  json?: boolean;
};

export async function reextractAction(identifier: string, opts: ReextractOpts): Promise<void> {
  // Either opt-in writes: `--no-dry-run` (commander sets dryRun:false) or `--commit`.
  const write = opts.dryRun === false || !!opts.commit;
  const dryRun = !write;
  const maxWindows = parsePositiveIntFlag("max-windows", opts.maxWindows);
  const snapshotId = opts.snapshotId?.trim() || undefined;

  // Resolve to the typed src_… ID first — the endpoint rejects bare slugs
  // (#690), same as backfill.
  const src = await findSource(identifier);
  if (!src) return sourceNotFound(identifier);

  let report;
  try {
    report = await reextractSource({ sourceId: src.id, snapshotId, maxWindows, dryRun });
  } catch (err) {
    // apiFetch embeds the endpoint's actionable message (bare_slug_rejected,
    // non-scrape 400, no_snapshot/snapshot_not_found 404, snapshot_expired 410,
    // RAW_SNAPSHOTS/ANTHROPIC key 503).
    logger.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  if (opts.json) return writeJson(report);
  renderBackfillReport(report);
}

export function registerReextractCommand(program: Command) {
  program
    .command("reextract")
    .description(
      "Re-extract releases from a stored raw snapshot (no live scrape, no Firecrawl credits)",
    )
    .argument("<identifier>", "Source ID (src_…) or slug")
    .option(
      "--snapshot-id <id>",
      "Re-extract a specific snapshot (raw_…); omit for the latest by capture time",
    )
    .option("--max-windows <n>", "Max windows to walk back (endpoint clamps 1–200, default 50)")
    .option("--no-dry-run", "Actually write (default is a dry-run preview)")
    .option("--commit", "Alias for --no-dry-run")
    .option("--json", "Output the raw re-extract report as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin source reextract my-source                          Dry-run from the latest snapshot
  releases admin source reextract my-source --commit                 Write it
  releases admin source reextract my-source --snapshot-id raw_abc123 --commit
  releases admin source reextract my-source --max-windows 100 --json

Re-extract reads the captured body from R2 (released-raw) — use it after
extraction/parse logic improves to reprocess a source's history with no scrape.`,
    )
    .action(reextractAction);
}
