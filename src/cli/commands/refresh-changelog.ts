import { Command } from "commander";
import chalk from "chalk";
import { findSource, upsertChangelogFile, getChangelogFile } from "../../db/queries.js";
import { fetchChangelogFile } from "../../adapters/github.js";
import { buildChangelogResponse } from "../../lib/changelog-slice.js";
import { sourceChangelog as sourceChangelogRemote } from "../../api/client.js";
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

export function registerChangelogCommand(program: Command) {
  program
    .command("changelog")
    .description("Print the tracked CHANGELOG file for a source, optionally sliced by char range")
    .argument("<slug>", "Source ID or slug")
    .option("--offset <n>", "Character offset to start reading from", (v) => parseInt(v, 10))
    .option("--limit <n>", "Max characters to read (snapped to heading boundaries)", (v) => parseInt(v, 10))
    .option("--json", "Output as JSON with offset, nextOffset, totalChars")
    .action(async (slug: string, opts: { offset?: number; limit?: number; json?: boolean }) => {
      const source = await findSource(slug);
      if (!source) return sourceNotFound(slug);

      const ranging = opts.offset !== undefined || opts.limit !== undefined;

      let response;
      if (isRemoteMode()) {
        const remote = await sourceChangelogRemote(source.slug, {
          offset: opts.offset,
          limit: opts.limit ?? (ranging ? 40_000 : undefined),
        });
        if (!remote) {
          logger.error(`No CHANGELOG file is tracked for ${source.slug}. Only GitHub sources expose this.`);
          process.exit(1);
        }
        response = remote;
      } else {
        const row = await getChangelogFile(source.id);
        if (!row) {
          logger.error(`No CHANGELOG file is tracked for ${source.slug}. Run 'releases admin source refresh-changelog ${source.slug}' first.`);
          process.exit(1);
        }
        response = buildChangelogResponse(row, {
          offset: opts.offset !== undefined ? String(opts.offset) : null,
          limit: opts.limit !== undefined ? String(opts.limit) : (ranging ? "40000" : null),
        });
      }

      if (opts.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      process.stdout.write(response.content);
      if (!response.content.endsWith("\n")) process.stdout.write("\n");
      const tail = response.nextOffset != null
        ? `\n— chars ${response.offset}–${response.offset + response.content.length} of ${response.totalChars} (next offset: ${response.nextOffset}) —`
        : `\n— chars ${response.offset}–${response.offset + response.content.length} of ${response.totalChars} (end of file) —`;
      console.error(chalk.dim(tail));
    });
}
