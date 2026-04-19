import { Command } from "commander";
import chalk from "chalk";
import { findOrg, findSource, getLatestReleases } from "../../db/queries.js";
import type { LatestRelease } from "../../api/types.js";
import { orgNotFound, sourceNotFound } from "../suggest.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { renderLatestReleasesTable } from "../render/releases-table.js";
import { streamReleases } from "../../api/stream.js";
import { getApiUrl, isRemoteMode } from "../../lib/mode.js";

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

function streamUrl(): string | null {
  if (!isRemoteMode()) return null;
  const http = getApiUrl();
  const ws = http.replace(/^http:/, "ws:").replace(/^https:/, "wss:");
  return `${ws}/v1/releases/stream`;
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
        for (const row of rows.slice().toReversed()) {
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

      const seen = new Set<string>();
      rememberSeen(seen, rows.map((r) => r.id));

      // Try live streaming first in remote mode. On snapshot_gap or transport
      // failure, fall through to polling using the same seen-id dedup set so
      // transport transitions don't double-print.
      const wsUrl = streamUrl();
      const streamed = wsUrl
        ? await tryStream(wsUrl, fetchOpts, seen, opts.json === true)
        : false;

      if (!streamed) {
        console.error(
          chalk.dim(`\n  Following (every ${intervalSeconds}s). Ctrl-C to stop.`),
        );
        while (true) {
          await sleep(intervalSeconds * 1000);
          const fresh = await getLatestReleases(fetchOpts);
          const novel = fresh.filter((r) => !seen.has(r.id));
          if (novel.length === 0) continue;

          rememberSeen(seen, novel.map((r) => r.id));
          const ordered = novel.slice().toReversed();
          if (opts.json) {
            for (const row of ordered) console.log(JSON.stringify(row));
          } else {
            for (const row of ordered) console.log(renderStreamLine(row));
          }
        }
      }
    });
}

/**
 * Stream live events. Returns false when streaming couldn't proceed (the caller
 * should fall back to polling) and true when the server closed the stream
 * cleanly after delivering its handshake (no fallback needed). The generator
 * otherwise blocks forever until the process is signalled.
 *
 * Fall-through cases:
 *   - `--org` filtering is active — the event payload doesn't carry orgSlug,
 *     so we can't apply the filter client-side. Bail immediately.
 *   - Server emits `snapshot_gap` — our seq cursor fell behind the buffer.
 *   - Transport throws (DNS, TLS, refused connection, malformed frame, etc).
 */
async function tryStream(
  url: string,
  fetchOpts: {
    slug?: string;
    orgSlug?: string;
    count: number;
    includeCoverage?: boolean;
  },
  seen: Set<string>,
  asJson: boolean,
): Promise<boolean> {
  // --org can't be honored over the stream (event payload lacks orgSlug).
  // Bail immediately so the polling fallback — which does support --org —
  // handles this request without any events slipping into `seen`.
  if (fetchOpts.orgSlug) return false;

  console.error(chalk.dim(`\n  Streaming. Ctrl-C to stop.`));

  try {
    for await (const msg of streamReleases({ url })) {
      if (msg.type === "ready") continue;
      if (msg.type === "snapshot_gap") {
        console.error(chalk.yellow("  Stream fell behind — falling back to polling."));
        return false;
      }
      if (msg.type === "release.created") {
        if (seen.has(msg.release.id)) continue;
        if (fetchOpts.slug && msg.release.sourceSlug !== fetchOpts.slug) continue;
        rememberSeen(seen, [msg.release.id]);
        if (asJson) console.log(JSON.stringify(msg.release));
        else console.log(renderStreamLine(msg.release));
      }
    }
    return true;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    console.error(chalk.yellow(`  Stream error: ${reason}. Falling back to polling.`));
    return false;
  }
}
