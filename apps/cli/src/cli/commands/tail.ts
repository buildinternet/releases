import { Command } from "commander";
import chalk from "chalk";
import { findOrg } from "../../api/orgs.js";
import {
  getLatestReleases,
  getProductReleases,
  resolveProductFeedTarget,
} from "../../api/releases.js";
import { findSource } from "../../api/sources.js";
import type { LatestRelease } from "../../api/types.js";
import { orgNotFound, productNotFound, sourceNotFound } from "../suggest.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { sleep } from "../../lib/sleep.js";
import { renderReleaseRows } from "../render/releases-table.js";
import { slimLatest } from "../render/release-json.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson, writeJsonLine } from "../../lib/output.js";
import { applyFieldMask, parseFieldsFlag, projectFields } from "../../lib/fields.js";
import { parseTimeWindowFlag, parseImportanceFlag } from "../../lib/flags.js";

function renderStreamLine(row: LatestRelease): string {
  const version = row.version ? chalk.yellow(stripAnsi(row.version)) : "";
  const when = row.publishedAt ? chalk.dim(row.publishedAt) : chalk.dim("(no date)");
  const src = `${chalk.cyan(stripAnsi(row.sourceName))} ${chalk.dim(`(${row.sourceSlug})`)}`;
  const title = stripAnsi(row.title);
  const id = chalk.dim(row.id);
  return `${when}  ${src}  ${version ? version + "  " : ""}${title}  ${id}`;
}

// Cap the seen-id set so a long-running follow loop can't grow unbounded.
const SEEN_CAP = 500;

function rememberSeen(seen: Set<string>, ids: string[]): void {
  for (const id of ids) seen.add(id);
  if (seen.size <= SEEN_CAP) return;
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
    .argument("[source]", "Source ID (src_…) or slug to filter by")
    .option("-c, --count <n>", "Number of releases to show (1–100; alias --limit)", "10")
    .option("--limit <n>", "Alias for --count (number of releases to show, 1–100)")
    .option(
      "--org <identifier>",
      "Filter to an organization (org_…, slug, domain, name, or handle)",
    )
    .option(
      "--product <identifier>",
      "Show one product's cross-source feed (org/slug, prod_… id, or product slug). Not combinable with [source] or --org.",
    )
    .option(
      "--include-coverage",
      "Include releases that are coverage of another (hidden by default)",
    )
    .option(
      "--cursor <cursor>",
      "Page token for the next page (only with --product; the global feed is count-capped, not cursored)",
    )
    .option(
      "--since <when>",
      "Only releases published on/after this date. ISO (2026-01-01) or shorthand (90d, 4w, 6m, 2y).",
    )
    .option(
      "--until <when>",
      "Only releases published on/before this date. Same formats as --since.",
    )
    .option(
      "--min-importance <1-5>",
      "Only releases with an AI importance score at or above this value (1-5). Excludes unscored releases, which is most history.",
    )
    .option("-f, --follow", "Poll for new releases and stream them as they arrive")
    .option("--interval <seconds>", "Poll interval in seconds when following (min 5)", "60")
    .option("--json", "Output as JSON")
    .option("--full", "With --json, return the complete unprojected payload")
    .option(
      "--fields <list>",
      "With --json, project each row to a comma-separated field mask " +
        "(dot-notation for nested keys, e.g. id,version,source.slug). Composes with --full.",
    )
    .addHelpText(
      "after",
      `
Examples:
  releases tail                         Latest releases across all sources
  releases tail my-source               Latest releases from one source
  releases tail --org acme --count 20   Latest 20 releases from an org
  releases latest --org acme --limit 100   Up to 100 (--limit is an alias for --count)
  releases tail --product vercel/turborepo   One product's cross-source feed
  releases tail --since 30d             Releases from the last 30 days
  releases tail --min-importance 4      Only AI-scored high-importance releases
  releases tail -f                      Follow new releases as they arrive (60s interval)
  releases tail -f --interval 30        Follow with a 30s poll interval
  releases tail --json                  Output as JSON
  releases latest                       Alias for the one-shot listing`,
    )
    .action(
      async (
        sourceArg: string | undefined,
        opts: {
          count: string;
          limit?: string;
          org?: string;
          product?: string;
          includeCoverage?: boolean;
          cursor?: string;
          since?: string;
          until?: string;
          minImportance?: string;
          follow?: boolean;
          interval: string;
          json?: boolean;
          full?: boolean;
          fields?: string;
        },
      ) => {
        // `--limit` is an alias for `--count` (#304 — `--limit` is the form
        // callers reach for; the absence was the footgun). When both are given,
        // `--limit` wins. The server clamps to [1, 100]; mirror that locally so
        // the truncation hint below reflects what was actually requested.
        const MAX_COUNT = 100;
        const rawCount = opts.limit ?? opts.count;
        const parsedCount = Number(rawCount);
        if (!Number.isInteger(parsedCount) || parsedCount <= 0) {
          logger.error("--count/--limit must be a positive integer");
          process.exit(1);
        }
        const count = Math.min(parsedCount, MAX_COUNT);
        const intervalSeconds = Math.max(5, parseInt(opts.interval, 10) || 60);
        if (opts.full && !opts.json) logger.warn("--full only affects --json output; ignoring.");
        if (opts.fields && !opts.json)
          logger.warn("--fields only affects --json output; ignoring.");
        // Validate locally; the API resolves relative shorthand server-side.
        const since = parseTimeWindowFlag("since", opts.since);
        const until = parseTimeWindowFlag("until", opts.until);
        const minImportance = parseImportanceFlag(opts.minImportance);

        // --product switches to the product's cross-source feed
        // (GET /v1/orgs/:org/releases?product=…) — a different endpoint from the
        // global latest feed, so it can't combine with a [source] or --org filter.
        if (opts.product && (sourceArg || opts.org)) {
          logger.error("--product can't be combined with a [source] argument or --org.");
          process.exit(1);
        }

        // --cursor only applies to the cursor-paginated product feed; the global
        // latest feed is count-capped, not cursored. Fail loudly rather than
        // silently ignore a cursor the user expected to honor.
        if (opts.cursor && !opts.product) {
          logger.error("--cursor only applies with --product (the latest feed is not cursored).");
          process.exit(1);
        }
        if (opts.cursor && opts.follow) {
          logger.error("--cursor can't be combined with --follow.");
          process.exit(1);
        }

        if (sourceArg) {
          const source = await findSource(sourceArg);
          if (!source) return sourceNotFound(sourceArg);
        }

        let orgSlug: string | undefined;
        if (opts.org) {
          const org = await findOrg(opts.org);
          if (!org) return orgNotFound(opts.org);
          orgSlug = org.slug;
        }

        let productTarget: { orgRef: string; product: string } | null = null;
        if (opts.product) {
          productTarget = await resolveProductFeedTarget(opts.product);
          // org/slug coords aren't pre-validated here; a bad coord surfaces as a
          // null feed in fetchPage. prod_/bare-slug forms validate in the resolver.
          if (!productTarget) return productNotFound(opts.product);
        }

        const fetchOpts = {
          source: sourceArg,
          org: orgSlug,
          count,
          includeCoverage: opts.includeCoverage,
          since,
          until,
          minImportance,
        };

        // The product feed (GET /v1/orgs/:org/releases?product=…) is cursor-
        // paginated; capture the latest page's cursor so the one-shot path can
        // surface it. The global latest feed has no cursor (count-capped at 100).
        let productNextCursor: string | null = null;

        // One page of the active feed (global latest, or the product feed when
        // --product is set). Follow mode re-invokes this each tick.
        const fetchPage = async (): Promise<LatestRelease[]> => {
          if (!productTarget) return getLatestReleases(fetchOpts);
          const res = await getProductReleases({
            orgRef: productTarget.orgRef,
            product: productTarget.product,
            count,
            cursor: opts.cursor ?? null,
            includeCoverage: opts.includeCoverage,
            since,
            until,
            minImportance,
          });
          if (!res) return productNotFound(opts.product!);
          productNextCursor = res.nextCursor;
          return res.releases;
        };

        const rows = await fetchPage();

        if (opts.json) {
          await writeJson(
            applyFieldMask(
              rows.map((row) => slimLatest(row, opts.full === true)),
              opts.fields,
            ),
          );
        } else if (rows.length === 0) {
          console.log(chalk.yellow("No releases found."));
        } else if (opts.follow) {
          for (const row of rows.toReversed()) {
            console.log(renderStreamLine(row));
          }
        } else {
          console.log(renderReleaseRows(rows, { mode: "feed" }));
          console.log(
            chalk.dim(
              `\n  More: "releases get <rel_id>" for full content · "releases tail <source>" to filter by source (src_… or slug)`,
            ),
          );
        }

        // Truncation signal for the one-shot listing: when the page filled the
        // requested window there may be more. The global latest feed has no
        // cursor (raise --limit, max 100, or window with --since); the product
        // feed is cursor-paginated, so surface the opaque cursor. Goes to
        // stderr so it never corrupts --json stdout. #304
        if (!opts.follow && rows.length >= count) {
          if (productTarget && productNextCursor) {
            logger.warn(
              `More releases available. Next page: append \`--cursor ${productNextCursor}\`, ` +
                "or raise `--limit` (max 100).",
            );
          } else if (!productTarget && count >= 100) {
            logger.warn(
              "Hit the 100-release cap for the latest feed. Narrow with --since/--until, " +
                "--org, or a <source> argument to page through more.",
            );
          } else if (!productTarget) {
            logger.warn(
              `Showing ${count} release${count === 1 ? "" : "s"}; more may exist. ` +
                "Raise --limit (max 100) or window with --since/--until.",
            );
          }
        }

        if (!opts.follow) return;

        // Follow mode re-issues the same request each tick and de-dupes via the
        // seen-id set. The unfiltered default collapses onto the shared KV cache
        // key; a `--since`/`--until` window forks off it, but the API marks
        // windowed requests non-cacheable (BYPASS) so polling one is bounded —
        // and a relative bound (e.g. `30d`) re-anchors to "now" on each tick.
        const seen = new Set<string>();
        rememberSeen(
          seen,
          rows.map((r) => r.id),
        );
        console.error(chalk.dim(`\n  Following (every ${intervalSeconds}s). Ctrl-C to stop.`));

        // Polling loop — each tick depends on the previous sleep + fetch.
        while (true) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(intervalSeconds * 1000);
          // eslint-disable-next-line no-await-in-loop
          const fresh = await fetchPage();
          const novel = fresh.filter((r) => !seen.has(r.id));
          if (novel.length === 0) continue;

          rememberSeen(
            seen,
            novel.map((r) => r.id),
          );
          const ordered = novel.toReversed();
          if (opts.json) {
            // Preserve stream ordering; writes must land in order. Project per
            // row (no per-row warn — streaming) when a --fields mask is set.
            const maskFields = opts.fields ? parseFieldsFlag(opts.fields) : null;
            for (const row of ordered) {
              const slim = slimLatest(row, opts.full === true);
              // eslint-disable-next-line no-await-in-loop
              await writeJsonLine(maskFields ? projectFields(slim, maskFields).projected : slim);
            }
          } else {
            for (const row of ordered) console.log(renderStreamLine(row));
          }
        }
      },
    );
}
