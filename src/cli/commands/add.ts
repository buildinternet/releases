import { Command } from "commander";
import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { sources } from "../../db/schema.js";
import { toSlug } from "../../lib/slug.js";

const VALID_TYPES = ["github", "scrape"] as const;
type SourceType = (typeof VALID_TYPES)[number];

function isValidType(t: string): t is SourceType {
  return (VALID_TYPES as readonly string[]).includes(t);
}

export function registerAddCommand(program: Command) {
  program
    .command("add")
    .description("Add a new changelog source")
    .argument("<name>", "Display name for the source")
    .requiredOption("--type <type>", "Source type: github or scrape")
    .requiredOption("--url <url>", "URL of the source")
    .option("--slug <slug>", "Custom slug (auto-derived from name if omitted)")
    .action(async (name: string, opts: { type: string; url: string; slug?: string }) => {
      if (!isValidType(opts.type)) {
        console.error(chalk.red(`Invalid type "${opts.type}". Must be one of: ${VALID_TYPES.join(", ")}`));
        process.exit(1);
      }

      const slug = opts.slug ?? toSlug(name);
      const db = getDb();

      await db.insert(sources).values({
        name,
        slug,
        type: opts.type,
        url: opts.url,
      });

      console.log(chalk.green(`Source added: ${name} (${slug})`));
    });
}
