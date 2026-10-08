import { Command } from "commander";
import chalk from "chalk";
import { findSource, sourceChangelog } from "../../api/sources.js";
import { formatChangelogSliceLine } from "@buildinternet/releases-core/changelog-slice";
import { sourceNotFound } from "../suggest.js";
import { logger } from "@buildinternet/releases-lib/logger";
import { writeJson } from "../../lib/output.js";

export function registerChangelogCommand(program: Command) {
  program
    .command("changelog")
    .description(
      "Print the tracked CHANGELOG file for a source, optionally sliced by char range or token budget",
    )
    .argument("<slug>", "Source ID or slug")
    .option("--path <path>", "Specific file path to read (e.g. packages/next/CHANGELOG.md)")
    .option("--offset <n>", "Character offset to start reading from", (v) => parseInt(v, 10))
    .option("--limit <n>", "Max characters to read (snapped to heading boundaries)", (v) =>
      parseInt(v, 10),
    )
    .option("--tokens <n>", "Target slice size in tokens (cl100k_base). Overrides --limit.", (v) =>
      parseInt(v, 10),
    )
    .option("--json", "Output as JSON")
    .action(
      async (
        slug: string,
        opts: { path?: string; offset?: number; limit?: number; tokens?: number; json?: boolean },
      ) => {
        const source = await findSource(slug);
        if (!source) return sourceNotFound(slug);

        const response = await sourceChangelog(source.slug, {
          path: opts.path,
          offset: opts.offset,
          limit: opts.limit,
          tokens: opts.tokens,
        });
        if (!response) {
          logger.error(
            `No CHANGELOG file is tracked for ${source.slug}. Only GitHub sources expose this.`,
          );
          process.exit(1);
        }

        if (opts.json) {
          await writeJson(response);
          return;
        }

        process.stdout.write(response.content);
        if (!response.content.endsWith("\n")) process.stdout.write("\n");
        console.error(chalk.dim(`\n— ${formatChangelogSliceLine(response)} —`));
      },
    );
}
