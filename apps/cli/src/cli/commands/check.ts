import { Command } from "commander";
import chalk from "chalk";
import { renderTable } from "../render/table.js";
import { findSource, listSourcesWithOrg } from "../../api/sources.js";
import { timeAgo } from "@buildinternet/releases-core/dates";
import { stripAnsi } from "../../lib/sanitize.js";
import { writeJson } from "../../lib/output.js";
import { RELEASES_CLI_UA } from "../../lib/user-agent.js";

interface SourceLite {
  name: string;
  slug: string;
  type: string;
  url: string;
  metadata: string | null;
  lastFetchedAt: string | null;
}

interface CheckResult {
  name: string;
  slug: string;
  type: string;
  url: string;
  httpStatus: number | null;
  responseMs: number;
  health: "healthy" | "degraded" | "error";
  lastFetchedAt: string | null;
  timeAgoLastFetch: string | null;
  feedUrl?: string;
  feedHttpStatus?: number | null;
  feedResponseMs?: number;
  feedHealth?: "healthy" | "degraded" | "error";
}

async function probe(url: string): Promise<{ status: number | null; ms: number }> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const start = Date.now();
  try {
    const res = await fetch(url, {
      method: "HEAD",
      headers: { "User-Agent": RELEASES_CLI_UA },
      signal: controller.signal,
      redirect: "follow",
    });
    const ms = Date.now() - start;
    return { status: res.status, ms };
  } catch {
    return { status: null, ms: Date.now() - start };
  } finally {
    clearTimeout(timeout);
  }
}

function classify(status: number | null, ms: number): "healthy" | "degraded" | "error" {
  if (status === null) return "error";
  if (status >= 400) return "error";
  if (status >= 300 || ms > 5000) return "degraded";
  return "healthy";
}

function healthLabel(h: "healthy" | "degraded" | "error"): string {
  if (h === "healthy") return chalk.green("healthy");
  if (h === "degraded") return chalk.yellow("degraded");
  return chalk.red("error");
}

function statusLabel(status: number | null): string {
  if (status === null) return chalk.red("unreachable");
  if (status >= 400) return chalk.red(String(status));
  if (status >= 300) return chalk.yellow(String(status));
  return chalk.green(String(status));
}

async function checkSource(source: SourceLite): Promise<CheckResult> {
  const meta = source.metadata ? JSON.parse(source.metadata) : {};
  const feedUrl: string | undefined = meta.feedUrl;

  const [main, feedResult] = await Promise.all([
    probe(source.url),
    feedUrl ? probe(feedUrl) : Promise.resolve(null),
  ]);

  const health = classify(main.status, main.ms);
  const result: CheckResult = {
    name: source.name,
    slug: source.slug,
    type: source.type,
    url: source.url,
    httpStatus: main.status,
    responseMs: main.ms,
    health,
    lastFetchedAt: source.lastFetchedAt,
    timeAgoLastFetch: timeAgo(source.lastFetchedAt),
  };

  if (feedUrl && feedResult) {
    result.feedUrl = feedUrl;
    result.feedHttpStatus = feedResult.status;
    result.feedResponseMs = feedResult.ms;
    result.feedHealth = classify(feedResult.status, feedResult.ms);
  }

  return result;
}

export function registerCheckCommand(program: Command) {
  program
    .command("check [source]")
    .description("Check health and availability of changelog sources (accepts src_… or slug)")
    .option("--json", "Output as JSON")
    .action(async (identifier: string | undefined, opts: { json?: boolean }) => {
      let sourcesToCheck: SourceLite[];

      if (identifier) {
        const source = await findSource(identifier);
        if (!source) {
          console.error(`Source not found: ${identifier}`);
          process.exit(1);
        }
        sourcesToCheck = [
          {
            name: source.name,
            slug: source.slug,
            type: source.type,
            url: source.url,
            metadata: source.metadata,
            lastFetchedAt: source.lastFetchedAt,
          },
        ];
      } else {
        const rows = await listSourcesWithOrg();
        sourcesToCheck = rows.map((r) => ({
          name: r.name,
          slug: r.slug,
          type: r.type,
          url: r.url,
          metadata: r.metadata,
          lastFetchedAt: r.lastFetchedAt,
        }));
        if (sourcesToCheck.length === 0) {
          if (opts.json) await writeJson([]);
          else console.log("No sources configured.");
          return;
        }
      }

      const results = await Promise.all(sourcesToCheck.map(checkSource));

      if (opts.json) {
        await writeJson(results);
        return;
      }

      console.log(
        renderTable({
          head: [
            { label: "Name" },
            { label: "Type", noTruncate: true },
            { label: "Status", noTruncate: true },
            { label: "Response (ms)", noTruncate: true, alignRight: true },
            { label: "Health", noTruncate: true },
            { label: "Last Fetch", noTruncate: true },
          ],
          // Each result expands to one row, plus a second indented row when a
          // feed URL was probed alongside the main URL.
          rows: results.flatMap((r) => {
            const main = [
              stripAnsi(r.name),
              r.type,
              statusLabel(r.httpStatus),
              String(r.responseMs),
              healthLabel(r.health),
              r.timeAgoLastFetch ?? chalk.dim("never"),
            ];
            if (!r.feedUrl) return [main];
            return [
              main,
              [
                chalk.dim(`  feed: ${stripAnsi(r.feedUrl)}`),
                chalk.dim("feed"),
                statusLabel(r.feedHttpStatus ?? null),
                String(r.feedResponseMs ?? 0),
                healthLabel(r.feedHealth ?? "error"),
                "",
              ],
            ];
          }),
        }),
      );
    });
}
