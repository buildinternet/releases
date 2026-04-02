import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { findSourceBySlug, listFeedSources, updateSource } from "../../db/queries.js";
import { getSourceMeta, updateSourceMeta, headCheckFeed } from "../../adapters/feed.js";
import type { ChangeStatus, SourceMetadata } from "../../adapters/feed.js";
import { timeAgo } from "../../lib/dates.js";
import { logger } from "../../lib/logger.js";
import { stripAnsi } from "../../lib/sanitize.js";
import type { Source } from "../../db/schema.js";

interface PollResult {
  name: string;
  slug: string;
  feedUrl: string;
  status: ChangeStatus;
  responseMs: number;
  lastFetchedAt: string | null;
}

async function pollSource(source: Source): Promise<PollResult | null> {
  const meta = getSourceMeta(source);
  if (!meta.feedUrl) return null;

  const result = await headCheckFeed(meta.feedUrl, {
    etag: meta.feedEtag,
    lastModified: meta.feedLastModified,
    contentLength: meta.feedContentLength,
  });

  const metaUpdates: Partial<SourceMetadata> = {};
  if (result.etag) metaUpdates.feedEtag = result.etag;
  if (result.lastModified) metaUpdates.feedLastModified = result.lastModified;
  if (result.contentLength) metaUpdates.feedContentLength = result.contentLength;
  if (Object.keys(metaUpdates).length > 0) {
    await updateSourceMeta(source, metaUpdates);
  }

  if (result.status === "changed" || result.status === "unknown") {
    await updateSource(source, { changeDetectedAt: new Date().toISOString() });
  }

  logger.debug(`Poll ${source.slug}: ${result.status} (${result.responseMs}ms)`);

  return {
    name: source.name,
    slug: source.slug,
    feedUrl: meta.feedUrl,
    status: result.status,
    responseMs: result.responseMs,
    lastFetchedAt: source.lastFetchedAt,
  };
}

function statusLabel(status: ChangeStatus): string {
  switch (status) {
    case "changed": return chalk.yellow("changed");
    case "unchanged": return chalk.green("unchanged");
    case "unknown": return chalk.dim("unknown");
  }
}

export function registerPollCommand(program: Command) {
  program
    .command("poll [slug]")
    .description("Check feed sources for upstream changes via HEAD requests")
    .option("--json", "Output as JSON")
    .option("--changed", "Only show sources with detected changes")
    .addHelpText("after", `
Examples:
  released poll                      Poll all feed sources
  released poll my-source            Poll a specific source
  released poll --changed            Show only sources with changes
  released poll --json               Output as JSON`)
    .action(async (slug: string | undefined, opts: { json?: boolean; changed?: boolean }) => {
      let sourcesToPoll: Source[];

      if (slug) {
        const source = await findSourceBySlug(slug);
        if (!source) {
          console.error(`Source not found: ${slug}`);
          process.exit(1);
        }
        sourcesToPoll = [source];
      } else {
        sourcesToPoll = (await listFeedSources()) ?? [];
        if (sourcesToPoll.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log("No feed sources found.");
          }
          return;
        }
      }

      // Run polls with concurrency limit of 5
      const CONCURRENCY = 5;
      const results: PollResult[] = [];
      for (let i = 0; i < sourcesToPoll.length; i += CONCURRENCY) {
        const batch = sourcesToPoll.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(batch.map(pollSource));
        for (const r of batchResults) {
          if (r) results.push(r);
        }
      }

      // Filter to changed-only if requested
      const display = opts.changed
        ? results.filter((r) => r.status === "changed" || r.status === "unknown")
        : results;

      if (opts.json) {
        console.log(JSON.stringify(display, null, 2));
        return;
      }

      if (display.length === 0) {
        console.log("No changes detected.");
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan("Source"),
          chalk.cyan("Status"),
          chalk.cyan("Response"),
          chalk.cyan("Last Fetch"),
        ],
      });

      for (const r of display) {
        table.push([
          stripAnsi(r.name),
          statusLabel(r.status),
          chalk.dim(`${r.responseMs}ms`),
          r.lastFetchedAt ? timeAgo(r.lastFetchedAt) : chalk.dim("never"),
        ]);
      }

      console.log(table.toString());

      const changed = results.filter((r) => r.status === "changed").length;
      const unchanged = results.filter((r) => r.status === "unchanged").length;
      const unknown = results.filter((r) => r.status === "unknown").length;
      console.log(`\n${results.length} polled: ${chalk.yellow(`${changed} changed`)}, ${chalk.green(`${unchanged} unchanged`)}, ${chalk.dim(`${unknown} unknown`)}`);
    });
}
