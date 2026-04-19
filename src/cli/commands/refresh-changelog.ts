import { Command } from "commander";
import chalk from "chalk";
import { findSource, upsertChangelogFile, deleteChangelogFilesNotIn, getChangelogFile, listChangelogFiles } from "../../db/queries.js";
import { fetchChangelogFiles } from "@releases/adapters/github";
import { buildChangelogResponse, formatChangelogSliceLine, resolveChangelogRangeParams } from "@releases/core-internal/changelog-slice";
import { sourceChangelog as sourceChangelogRemote } from "../../api/client.js";
import { sourceNotFound } from "../suggest.js";
import { logger } from "@buildinternet/releases-lib/logger";
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

      const files = await fetchChangelogFiles(source);
      if (files.length === 0) {
        if (opts.json) {
          console.log(JSON.stringify({ ok: false, reason: "no_changelog_found" }, null, 2));
        } else {
          console.log(chalk.yellow(`No CHANGELOG file found for ${source.slug}`));
        }
        process.exit(1);
      }

      const results: { path: string; bytes: number; truncated: boolean; contentHash: string; inserted: boolean; updated: boolean }[] = [];
      for (const file of files) {
        const result = await upsertChangelogFile(source.id, file);
        results.push({
          path: file.path,
          bytes: file.bytes,
          truncated: !!file.truncated,
          contentHash: file.contentHash,
          inserted: result.inserted,
          updated: result.updated,
        });
      }
      const pruned = await deleteChangelogFilesNotIn(source.id, files.map((f) => f.path));

      if (opts.json) {
        console.log(JSON.stringify({ ok: true, files: results, pruned }, null, 2));
        return;
      }

      for (const r of results) {
        const verb = r.inserted ? "Inserted" : r.updated ? "Updated" : "Refreshed (no change)";
        const suffix = r.truncated ? ", truncated" : "";
        console.log(chalk.green(`${verb} ${r.path} for ${source.slug} (${r.bytes} bytes${suffix})`));
      }
      if (pruned > 0) {
        console.log(chalk.dim(`Pruned ${pruned} stale file(s)`));
      }
    });
}

export function registerChangelogCommand(program: Command) {
  program
    .command("changelog")
    .description("Print the tracked CHANGELOG file for a source, optionally sliced by char range or token budget")
    .argument("<slug>", "Source ID or slug")
    .option("--path <path>", "Specific file path to read (e.g. packages/next/CHANGELOG.md)")
    .option("--offset <n>", "Character offset to start reading from", (v) => parseInt(v, 10))
    .option("--limit <n>", "Max characters to read (snapped to heading boundaries)", (v) => parseInt(v, 10))
    .option("--tokens <n>", "Target slice size in tokens (cl100k_base). Overrides --limit. Common brackets: 2000/5000/10000/20000", (v) => parseInt(v, 10))
    .option("--json", "Output as JSON with offset, nextOffset, totalChars, totalTokens, sliceTokens")
    .action(async (slug: string, opts: { path?: string; offset?: number; limit?: number; tokens?: number; json?: boolean }) => {
      const source = await findSource(slug);
      if (!source) return sourceNotFound(slug);

      const rangeParams = resolveChangelogRangeParams({
        offset: opts.offset,
        limit: opts.limit,
        tokens: opts.tokens,
      });

      let response;
      if (isRemoteMode()) {
        const remote = await sourceChangelogRemote(source.slug, {
          path: opts.path,
          offset: opts.offset,
          limit: rangeParams.limit !== null ? Number(rangeParams.limit) : undefined,
          tokens: opts.tokens,
        });
        if (!remote) {
          logger.error(`No CHANGELOG file is tracked for ${source.slug}. Only GitHub sources expose this.`);
          process.exit(1);
        }
        response = remote;
      } else {
        const allRows = await listChangelogFiles(source.id);
        if (allRows.length === 0) {
          logger.error(`No CHANGELOG file is tracked for ${source.slug}. Run 'releases admin source refresh-changelog ${source.slug}' first.`);
          process.exit(1);
        }
        let selected = allRows[0];
        if (opts.path) {
          const match = allRows.find((r) => r.path === opts.path);
          if (!match) {
            logger.error(`No CHANGELOG file at path "${opts.path}" for ${source.slug}. Available: ${allRows.map((r) => r.path).join(", ")}`);
            process.exit(1);
          }
          selected = match;
        } else {
          const root = await getChangelogFile(source.id);
          if (root) selected = root;
        }
        const files = allRows.map((r) => ({
          path: r.path,
          filename: r.filename,
          url: r.url,
          bytes: r.bytes,
          fetchedAt: r.fetchedAt,
        }));
        response = buildChangelogResponse(selected, rangeParams, files);
      }

      if (opts.json) {
        console.log(JSON.stringify(response, null, 2));
        return;
      }

      process.stdout.write(response.content);
      if (!response.content.endsWith("\n")) process.stdout.write("\n");
      console.error(chalk.dim(`\n— ${formatChangelogSliceLine(response)} —`));
    });
}
