import { Command } from "commander";
import chalk from "chalk";
import { createHash } from "crypto";
import { eq, count } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, releases, type Source } from "../../db/schema.js";
import type { Adapter, RawRelease, FetchOptions } from "../../adapters/types.js";
import { github } from "../../adapters/github.js";
import { scrape } from "../../adapters/scrape.js";
import { feed } from "../../adapters/feed.js";
import { logger } from "../../lib/logger.js";
import { elapsedSec } from "../../lib/dates.js";

function getAdapter(type: string): Adapter | null {
  switch (type) {
    case "github":
      return github;
    case "scrape":
      return scrape;
    case "feed":
      return feed;
    default:
      logger.warn(`Unknown adapter type "${type}", skipping.`);
      return null;
  }
}

function contentHash(raw: RawRelease): string {
  const input = raw.title + (raw.version || "") + (raw.publishedAt?.toISOString() || "") + raw.content;
  return createHash("sha256").update(input).digest("hex");
}

export function registerFetchCommand(program: Command) {
  program
    .command("fetch")
    .description("Fetch releases from configured sources")
    .argument("[slug]", "Fetch a specific source by slug, or all sources if omitted")
    .option("--json", "Output as JSON")
    .option("--since <date>", "Only fetch releases after this date (ISO 8601 or YYYY-MM-DD)")
    .option("--max <n>", "Maximum number of releases to fetch per source (default: 100)", "100")
    .option("--all", "Fetch all releases with no limits")
    .action(async (slug: string | undefined, opts: { json?: boolean; since?: string; max?: string; all?: boolean }) => {
      const db = getDb();

      const fetchResults: Array<{ source: string; newReleases: number }> = [];
      let targetSources: Source[];

      if (slug) {
        const found = await db.select().from(sources).where(eq(sources.slug, slug));
        if (found.length === 0) {
          console.error(chalk.red(`Source not found: ${slug}`));
          process.exit(1);
        }
        targetSources = found;
      } else {
        targetSources = await db.select().from(sources);
        if (targetSources.length === 0) {
          if (opts.json) {
            console.log(JSON.stringify([], null, 2));
          } else {
            console.log(chalk.yellow("No sources configured. Use `released add` to add one."));
          }
          return;
        }
      }

      // Build fetch options with defaults
      const fetchOptions: FetchOptions = {};
      if (!opts.all) {
        if (opts.since) {
          fetchOptions.since = new Date(opts.since);
        }
        fetchOptions.maxEntries = parseInt(opts.max ?? "100", 10);
      }

      for (const source of targetSources) {
        const adapter = getAdapter(source.type);
        if (!adapter) continue;

        if (!opts.json) {
          const limits = [];
          if (fetchOptions.since) limits.push(`since ${fetchOptions.since.toISOString().split("T")[0]}`);
          if (fetchOptions.maxEntries) limits.push(`max ${fetchOptions.maxEntries}`);
          const limitStr = limits.length > 0 ? ` (${limits.join(", ")})` : "";
          logger.info(`Fetching releases from ${chalk.cyan(source.name)}${limitStr}...`);
        }

        const startTime = performance.now();

        try {
          const rawReleases = await adapter.fetch(source, fetchOptions);

          if (rawReleases.length === 0) {
            if (!opts.json) {
              const msg = source.type === "scrape"
                ? `No changes detected for ${source.name}`
                : `No releases found for ${source.name}`;
              console.log(chalk.yellow(`${msg} ${chalk.dim(`(${elapsedSec(startTime)}s)`)}`));
            }
            fetchResults.push({ source: source.name, newReleases: 0 });
            continue;
          }

          const [{ total: beforeCount }] = await db
            .select({ total: count() })
            .from(releases)
            .where(eq(releases.sourceId, source.id));

          const rows = rawReleases.map((raw) => ({
            sourceId: source.id,
            version: raw.version ?? null,
            title: raw.title,
            content: raw.content,
            url: raw.url ?? null,
            contentHash: contentHash(raw),
            publishedAt: raw.publishedAt?.toISOString() ?? null,
          }));

          // Batch insert in chunks of 500 (SQLite variable limit)
          for (let i = 0; i < rows.length; i += 500) {
            await db.insert(releases).values(rows.slice(i, i + 500)).onConflictDoNothing();
          }

          const [{ total: afterCount }] = await db
            .select({ total: count() })
            .from(releases)
            .where(eq(releases.sourceId, source.id));

          const inserted = afterCount - beforeCount;

          await db
            .update(sources)
            .set({ lastFetchedAt: new Date().toISOString() })
            .where(eq(sources.id, source.id));

          fetchResults.push({ source: source.name, newReleases: inserted });

          if (!opts.json) {
            console.log(
              chalk.green(`Fetched ${inserted} new releases from ${source.name} ${chalk.dim(`(${elapsedSec(startTime)}s)`)}`),
            );
          }
        } catch (err) {
          logger.error(`Failed to fetch from ${source.name} (${elapsedSec(startTime)}s):`, err);
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(fetchResults, null, 2));
      }
    });
}
