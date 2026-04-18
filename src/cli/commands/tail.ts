import { Command } from "commander";
import chalk from "chalk";
import { findOrg, findSource, getLatestReleases } from "../../db/queries.js";
import type { LatestRelease } from "../../api/types.js";
import { orgNotFound, sourceNotFound } from "../suggest.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { renderLatestReleasesTable } from "../render/releases-table.js";

function renderStreamLine(row: LatestRelease): string {
  const version = row.version ? chalk.yellow(stripAnsi(row.version)) : "";
  const when = row.publishedAt ? chalk.dim(row.publishedAt) : chalk.dim("(no date)");
  const src = `${chalk.cyan(stripAnsi(row.sourceName))} ${chalk.dim(`(${row.sourceSlug})`)}`;
  const title = stripAnsi(row.title);
  const id = chalk.dim(row.id.slice(0, 12));
  return `${when}  ${src}  ${version ? version + "  " : ""}${title}  ${id}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Cap the seen-id set so a long-running follow loop can't grow unbounded.
const SEEN_CAP = 500;

function rememberSeen(seen: Set<string>, ids: string[]): void {
  for (const id of ids) seen.add(id);
  if (seen.size <= SEEN_CAP) return;
  // Drop oldest insertions until back under cap (insertion order is preserved).
  const drop = seen.size - SEEN_CAP;
  let i = 0;
  for (const id of seen) {
    if (i++ >= drop) break;
    seen.delete(id);
  }
}

export function registerTailCommand(program: Command) {
  program
    .command("tail")
    .alias("latest")
    .description("Show the latest releases, optionally tailing a live feed")
    .argument("[slug]", "Source slug to filter by")
    .option("-c, --count <n>", "Number of releases to show", "10")
    .option("--org <identifier>", "Filter to an organization")
    .option("--include-coverage", "Include releases that are coverage of another (hidden by default)")
    .option("-f, --follow", "Poll for new releases and stream them as they arrive")
    .option("--interval <seconds>", "Poll interval in seconds when following (min 5)", "60")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases tail                         Latest releases across all sources
  releases tail my-source               Latest releases from one source
  releases tail --org acme --count 20   Latest 20 releases from an org
  releases tail -f                      Follow new releases as they arrive (60s interval)
  releases tail -f --interval 30        Follow with a 30s poll interval
  releases tail --json                  Output as JSON
  releases latest                       Alias for the one-shot listing`)
    .action(async (
      slug: string | undefined,
      opts: {
        count: string;
        org?: string;
        includeCoverage?: boolean;
        follow?: boolean;
        interval: string;
        json?: boolean;
      },
    ) => {
      const count = parseInt(opts.count, 10);
      const intervalSeconds = Math.max(5, parseInt(opts.interval, 10) || 60);

      if (slug) {
        const source = await findSource(slug);
        if (!source) return sourceNotFound(slug);
      }

      let orgSlug: string | undefined;
      if (opts.org) {
        const org = await findOrg(opts.org);
        if (!org) return orgNotFound(opts.org);
        orgSlug = org.slug;
      }

      const fetchOpts = { slug, orgSlug, count, includeCoverage: opts.includeCoverage };
      const rows = await getLatestReleases(fetchOpts);

      if (opts.json) {
        console.log(JSON.stringify(rows, null, 2));
      } else if (rows.length === 0) {
        console.log(chalk.yellow("No releases found."));
      } else if (opts.follow) {
        for (const row of rows.slice().reverse()) {
          console.log(renderStreamLine(row));
        }
      } else {
        console.log(renderLatestReleasesTable(rows, { withSummary: true }));
        console.log(
          chalk.dim(
            `\n  More: "releases show <rel_id>" for full content · "releases tail <source-slug>" to filter by source`,
          ),
        );
      }

      if (!opts.follow) return;

      // Follow mode polls the same unfiltered request each tick so the response
      // collapses onto the shared KV cache key — a server-side `since` filter
      // would fork the cache and defeat the point. De-dupe via seen-id set.
      const seen = new Set<string>();
      rememberSeen(seen, rows.map((r) => r.id));
      console.error(
        chalk.dim(`\n  Following (every ${intervalSeconds}s). Ctrl-C to stop.`),
      );

      while (true) {
        await sleep(intervalSeconds * 1000);
        const fresh = await getLatestReleases(fetchOpts);
        const novel = fresh.filter((r) => !seen.has(r.id));
        if (novel.length === 0) continue;

        rememberSeen(seen, novel.map((r) => r.id));
        const ordered = novel.slice().reverse();
        if (opts.json) {
          for (const row of ordered) console.log(JSON.stringify(row));
        } else {
          for (const row of ordered) console.log(renderStreamLine(row));
        }
      }
    });
}
