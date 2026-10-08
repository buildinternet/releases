/**
 * `releases admin embed ...` — drives the semantic-search backfill.
 *
 * The CLI is a thin wrapper around the admin endpoints exposed by the
 * API worker. Each POST caps at 50 rows per call so the worker stays well
 * under its CPU budget; the CLI loops until the endpoint reports
 * `remaining === 0` or the user-supplied `--limit` is hit.
 */

import { Command } from "commander";
import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import {
  embedReleases,
  embedEntities,
  embedChangelogs,
  getEmbedStatus,
} from "../../../api/sources.js";
import type { EmbedBackfillResponse } from "../../../api/types.js";
import { writeJson } from "../../../lib/output.js";

/** Worker batch cap — must stay in sync with BATCH_CAP on the API worker. */
const ENDPOINT_BATCH_CAP = 50;

function fmt(embedded: number, total: number): string {
  const pct = total === 0 ? 100 : Math.round((embedded / total) * 100);
  return `${embedded}/${total} (${pct}%)`;
}

interface LoopOptions {
  json?: boolean;
  dryRun?: boolean;
  limit?: number;
}

interface LoopSummary {
  batches: number;
  totalProcessed: number;
  totalSucceeded: number;
  totalFailed: number;
  remaining: number;
  dryRun: boolean;
}

async function runBackfillLoop(
  label: string,
  callEndpoint: (perCallLimit: number) => Promise<EmbedBackfillResponse>,
  opts: LoopOptions,
): Promise<LoopSummary> {
  const userLimit = opts.limit && opts.limit > 0 ? opts.limit : Infinity;
  const dryRun = opts.dryRun === true;

  if (!opts.json) {
    console.log(chalk.bold(`Embedding ${label} (remote)...`));
    if (dryRun) console.log(chalk.dim("  --dry-run: no writes will be made"));
  }

  const summary: LoopSummary = {
    batches: 0,
    totalProcessed: 0,
    totalSucceeded: 0,
    totalFailed: 0,
    remaining: 0,
    dryRun,
  };

  // Paginated batches — each call depends on `remaining` from the previous response.
  while (summary.totalProcessed < userLimit) {
    const remainingUserBudget = userLimit - summary.totalProcessed;
    const perCallLimit = Math.min(ENDPOINT_BATCH_CAP, remainingUserBudget);

    let result: EmbedBackfillResponse;
    try {
      // eslint-disable-next-line no-await-in-loop
      result = await callEndpoint(perCallLimit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.json) {
        // eslint-disable-next-line no-await-in-loop
        await writeJson({ ok: false, label, error: msg, ...summary });
      } else {
        logger.error(`  Batch ${summary.batches + 1} failed: ${msg}`);
      }
      process.exit(1);
    }

    summary.batches += 1;
    summary.totalProcessed += result.processed;
    summary.totalSucceeded += result.succeeded;
    summary.totalFailed += result.failed;
    summary.remaining = result.remaining;

    if (!opts.json) {
      console.log(
        `  Batch ${summary.batches}: processed ${result.processed}, succeeded ${result.succeeded}, failed ${result.failed}, remaining ${result.remaining}`,
      );
    }

    if (dryRun) break;
    if (result.processed === 0) break;
    if (result.remaining === 0) break;
  }

  return summary;
}

async function printSummary(label: string, summary: LoopSummary, json: boolean): Promise<void> {
  if (json) {
    await writeJson({ ok: true, label, ...summary });
    return;
  }
  console.log(`Done. Total: ${summary.totalProcessed} processed, ${summary.totalFailed} failed.`);
  if (summary.remaining > 0) {
    console.log(
      chalk.dim(
        `  ${summary.remaining} remaining. Run again or use 'releases admin embed status' to check.`,
      ),
    );
  } else {
    console.log(chalk.dim("  Run 'releases admin embed status' to verify."));
  }
}

export function registerEmbedCommand(parent: Command): void {
  const embed = parent.command("embed").description("Backfill semantic-search embeddings");

  embed
    .command("releases")
    .description("Embed releases missing vectors")
    .option("--since <iso>", "Only embed releases published on/after this date")
    .option("--limit <n>", "Max rows to process across all batches", (v) => parseInt(v, 10))
    .option("--dry-run", "Report what would be processed without writing")
    .option("--json", "Machine-readable JSON output")
    .action(async (opts: { since?: string; limit?: number; dryRun?: boolean; json?: boolean }) => {
      const summary = await runBackfillLoop(
        "releases",
        (limit) => embedReleases({ since: opts.since, limit, dryRun: opts.dryRun }),
        opts,
      );
      await printSummary("releases", summary, opts.json === true);
    });

  embed
    .command("entities")
    .description("Embed orgs/products/sources missing vectors")
    .option("--kind <kind>", "Restrict to org|product|source")
    .option("--limit <n>", "Max rows to process across all batches", (v) => parseInt(v, 10))
    .option("--dry-run", "Report what would be processed without writing")
    .option("--json", "Machine-readable JSON output")
    .action(
      async (opts: {
        kind?: "org" | "product" | "source";
        limit?: number;
        dryRun?: boolean;
        json?: boolean;
      }) => {
        if (opts.kind && !["org", "product", "source"].includes(opts.kind)) {
          logger.error(`--kind must be one of: org, product, source (got "${opts.kind}")`);
          process.exit(1);
        }
        const label = opts.kind ? `entities (${opts.kind})` : "entities";
        const summary = await runBackfillLoop(
          label,
          (limit) => embedEntities({ kind: opts.kind, limit, dryRun: opts.dryRun }),
          opts,
        );
        await printSummary(label, summary, opts.json === true);
      },
    );

  embed
    .command("changelogs")
    .description("Chunk + embed CHANGELOG files that have unembedded chunks")
    .option("--source <slug>", "Restrict to a single source")
    .option("--limit <n>", "Max files to process across all batches", (v) => parseInt(v, 10))
    .option("--dry-run", "Report what would be processed without writing")
    .option("--json", "Machine-readable JSON output")
    .action(async (opts: { source?: string; limit?: number; dryRun?: boolean; json?: boolean }) => {
      const summary = await runBackfillLoop(
        "changelogs",
        (limit) => embedChangelogs({ sourceSlug: opts.source, limit, dryRun: opts.dryRun }),
        opts,
      );
      await printSummary("changelogs", summary, opts.json === true);
    });

  embed
    .command("status")
    .description("Show counts of embedded vs unembedded rows")
    .option("--json", "Machine-readable JSON output")
    .action(async (opts: { json?: boolean }) => {
      let status;
      try {
        status = await getEmbedStatus();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to fetch embed status: ${msg}`);
        process.exit(1);
      }

      if (opts.json) {
        await writeJson(status);
        return;
      }

      console.log(chalk.bold("Semantic search backfill status"));
      console.log("");
      console.log(`  Releases:  ${fmt(status.releases.embedded, status.releases.total)}`);
      console.log(`  Entities:  ${fmt(status.entities.embedded, status.entities.total)}`);
      console.log(
        chalk.dim(
          `    orgs:     ${fmt(status.entities.breakdown.org.embedded, status.entities.breakdown.org.total)}`,
        ),
      );
      console.log(
        chalk.dim(
          `    products: ${fmt(status.entities.breakdown.product.embedded, status.entities.breakdown.product.total)}`,
        ),
      );
      console.log(
        chalk.dim(
          `    sources:  ${fmt(status.entities.breakdown.source.embedded, status.entities.breakdown.source.total)}`,
        ),
      );
      console.log(`  Chunks:    ${fmt(status.chunks.embedded, status.chunks.total)}`);
    });
}
