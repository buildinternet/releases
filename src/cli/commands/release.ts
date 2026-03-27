import { Command } from "commander";
import { eq, and, lt } from "drizzle-orm";
import { createHash } from "crypto";
import chalk from "chalk";
import { getDb } from "../../db/connection.js";
import { releases, sources } from "../../db/schema.js";
import { findSourceBySlug, suppressRelease, unsuppressRelease } from "../../db/queries.js";

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
    .action(async (id: string, opts: { json?: boolean }) => {
      const db = getDb();

      const rows = await db
        .select({
          release: releases,
          sourceName: sources.name,
          sourceSlug: sources.slug,
        })
        .from(releases)
        .leftJoin(sources, eq(releases.sourceId, sources.id))
        .where(eq(releases.id, id));

      if (rows.length === 0) {
        console.error(chalk.red(`Release not found: ${id}`));
        process.exit(1);
      }

      const { release: rel, sourceName, sourceSlug } = rows[0];

      if (opts.json) {
        console.log(JSON.stringify({ ...rel, sourceName, sourceSlug }, null, 2));
        return;
      }

      console.log(chalk.bold(rel.title));
      if (rel.version) console.log(`  Version:   ${rel.version}`);
      console.log(`  Source:    ${sourceName ?? chalk.dim("—")} (${sourceSlug ?? chalk.dim("—")})`);
      if (rel.publishedAt) console.log(`  Published: ${rel.publishedAt}`);
      console.log(`  Fetched:   ${rel.fetchedAt}`);
      if (rel.suppressed) console.log(`  ${chalk.yellow("Suppressed")}${rel.suppressedReason ? `: ${rel.suppressedReason}` : ""}`);
      if (rel.url) console.log(`  URL:       ${rel.url}`);

      if (rel.contentSummary) {
        console.log();
        console.log(chalk.bold("Summary:"));
        console.log(rel.contentSummary);
      }

      console.log();
      console.log(chalk.bold("Content:"));
      if (rel.content.length > 2000) {
        console.log(rel.content.slice(0, 2000));
        console.log(chalk.dim(`\n... truncated (${rel.content.length} chars total)`));
      } else {
        console.log(rel.content);
      }
    });

  // ── release delete ──
  release
    .command("delete")
    .description("Delete releases by ID, source, or date")
    .argument("[id]", "Release ID to delete")
    .option("--source <slug>", "Delete releases for a source")
    .option("--before <date>", "Delete releases published before this ISO date")
    .option("--json", "Output as JSON")
    .action(async (id: string | undefined, opts: { source?: string; before?: string; json?: boolean }) => {
      const db = getDb();

      if (!id && !opts.source && !opts.before) {
        console.error(chalk.red("Provide a release ID, --source, or --before."));
        process.exit(1);
      }

      let deleted: { id: string }[];

      if (id) {
        deleted = await db.delete(releases).where(eq(releases.id, id)).returning({ id: releases.id });
      } else {
        const conditions = [];

        if (opts.source) {
          const source = await findSourceBySlug(opts.source);
          if (!source) {
            console.error(chalk.red(`Source not found: ${opts.source}`));
            process.exit(1);
          }
          conditions.push(eq(releases.sourceId, source.id));
        }

        if (opts.before) {
          conditions.push(lt(releases.publishedAt, opts.before));
        }

        deleted = await db
          .delete(releases)
          .where(and(...conditions))
          .returning({ id: releases.id });
      }

      if (deleted.length === 0) {
        console.error(chalk.red("No matching releases found."));
        process.exit(1);
      }

      if (opts.json) {
        console.log(JSON.stringify({ deleted: deleted.length }, null, 2));
      } else {
        console.log(chalk.green(`Deleted ${deleted.length} release${deleted.length === 1 ? "" : "s"}.`));
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
    .action(async (id: string, opts: { title?: string; version?: string; content?: string; json?: boolean }) => {
      const db = getDb();

      const [existing] = await db.select().from(releases).where(eq(releases.id, id));
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

      const [updated] = await db.update(releases).set(updates).where(eq(releases.id, id)).returning();

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
