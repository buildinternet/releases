import { Command } from "commander";
import chalk from "chalk";
import Table from "cli-table3";
import { getDb } from "../../db/connection.js";
import { sources } from "../../db/schema.js";
import { findSourceBySlug } from "../../db/queries.js";
import { timeAgo } from "../../lib/dates.js";
import type { Source } from "../../db/schema.js";

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
    const res = await fetch(url, { method: "HEAD", signal: controller.signal, redirect: "follow" });
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

async function checkSource(source: Source): Promise<CheckResult> {
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
    .command("check [slug]")
    .description("Check health and availability of changelog sources")
    .option("--json", "Output as JSON")
    .action(async (slug: string | undefined, opts: { json?: boolean }) => {
      const db = getDb();
      let sourcesToCheck: Source[];

      if (slug) {
        const source = await findSourceBySlug(slug);
        if (!source) {
          console.error(`Source not found: ${slug}`);
          process.exit(1);
        }
        sourcesToCheck = [source];
      } else {
        sourcesToCheck = await db.select().from(sources);
        if (sourcesToCheck.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log("No sources configured.");
          }
          return;
        }
      }

      const results = await Promise.all(sourcesToCheck.map(checkSource));

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
        return;
      }

      const table = new Table({
        head: [
          chalk.cyan("Name"),
          chalk.cyan("Type"),
          chalk.cyan("Status"),
          chalk.cyan("Response (ms)"),
          chalk.cyan("Health"),
          chalk.cyan("Last Fetch"),
        ],
      });

      for (const r of results) {
        table.push([
          r.name,
          r.type,
          statusLabel(r.httpStatus),
          String(r.responseMs),
          healthLabel(r.health),
          r.timeAgoLastFetch ?? chalk.dim("never"),
        ]);

        if (r.feedUrl) {
          table.push([
            chalk.dim(`  feed: ${r.feedUrl}`),
            chalk.dim("feed"),
            statusLabel(r.feedHttpStatus ?? null),
            String(r.feedResponseMs ?? 0),
            healthLabel(r.feedHealth ?? "error"),
            "",
          ]);
        }
      }

      console.log(table.toString());
    });
}
