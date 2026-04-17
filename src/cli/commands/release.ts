import { Command } from "commander";
import { createHash } from "crypto";
import chalk from "chalk";
import {
  findSource, suppressRelease, unsuppressRelease,
  getRelease, deleteRelease, updateRelease, deleteReleasesByFilter, deleteReleasesForSource,
  getReleaseCoverage, linkReleaseCoverage, unlinkReleaseCoverage,
  findOrg, getRecentReleasesByOrg,
} from "../../db/queries.js";
import { DECIDED_BY_CLI, decidedByAgent } from "../../db/schema-coverage.js";
import { groupReleases, type GroupingCandidate } from "../../ai/grouping.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { normalizeReleaseId } from "@buildinternet/releases-core/id";
import { daysAgoIso } from "@buildinternet/releases-core/dates";
function releaseNotFound(id: string): never {
  console.error(chalk.red(`Release not found: ${id}`));
  console.error(chalk.dim(`Make sure you're using the fully-resolved ID (e.g. rel_abc123…).`));
  process.exit(1);
}

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
  releases admin release show abc123
  releases admin release show abc123 --json`)
    .action(async (rawId: string, opts: { json?: boolean }) => {
      const id = normalizeReleaseId(rawId);
      const result = await getRelease(id);

      if (!result) releaseNotFound(id);

      const rel = result;

      if (opts.json) {
        console.log(JSON.stringify(rel, null, 2));
        return;
      }

      console.log(chalk.bold(stripAnsi(rel.title)));
      if (rel.version) console.log(`  Version:   ${stripAnsi(rel.version)}`);
      console.log(`  Source:    ${rel.sourceName ? stripAnsi(rel.sourceName) : chalk.dim("—")} (${rel.sourceSlug ?? chalk.dim("—")})`);
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

      const coverage = await getReleaseCoverage(id);
      if (coverage.role !== "standalone") {
        console.log();
        console.log(chalk.bold("Coverage:"));
        if (coverage.role === "canonical") {
          console.log(chalk.dim(`  Canonical of ${coverage.covers.length} other release(s):`));
          for (const row of coverage.covers) {
            const reason = row.reason ? ` — ${stripAnsi(row.reason)}` : "";
            console.log(`  ${row.coverageId}${chalk.dim(reason)}`);
          }
        } else if (coverage.role === "coverage" && coverage.canonical) {
          const reason = coverage.canonical.reason ? ` — ${stripAnsi(coverage.canonical.reason)}` : "";
          console.log(`  Coverage of ${coverage.canonical.canonicalId}${chalk.dim(reason)}`);
          console.log(chalk.dim(`  Decided by ${coverage.canonical.decidedBy} at ${coverage.canonical.decidedAt}`));
        }
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
  releases admin release delete abc123
  releases admin release delete --source my-source
  releases admin release delete --source my-source --before 2024-01-01
  releases admin release delete --source my-source --dry-run`)
    .action(async (rawId: string | undefined, opts: { source?: string; before?: string; json?: boolean; dryRun?: boolean }) => {
      const id = rawId ? normalizeReleaseId(rawId) : undefined;
      if (!id && !opts.source && !opts.before) {
        console.error("Error: provide a release ID, --source, or --before\n");
        console.error("  releases admin release delete abc123");
        console.error("  releases admin release delete --source my-source");
        console.error("  releases admin release delete --before 2024-01-01");
        process.exit(1);
      }

      // Resolve source if needed
      let resolvedSource: Awaited<ReturnType<typeof findSource>> | undefined;
      let sourceId: string | undefined;
      if (opts.source) {
        resolvedSource = await findSource(opts.source);
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
          if (!existing) releaseNotFound(id);
          if (opts.json) {
            console.log(JSON.stringify({ wouldDelete: 1, releases: [{ id, title: existing.title }] }, null, 2));
          } else {
            console.log(chalk.yellow(`[dry-run] Would delete 1 release(s)`));
            console.log(`  ${id}  ${stripAnsi(existing.title)}`);
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
  releases admin release edit abc123 --title "New Title"
  releases admin release edit abc123 --version "2.0.0"
  releases admin release edit abc123 --json`)
    .action(async (rawId: string, opts: { title?: string; version?: string; content?: string; json?: boolean }) => {
      const id = normalizeReleaseId(rawId);
      const existing = await getRelease(id);
      if (!existing) releaseNotFound(id);

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
  releases admin release suppress abc123 --reason "promotional content"
  releases admin release suppress abc123 --dry-run`)
    .action(async (rawId: string, opts: { reason?: string; dryRun?: boolean; json?: boolean }) => {
      const id = normalizeReleaseId(rawId);
      if (opts.dryRun) {
        if (opts.json) {
          console.log(JSON.stringify({ id, suppressed: true, reason: opts.reason ?? null, dryRun: true }));
        } else {
          console.log(chalk.yellow(`[dry-run] Would suppress release ${id}${opts.reason ? ` (${opts.reason})` : ""}`));
        }
        return;
      }

      const found = await suppressRelease(id, opts.reason);
      if (!found) releaseNotFound(id);

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
  releases admin release unsuppress abc123`)
    .action(async (rawId: string, opts: { json?: boolean }) => {
      const id = normalizeReleaseId(rawId);
      const found = await unsuppressRelease(id);
      if (!found) releaseNotFound(id);

      if (opts.json) {
        console.log(JSON.stringify({ id, suppressed: false }));
      } else {
        console.log(chalk.green(`Unsuppressed release ${id}`));
      }
    });

  // ── release link ──
  release
    .command("link")
    .description("Mark one or more releases as coverage of a canonical release")
    .argument("<canonical>", "Canonical release ID")
    .argument("<coverage...>", "One or more coverage release IDs")
    .option("--reason <reason>", "One-line reason recorded with the link")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases admin release link rel_canonical rel_coverage_a rel_coverage_b
  releases admin release link rel_canonical rel_coverage_a --reason "marketing post for launch"`)
    .action(async (rawCanonical: string, rawCoverage: string[], opts: { reason?: string; json?: boolean }) => {
      const canonicalId = normalizeReleaseId(rawCanonical);
      const canonical = await getRelease(canonicalId);
      if (!canonical) releaseNotFound(canonicalId);

      const coverageIds = rawCoverage.map(normalizeReleaseId);
      for (const cid of coverageIds) {
        const cov = await getRelease(cid);
        if (!cov) releaseNotFound(cid);
        await linkReleaseCoverage({
          canonicalId,
          coverageId: cid,
          reason: opts.reason,
          decidedBy: DECIDED_BY_CLI,
        });
      }

      if (opts.json) {
        console.log(JSON.stringify({ canonicalId, coverageIds, reason: opts.reason ?? null }, null, 2));
      } else {
        console.log(chalk.green(`Linked ${coverageIds.length} release(s) as coverage of ${canonicalId}.`));
      }
    });

  // ── release unlink ──
  release
    .command("unlink")
    .description("Remove a release from its coverage cluster (becomes standalone)")
    .argument("<id>", "Release ID to unlink")
    .option("--json", "Output as JSON")
    .action(async (rawId: string, opts: { json?: boolean }) => {
      const id = normalizeReleaseId(rawId);
      const removed = await unlinkReleaseCoverage(id);
      if (!removed) {
        console.error(chalk.yellow(`${id} is not part of any coverage cluster.`));
        process.exit(1);
      }
      if (opts.json) {
        console.log(JSON.stringify({ id, unlinked: true }));
      } else {
        console.log(chalk.green(`Unlinked ${id}.`));
      }
    });

  // ── release cluster ──
  release
    .command("cluster")
    .description("Reconcile release coverage for an org using the grouping-releases skill")
    .argument("<org>", "Organization slug or ID")
    .option("--window <days>", "Lookback window in days", "30")
    .option("--model <model>", "Override the grouping model (e.g. claude-sonnet-4-6)")
    .option("--dry-run", "Print the proposed clusters without writing")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases admin release cluster anthropic
  releases admin release cluster anthropic --window 7 --dry-run
  releases admin release cluster anthropic --model claude-sonnet-4-6`)
    .action(async (orgIdent: string, opts: { window?: string; model?: string; dryRun?: boolean; json?: boolean }) => {
      const org = await findOrg(orgIdent);
      if (!org) {
        console.error(chalk.red(`Organization not found: ${orgIdent}`));
        process.exit(1);
      }

      const windowDays = Number.parseInt(opts.window ?? "30", 10) || 30;
      const cutoff = daysAgoIso(windowDays);
      const rows = await getRecentReleasesByOrg(org.id, cutoff);

      if (rows.length === 0) {
        console.log(chalk.yellow(`No releases for ${org.slug} in the last ${windowDays} days.`));
        return;
      }

      const candidates: GroupingCandidate[] = rows.map((r) => ({
        id: r.id,
        title: r.title,
        version: r.version,
        publishedAt: r.publishedAt,
        sourceSlug: r.sourceSlug,
        content: r.contentSummary || r.content,
      }));

      if (!opts.json) {
        console.log(chalk.dim(`Grouping ${candidates.length} release(s) for ${org.slug} (window: ${windowDays}d)...`));
      }

      const result = await groupReleases(candidates, {
        model: opts.model,
        context: `Organization: ${org.name} (${org.slug}). Window: last ${windowDays} days.`,
      });

      const groupedClusters = result.clusters.filter((c) => c.coverageIds.length > 0);
      const singletons = result.clusters.filter((c) => c.coverageIds.length === 0);
      const coverageCount = groupedClusters.reduce((acc, c) => acc + c.coverageIds.length, 0);

      if (opts.json) {
        console.log(JSON.stringify({
          org: org.slug,
          windowDays,
          model: result.model,
          dryRun: !!opts.dryRun,
          candidateCount: candidates.length,
          clusters: result.clusters,
        }, null, 2));
      } else {
        console.log();
        console.log(chalk.bold(`${result.clusters.length} clusters — ${groupedClusters.length} grouped, ${singletons.length} singleton(s) — ${coverageCount} coverage link(s)`));
        console.log(chalk.dim(`Model: ${result.model}${opts.dryRun ? " (dry run — nothing written)" : ""}`));
        console.log();
        const titleById = new Map(candidates.map((c) => [c.id, c.title]));
        const titleFor = (id: string) => titleById.get(id) ?? id;
        for (const c of groupedClusters) {
          console.log(chalk.bold(`◆ ${titleFor(c.canonicalId)}`));
          console.log(chalk.dim(`  ${c.canonicalId} — ${c.reason}`));
          for (const cid of c.coverageIds) {
            console.log(`    ${chalk.dim("↳")} ${titleFor(cid)} ${chalk.dim(`(${cid})`)}`);
          }
        }
      }

      if (opts.dryRun) return;

      const decidedBy = decidedByAgent(result.model);
      let written = 0;
      for (const cluster of groupedClusters) {
        for (const coverageId of cluster.coverageIds) {
          await linkReleaseCoverage({
            canonicalId: cluster.canonicalId,
            coverageId,
            reason: cluster.reason,
            decidedBy,
          });
          written++;
        }
      }

      if (!opts.json && written > 0) {
        console.log();
        console.log(chalk.green(`Wrote ${written} coverage link(s).`));
      }
    });
}
