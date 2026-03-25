import { Command } from "commander";
import { eq } from "drizzle-orm";
import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { sources } from "../../db/schema.js";

export function registerRemoveCommand(program: Command) {
  program
    .command("remove")
    .description("Remove a changelog source by slug")
    .argument("<slug>", "Slug of the source to remove")
    .action(async (slug: string) => {
      const db = getDb();

      const existing = await db.select().from(sources).where(eq(sources.slug, slug));

      if (existing.length === 0) {
        console.error(chalk.red(`Source not found: ${slug}`));
        process.exit(1);
      }

      await db.delete(sources).where(eq(sources.slug, slug));

      console.log(chalk.green(`Removed source: ${existing[0].name} (${slug})`));
    });
}
