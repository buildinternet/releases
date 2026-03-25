import { Command } from "commander";
import chalk from "chalk";
import { createHash } from "crypto";
import { eq, count } from "drizzle-orm";
import { getDb } from "../../db/connection.js";
import { sources, releases, type Source } from "../../db/schema.js";
import type { Adapter, RawRelease } from "../../adapters/types.js";
import { github } from "../../adapters/github.js";
import { scrape } from "../../adapters/scrape.js";
import { logger } from "../../lib/logger.js";

function getAdapter(type: string): Adapter | null {
  switch (type) {
    case "github":
      return github;
    case "scrape":
      return scrape;
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
    .action(async (slug: string | undefined, opts: { json?: boolean }) => {
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

      for (const source of targetSources) {
        const adapter = getAdapter(source.type);
        if (!adapter) continue;

        if (!opts.json) {
          logger.info(`Fetching releases from ${chalk.cyan(source.name)}...`);
        }

        try {
          const rawReleases = await adapter.fetch(source);

          if (rawReleases.length === 0) {
            if (!opts.json) {
              console.log(chalk.yellow(`No releases found for ${source.name}`));
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
              chalk.green(`Fetched ${inserted} new releases from ${source.name}`),
            );
          }
        } catch (err) {
          logger.error(`Failed to fetch from ${source.name}:`, err);
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(fetchResults, null, 2));
      }
    });
}
