import { Command } from "commander";
import { createHash } from "crypto";
import chalk from "chalk";
import {
  findSourceBySlug, suppressRelease, unsuppressRelease,
  getRelease, deleteRelease, updateRelease, deleteReleasesByFilter, deleteReleasesForSource,
} from "../../db/queries.js";
import { stripAnsi } from "../../lib/sanitize.js";

export function registerReleaseCommand(program: Command) {
  const release = program
    .command("release")
    .description("Manage releases");

  // ── release show ──
  release
    .command("show")
    .description("Show release details")
    .argument("<id>", "Release ID")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released release show abc123
  released release show abc123 --json`)
    .action(async (id: string, opts: { json?: boolean }) => {
      const result = await getRelease(id);

      if (!result) {
        console.error(chalk.red(`Release not found: ${id}`));
        process.exit(1);
      }

      const { release: rel, sourceName, sourceSlug } = result;

      if (opts.json) {
        console.log(JSON.stringify({ ...rel, sourceName, sourceSlug }, null, 2));
        return;
      }

      console.log(chalk.bold(stripAnsi(rel.title)));
      if (rel.version) console.log(`  Version:   ${stripAnsi(rel.version)}`);
      console.log(`  Source:    ${sourceName ? stripAnsi(sourceName) : chalk.dim("—")} (${sourceSlug ?? chalk.dim("—")})`);
      if (rel.publishedAt) console.log(`  Published: ${rel.publishedAt}`);
      console.log(`  Fetched:   ${rel.fetchedAt}`);
      if (rel.suppressed) console.log(`  ${chalk.yellow("Suppressed")}${rel.suppressedReason ? `: ${stripAnsi(rel.suppressedReason)}` : ""}`);
      if (rel.url) console.log(`  URL:       ${rel.url}`);

      if (rel.contentSummary) {
        console.log();
        console.log(chalk.bold("Summary:"));
        console.log(stripAnsi(rel.contentSummary));
      }

      console.log();
      console.log(chalk.bold("Content:"));
      const sanitizedContent = stripAnsi(rel.content);
      if (sanitizedContent.length > 2000) {
        console.log(sanitizedContent.slice(0, 2000));
        console.log(chalk.dim(`\n... truncated (${sanitizedContent.length} chars total)`));
      } else {
        console.log(sanitizedContent);
      }
    });

  // ── release delete ──
  release
    .command("delete")
    .description("Delete releases by ID, source, or date")
    .argument("[id]", "Release ID to delete")
    .option("--source <slug>", "Delete releases for a source")
    .option("--before <date>", "Delete releases published before this ISO date")
    .option("--dry-run", "Show what would be deleted without deleting")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released release delete abc123
  released release delete --source my-source
  released release delete --source my-source --before 2024-01-01
  released release delete --source my-source --dry-run`)
    .action(async (id: string | undefined, opts: { source?: string; before?: string; json?: boolean; dryRun?: boolean }) => {
      if (!id && !opts.source && !opts.before) {
        console.error("Error: provide a release ID, --source, or --before\n");
        console.error("  released release delete abc123");
        console.error("  released release delete --source my-source");
        console.error("  released release delete --before 2024-01-01");
        process.exit(1);
      }

      // Resolve source if needed
      let resolvedSource: Awaited<ReturnType<typeof findSourceBySlug>> | undefined;
      let sourceId: string | undefined;
      if (opts.source) {
        resolvedSource = await findSourceBySlug(opts.source);
        if (!resolvedSource) {
          console.error(chalk.red(`Source not found: ${opts.source}`));
          process.exit(1);
        }
        sourceId = resolvedSource.id;
      }

      // Single release delete by ID
      if (id) {
        if (opts.dryRun) {
          const existing = await getRelease(id);
          if (!existing) {
            console.error(chalk.red(`Release not found: ${id}`));
            process.exit(1);
          }
          if (opts.json) {
            console.log(JSON.stringify({ wouldDelete: 1, releases: [{ id, title: existing.release.title }] }, null, 2));
          } else {
            console.log(chalk.yellow(`[dry-run] Would delete 1 release(s)`));
            console.log(`  ${id}  ${stripAnsi(existing.release.title)}`);
          }
          return;
        }

        const deleted = await deleteRelease(id);
        if (!deleted) {
          console.error(chalk.red("No matching releases found."));
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify({ deleted: 1 }, null, 2));
        } else {
          console.log(chalk.green(`Deleted 1 release.`));
        }
        return;
      }

      // Bulk delete by source only (remote-mode compatible path)
      if (resolvedSource && !opts.before) {
        if (opts.dryRun) {
          console.log(chalk.yellow(`[dry-run] Would delete all releases for source: ${resolvedSource.slug}`));
          return;
        }
        let deleted: number;
        try {
          deleted = await deleteReleasesForSource(resolvedSource);
        } catch (err) {
          console.error(chalk.red(err instanceof Error ? err.message : String(err)));
          process.exit(1);
        }
        if (opts.json) {
          console.log(JSON.stringify({ deleted }, null, 2));
        } else {
          console.log(chalk.green(`Deleted ${deleted} release${deleted === 1 ? "" : "s"}.`));
        }
        return;
      }

      // Bulk delete by filter (local mode only when --before is used)
      const filterOpts: { sourceId?: string; before?: string; dryRun?: boolean } = {};
      if (sourceId) filterOpts.sourceId = sourceId;
      if (opts.before) filterOpts.before = opts.before;
      if (opts.dryRun) filterOpts.dryRun = true;

      let result: Awaited<ReturnType<typeof deleteReleasesByFilter>>;
      try {
        result = await deleteReleasesByFilter(filterOpts);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      if (opts.dryRun) {
        if (opts.json) {
          console.log(JSON.stringify({ wouldDelete: result.releases.length, releases: result.releases }, null, 2));
        } else {
          console.log(chalk.yellow(`[dry-run] Would delete ${result.releases.length} release(s)`));
          for (const r of result.releases.slice(0, 10)) {
            console.log(`  ${r.id}  ${stripAnsi(r.title)}`);
          }
          if (result.releases.length > 10) {
            console.log(chalk.dim(`  ... and ${result.releases.length - 10} more`));
          }
        }
        return;
      }

      if (result.deleted === 0) {
        console.error(chalk.red("No matching releases found."));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ deleted: result.deleted }, null, 2));
      } else {
        console.log(chalk.green(`Deleted ${result.deleted} release${result.deleted === 1 ? "" : "s"}.`));
      }
    });

  // ── release edit ──
  release
    .command("edit")
    .description("Edit a release")
    .argument("<id>", "Release ID")
    .option("--title <title>", "Update title")
    .option("--version <version>", "Update version")
    .option("--content <content>", "Update content (recomputes contentHash)")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released release edit abc123 --title "New Title"
  released release edit abc123 --version "2.0.0"
  released release edit abc123 --json`)
    .action(async (id: string, opts: { title?: string; version?: string; content?: string; json?: boolean }) => {
      const existing = await getRelease(id);
      if (!existing) {
        console.error(chalk.red(`Release not found: ${id}`));
        process.exit(1);
      }

      const updates: Record<string, unknown> = {};
      const changes: string[] = [];

      if (opts.title) {
        updates.title = opts.title;
        changes.push(`title → ${opts.title}`);
      }

      if (opts.version) {
        updates.version = opts.version;
        changes.push(`version → ${opts.version}`);
      }

      if (opts.content) {
        updates.content = opts.content;
        const hash = createHash("sha256").update(opts.content).digest("hex");
        updates.contentHash = hash;
        changes.push(`content → (${opts.content.length} chars)`);
        changes.push(`contentHash → ${hash.slice(0, 12)}…`);
      }

      if (changes.length === 0) {
        console.log(chalk.yellow("No changes specified. Use --help to see options."));
        return;
      }

      const updated = await updateRelease(id, updates);

      if (opts.json) {
        console.log(JSON.stringify(updated, null, 2));
      } else {
        console.log(chalk.green(`Updated release ${id}:`));
        for (const change of changes) {
          console.log(`  ${change}`);
        }
      }
    });

  // ── release suppress ──
  release
    .command("suppress")
    .description("Suppress a release from appearing in queries and search results")
    .argument("<id>", "Release ID to suppress")
    .option("--reason <reason>", "Reason for suppression (e.g. 'promotional content')")
    .option("--dry-run", "Show what would be suppressed without writing")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released release suppress abc123 --reason "promotional content"
  released release suppress abc123 --dry-run`)
    .action(async (id: string, opts: { reason?: string; dryRun?: boolean; json?: boolean }) => {
      if (opts.dryRun) {
        if (opts.json) {
          console.log(JSON.stringify({ id, suppressed: true, reason: opts.reason ?? null, dryRun: true }));
        } else {
          console.log(chalk.yellow(`[dry-run] Would suppress release ${id}${opts.reason ? ` (${opts.reason})` : ""}`));
        }
        return;
      }

      const found = await suppressRelease(id, opts.reason);
      if (!found) {
        console.error(chalk.red(`Release not found: ${id}`));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ id, suppressed: true, reason: opts.reason ?? null }));
      } else {
        console.log(chalk.green(`Suppressed release ${id}${opts.reason ? ` (${opts.reason})` : ""}`));
      }
    });

  // ── release unsuppress ──
  release
    .command("unsuppress")
    .description("Restore a suppressed release so it appears in queries again")
    .argument("<id>", "Release ID to unsuppress")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released release unsuppress abc123`)
    .action(async (id: string, opts: { json?: boolean }) => {
      const found = await unsuppressRelease(id);
      if (!found) {
        console.error(chalk.red(`Release not found: ${id}`));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ id, suppressed: false }));
      } else {
        console.log(chalk.green(`Unsuppressed release ${id}`));
      }
    });
}
