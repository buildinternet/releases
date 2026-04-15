/**
 * `releases admin embed ...` — drives the semantic-search backfill.
 *
 * The CLI is a thin wrapper around the admin endpoints in
 * `workers/api/src/routes/admin-embed.ts`. Each POST caps at 50 rows per call
 * so the worker stays well under its CPU budget; the CLI loops until the
 * endpoint reports `remaining === 0` or the user-supplied `--limit` is hit.
 *
 * Remote-mode only — Vectorize bindings are Worker-scoped, so there is no
 * "just run it locally" path. Running without RELEASED_API_URL aborts with a
 * clear message.
 */

import { Command } from "commander";
import chalk from "chalk";
import { logger } from "@releases/lib/logger";
import { isRemoteMode } from "../../../lib/mode.js";
import {
  embedReleases,
  embedEntities,
  embedChangelogs,
  getEmbedStatus,
  type EmbedBackfillResponse,
} from "../../../api/client.js";

/** Worker batch cap — must stay in sync with BATCH_CAP in admin-embed.ts. */
const ENDPOINT_BATCH_CAP = 50;

function requireRemote(): void {
  if (!isRemoteMode()) {
    logger.error(
      "Semantic search backfill requires remote mode — set RELEASED_API_URL or use the compiled binary.",
    );
    process.exit(1);
  }
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

  while (summary.totalProcessed < userLimit) {
    const remainingUserBudget = userLimit - summary.totalProcessed;
    const perCallLimit = Math.min(ENDPOINT_BATCH_CAP, remainingUserBudget);

    let result: EmbedBackfillResponse;
    try {
      result = await callEndpoint(perCallLimit);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (opts.json) {
        console.log(
          JSON.stringify({ ok: false, label, error: msg, ...summary }, null, 2),
        );
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

    // Exit conditions:
    // 1. Nothing left to process on the server (remaining === 0 AND we got 0
    //    new rows back — the latter protects against the edge case where
    //    `remaining` is lagging).
    // 2. The server returned fewer rows than we asked for (backlog drained).
    // 3. Dry run — one call is enough to report what would happen.
    if (dryRun) break;
    if (result.processed === 0) break;
    if (result.remaining === 0) break;
  }

  return summary;
}

function printSummary(label: string, summary: LoopSummary, json: boolean): void {
  if (json) {
    console.log(JSON.stringify({ ok: true, label, ...summary }, null, 2));
    return;
  }
  console.log(
    `Done. Total: ${summary.totalProcessed} processed, ${summary.totalFailed} failed.`,
  );
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
  const embed = parent
    .command("embed")
    .description("Backfill semantic-search embeddings (remote mode only)")
    .addHelpText(
      "after",
      `
Examples:
  releases admin embed status                     Show total vs embedded counts
  releases admin embed releases                   Embed all unembedded releases
  releases admin embed releases --since 2026-01-01
  releases admin embed releases --limit 200 --json
  releases admin embed entities --kind org
  releases admin embed changelogs --source my-source
  releases admin embed releases --dry-run         Preview without writing`,
    );

  embed
    .command("releases")
    .description("Embed releases missing vectors (where embedded_at IS NULL)")
    .option("--since <iso>", "Only embed releases published on/after this date")
    .option("--limit <n>", "Max rows to process across all batches", (v) => parseInt(v, 10))
    .option("--dry-run", "Report what would be processed without writing")
    .option("--json", "Machine-readable JSON output")
    .action(async (opts: { since?: string; limit?: number; dryRun?: boolean; json?: boolean }) => {
      requireRemote();
      const summary = await runBackfillLoop(
        "releases",
        (limit) => embedReleases({ since: opts.since, limit, dryRun: opts.dryRun }),
        opts,
      );
      printSummary("releases", summary, opts.json === true);
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
        requireRemote();
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
        printSummary(label, summary, opts.json === true);
      },
    );

  embed
    .command("changelogs")
    .description("Chunk + embed CHANGELOG files that have unembedded chunks")
    .option("--source <slug>", "Restrict to a single source")
    .option("--limit <n>", "Max files to process across all batches", (v) => parseInt(v, 10))
    .option("--dry-run", "Report what would be processed without writing")
    .option("--json", "Machine-readable JSON output")
    .action(
      async (opts: { source?: string; limit?: number; dryRun?: boolean; json?: boolean }) => {
        requireRemote();
        const summary = await runBackfillLoop(
          "changelogs",
          (limit) =>
            embedChangelogs({ sourceSlug: opts.source, limit, dryRun: opts.dryRun }),
          opts,
        );
        printSummary("changelogs", summary, opts.json === true);
      },
    );

  embed
    .command("status")
    .description("Show counts of embedded vs unembedded rows")
    .option("--json", "Machine-readable JSON output")
    .action(async (opts: { json?: boolean }) => {
      requireRemote();
      let status;
      try {
        status = await getEmbedStatus();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.error(`Failed to fetch embed status: ${msg}`);
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }

      const fmt = (embedded: number, total: number) => {
        const pct = total === 0 ? 100 : Math.round((embedded / total) * 100);
        return `${embedded}/${total} (${pct}%)`;
      };

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
