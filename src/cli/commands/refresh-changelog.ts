import { Command } from "commander";
import chalk from "chalk";
import { findSource, upsertChangelogFile } from "../../db/queries.js";
import { fetchChangelogFile } from "../../adapters/github.js";
import { sourceNotFound } from "../suggest.js";
import { logger } from "../../lib/logger.js";
import { isRemoteMode } from "../../lib/mode.js";

export function registerRefreshChangelogCommand(program: Command) {
  program
    .command("refresh-changelog")
    .description("Manually refresh the canonical CHANGELOG file for a GitHub source")
    .argument("<slug>", "Source ID or slug")
    .option("--json", "Output as JSON")
    .action(async (slug: string, opts: { json?: boolean }) => {
      if (isRemoteMode()) {
        logger.error("refresh-changelog is local-mode only. Run without RELEASED_API_URL set.");
        process.exit(1);
      }

      const source = await findSource(slug);
      if (!source) return sourceNotFound(slug);

      if (source.type !== "github") {
        logger.error(`Source ${source.slug} is type "${source.type}", not "github"`);
        process.exit(1);
      }

      const file = await fetchChangelogFile(source);
      if (!file) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, reason: "no_changelog_found" }, null, 2));
        } else {
          console.log(chalk.yellow(`No CHANGELOG file found for ${source.slug}`));
        }
        process.exit(1);
      }

      const result = await upsertChangelogFile(source.id, file);

      if (opts.json) {
        console.log(JSON.stringify({
          ok: true,
          path: file.path,
          bytes: file.bytes,
          contentHash: file.contentHash,
          inserted: result.inserted,
          updated: result.updated,
        }, null, 2));
        return;
      }

      const verb = result.inserted ? "Inserted" : result.updated ? "Updated" : "Refreshed (no change)";
      console.log(chalk.green(`${verb} ${file.filename} for ${source.slug} (${file.bytes} bytes)`));
      console.log(chalk.dim(`URL: ${file.url}`));
    });
}
