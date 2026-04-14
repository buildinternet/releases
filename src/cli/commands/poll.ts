import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { findSource, listFeedSources, listScrapeSources, updateSource } from "../../db/queries.js";
import { getSourceMeta, updateSourceMeta, headCheckFeed } from "../../adapters/feed.js";
import type { ChangeStatus, SourceMetadata } from "../../adapters/feed.js";
import { timeAgo } from "../../lib/dates.js";
import { logger } from "../../lib/logger.js";
import { stripAnsi } from "../../lib/sanitize.js";
import type { Source } from "../../db/schema.js";

interface PollResult {
  name: string;
  slug: string;
  url: string;
  type: "feed" | "page";
  status: ChangeStatus;
  responseMs: number;
  lastFetchedAt: string | null;
}

async function pollSource(source: Source): Promise<PollResult | null> {
  const meta = getSourceMeta(source);

  // Feed sources: HEAD check on feed URL
  if (meta.feedUrl) {
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
      url: meta.feedUrl,
      type: "feed",
      status: result.status,
      responseMs: result.responseMs,
      lastFetchedAt: source.lastFetchedAt,
    };
  }

  // Scrape sources without feed: HEAD check on page URL
  if (source.type === "scrape") {
    // HEAD check on source page URL (same logic as feed, different stored keys)
    const result = await headCheckFeed(source.url, {
      etag: meta.pageEtag,
      lastModified: meta.pageLastModified,
      contentLength: meta.pageContentLength,
    });

    const metaUpdates: Partial<SourceMetadata> = {};
    if (result.etag) metaUpdates.pageEtag = result.etag;
    if (result.lastModified) metaUpdates.pageLastModified = result.lastModified;
    if (result.contentLength) metaUpdates.pageContentLength = result.contentLength;
    if (Object.keys(metaUpdates).length > 0) {
      await updateSourceMeta(source, metaUpdates);
    }

    // HEAD alone is unreliable for scrape sources (JS-rendered pages, static shells) — collect signal only
    logger.debug(`Poll ${source.slug} (page): ${result.status} (${result.responseMs}ms)`);

    return {
      name: source.name,
      slug: source.slug,
      url: source.url,
      type: "page",
      status: result.status,
      responseMs: result.responseMs,
      lastFetchedAt: source.lastFetchedAt,
    };
  }

  return null;
}

function statusLabel(status: ChangeStatus): string {
  switch (status) {
    case "changed": return chalk.yellow("changed");
    case "unchanged": return chalk.green("unchanged");
    case "unknown": return chalk.dim("unknown");
  }
}

function typeLabel(type: "feed" | "page"): string {
  return type === "feed" ? chalk.blue("feed") : chalk.magenta("page");
}

export function registerPollCommand(program: Command) {
  program
    .command("poll [slug]")
    .description("Check feed and scrape sources for upstream changes")
    .option("--json", "Output as JSON")
    .option("--changed", "Only show sources with detected changes")
    .option("--scrape-only", "Only poll scrape sources (page HEAD check)")
    .addHelpText("after", `
Examples:
  releases admin source poll                      Poll all feed and scrape sources
  releases admin source poll my-source            Poll a specific source
  releases admin source poll --changed            Show only sources with changes
  releases admin source poll --scrape-only        Poll only scrape sources
  releases admin source poll --json               Output as JSON`)
    .action(async (slug: string | undefined, opts: { json?: boolean; changed?: boolean; scrapeOnly?: boolean }) => {
      let sourcesToPoll: Source[];

      if (slug) {
        const source = await findSource(slug);
        if (!source) {
          console.error(`Source not found: ${slug}`);
          process.exit(1);
        }
        sourcesToPoll = [source];
      } else {
        const [feedSources, scrapeSources] = await Promise.all([
          opts.scrapeOnly ? Promise.resolve([]) : listFeedSources().then(r => r ?? []),
          listScrapeSources().then(r => r ?? []),
        ]);
        sourcesToPoll = [...feedSources, ...scrapeSources];
        if (sourcesToPoll.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log("No pollable sources found.");
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
          chalk.cyan("Type"),
          chalk.cyan("Status"),
          chalk.cyan("Response"),
          chalk.cyan("Last Fetch"),
        ],
      });

      for (const r of display) {
        table.push([
          stripAnsi(r.name),
          typeLabel(r.type),
          statusLabel(r.status),
          chalk.dim(`${r.responseMs}ms`),
          r.lastFetchedAt ? timeAgo(r.lastFetchedAt) : chalk.dim("never"),
        ]);
      }

      console.log(table.toString());

      const feedResults = results.filter((r) => r.type === "feed");
      const pageResults = results.filter((r) => r.type === "page");
      const changed = results.filter((r) => r.status === "changed").length;
      const unchanged = results.filter((r) => r.status === "unchanged").length;
      const unknown = results.filter((r) => r.status === "unknown").length;
      const parts = [`${results.length} polled`];
      if (feedResults.length > 0) parts.push(`${feedResults.length} feed`);
      if (pageResults.length > 0) parts.push(`${pageResults.length} page`);
      console.log(`\n${parts.join(", ")}: ${chalk.yellow(`${changed} changed`)}, ${chalk.green(`${unchanged} unchanged`)}, ${chalk.dim(`${unknown} unknown`)}`);
    });
}
