import { Command } from "commander";
import { eq, inArray } from "drizzle-orm";
import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { sources } from "../../db/schema.js";
import { logger } from "../../lib/logger.js";

export function registerRemoveCommand(program: Command) {
  program
    .command("remove")
    .description("Remove one or more changelog sources by slug")
    .argument("<slugs...>", "Slugs of sources to remove")
    .option("--json", "Output as JSON")
    .action(async (slugs: string[], opts: { json?: boolean }) => {
      const db = getDb();

      const existing = await db
        .select()
        .from(sources)
        .where(inArray(sources.slug, slugs));

      const foundSlugs = new Set(existing.map((s) => s.slug));
      const results: { slug: string; name?: string; status: "removed" | "not_found" }[] = [];
      let hasError = false;

      // Report not-found slugs
      for (const slug of slugs) {
        if (!foundSlugs.has(slug)) {
          results.push({ slug, status: "not_found" });
          logger.error(`Source not found: ${slug}`);
          hasError = true;
        }
      }

      // Delete all found sources in one query
      if (existing.length > 0) {
        const foundSlugList = existing.map((s) => s.slug);
        await db.delete(sources).where(inArray(sources.slug, foundSlugList));

        for (const source of existing) {
          results.push({ slug: source.slug, name: source.name, status: "removed" });
          if (!opts.json) {
            logger.info(chalk.green(`Removed source: ${source.name} (${source.slug})`));
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      }

      if (hasError) {
        process.exit(1);
      }
    });
}
