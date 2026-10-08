import { Command } from "commander";
import { createHash } from "crypto";
import chalk from "chalk";
import {
  suppressRelease,
  unsuppressRelease,
  getRelease,
  deleteRelease,
  deleteReleasesBatch,
  batchSuppressReleases,
  updateRelease,
  deleteReleasesForSource,
  refetchRelease,
  type RefetchReleaseSnapshot,
} from "../../api/releases.js";
import { findSource } from "../../api/sources.js";
import { stripAnsi } from "../../lib/sanitize.js";
import { humanDate } from "../../lib/release-display.js";
import { normalizeReleaseId } from "@buildinternet/releases-core/id";
import { readContentArg } from "../../lib/input.js";
import { writeJson, writeJsonLine } from "../../lib/output.js";
import { warnDeprecatedAlias } from "../../lib/deprecated-alias.js";
import { markDryRun } from "../../lib/dry-run.js";
import { logger } from "@buildinternet/releases-lib/logger";

async function collectReleaseIds(positional: string[], file?: string): Promise<string[]> {
  if (file && positional.length > 0) {
    console.error("Error: pass release IDs as arguments or --file, not both\n");
    process.exit(1);
  }

  const ids: string[] = [];
  for (const raw of positional) ids.push(normalizeReleaseId(raw));

  if (file) {
    const raw = await readContentArg(file);
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      ids.push(normalizeReleaseId(trimmed));
    }
  }

  const unique = [...new Set(ids)];
  if (unique.length === 0) {
    console.error("Error: provide at least one release ID, or --file\n");
    process.exit(1);
  }
  return unique;
}

function releaseNotFound(id: string): never {
  console.error(chalk.red(`Release not found: ${id}`));
  process.exit(1);
}

async function releaseLookupMiss(id: string, json: boolean): Promise<never> {
  if (json) await writeJson(null);
  logger.info(`No release matching: ${id}`);
  process.exit(1);
}

// ── Shared action handlers ────────────────────────────────────────────────────

type ReleaseGetOpts = { json?: boolean };

async function releaseGetAction(rawId: string, opts: ReleaseGetOpts): Promise<void> {
  const id = normalizeReleaseId(rawId);
  const result = await getRelease(id);

  if (!result) return releaseLookupMiss(id, !!opts.json);

  const rel = result;

  if (opts.json) {
    await writeJson(rel);
    return;
  }

  const org = (rel as { org?: { slug: string; name: string } | null }).org;
  console.log(chalk.bold(stripAnsi(rel.title)));
  if (rel.version) console.log(`  Version:   ${stripAnsi(rel.version)}`);
  if (org) console.log(`  Org:       ${stripAnsi(org.name)} (${org.slug})`);
  console.log(
    `  Source:    ${rel.sourceName ? stripAnsi(rel.sourceName) : chalk.dim("—")} (${rel.sourceSlug ?? chalk.dim("—")})`,
  );
  if (rel.publishedAt) console.log(`  Published: ${humanDate(rel.publishedAt) || rel.publishedAt}`);
  console.log(`  Fetched:   ${rel.fetchedAt}`);
  if (rel.suppressed)
    console.log(
      `  ${chalk.yellow("Suppressed")}${rel.suppressedReason ? `: ${stripAnsi(rel.suppressedReason)}` : ""}`,
    );
  if (rel.url) console.log(`  URL:       ${rel.url}`);

  if (rel.summary) {
    console.log();
    console.log(chalk.bold("Summary:"));
    console.log(stripAnsi(rel.summary));
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
}

type ReleaseUpdateOpts = {
  title?: string;
  version?: string;
  content?: string;
  /** Canonical human-readable URL (empty string clears it). */
  url?: string;
  /** AI-generated self-contained headline (#860). */
  titleGenerated?: string;
  /** AI-generated smart-brevity headline (#860). */
  titleShort?: string;
  /** AI-generated summary (#860). */
  summary?: string;
  json?: boolean;
  dryRun?: boolean;
};

async function releaseUpdateAction(rawId: string, opts: ReleaseUpdateOpts): Promise<void> {
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

  // Treat empty strings as "clear" — pass through as null so the API stores
  // a NULL rather than a literal empty value. The API accepts undefined to
  // skip the column entirely; a present-but-empty CLI flag is an explicit
  // request to wipe the field.
  if (opts.titleGenerated !== undefined) {
    const v = opts.titleGenerated.length === 0 ? null : opts.titleGenerated;
    updates.titleGenerated = v;
    changes.push(v === null ? "titleGenerated → (cleared)" : `titleGenerated → ${v}`);
  }
  if (opts.titleShort !== undefined) {
    const v = opts.titleShort.length === 0 ? null : opts.titleShort;
    updates.titleShort = v;
    changes.push(v === null ? "titleShort → (cleared)" : `titleShort → ${v}`);
  }
  if (opts.summary !== undefined) {
    const v = opts.summary.length === 0 ? null : opts.summary;
    updates.summary = v;
    changes.push(v === null ? "summary → (cleared)" : `summary → (${opts.summary.length} chars)`);
  }
  if (opts.url !== undefined) {
    const v = opts.url.length === 0 ? null : opts.url;
    updates.url = v;
    changes.push(v === null ? "url → (cleared)" : `url → ${v}`);
  }

  if (changes.length === 0) {
    console.log(chalk.yellow("No changes specified."));
    return;
  }

  if (opts.dryRun) {
    if (opts.json) await writeJson(markDryRun({ wouldUpdate: id, updates, changes }));
    else {
      console.log(chalk.yellow(`[dry-run] Would update release ${id}:`));
      for (const change of changes) console.log(`  ${change}`);
    }
    return;
  }

  const updated = await updateRelease(id, updates);

  if (opts.json) await writeJson(updated);
  else {
    console.log(chalk.green(`Updated release ${id}:`));
    for (const change of changes) console.log(`  ${change}`);
  }
}

type ReleaseRefetchOpts = {
  url?: string;
  apply?: boolean;
  json?: boolean;
};

function renderRefetchSnapshot(label: string, snap: RefetchReleaseSnapshot): void {
  console.log(`  ${label}:`);
  console.log(`    Title:       ${stripAnsi(snap.title)}`);
  console.log(`    Content:     ${snap.contentChars} chars`);
  console.log(`    Media:       ${snap.mediaCount}`);
  console.log(`    Published:   ${snap.publishedAt ?? chalk.dim("—")}`);
  console.log(`    URL:         ${snap.url ?? chalk.dim("—")}`);
}

export async function releaseRefetchAction(rawId: string, opts: ReleaseRefetchOpts): Promise<void> {
  const id = normalizeReleaseId(rawId);
  if (!id.startsWith("rel_")) {
    console.error(chalk.red(`Invalid release ID "${rawId}" — expected a release ID (rel_…).`));
    process.exit(1);
  }

  const apply = !!opts.apply;
  let result;
  try {
    result = await refetchRelease({ releaseId: id, url: opts.url, dryRun: !apply });
  } catch (err) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)));
    process.exit(1);
  }

  if (opts.json) {
    await writeJson(result);
    return;
  }

  if (!result.dryRun) {
    console.log(chalk.green(`Refetched release ${id} (via ${result.via}, ${result.fetchUrl}):`));
    renderRefetchSnapshot("Updated", result.updated);
    return;
  }

  console.log(
    chalk.yellow(`[dry-run] Refetch preview for ${id} (via ${result.via}, ${result.fetchUrl}):`),
  );
  renderRefetchSnapshot("Current", result.current);
  renderRefetchSnapshot("Proposed", result.proposed);
  console.log();
  console.log(chalk.dim("Re-run with --apply to persist these changes."));
}

// ── Command registration ──────────────────────────────────────────────────────

export function registerReleaseCommand(program: Command) {
  const release = program.command("release").description("Manage releases");

  // ── release get (canonical) / release show (deprecated) ──
  release
    .command("get")
    .description("Get release details")
    .argument("<id>", "Release ID")
    .option("--json", "Output as JSON")
    .action(releaseGetAction);

  release
    .command("show")
    .description("(deprecated — use get) Show release details")
    .argument("<id>", "Release ID")
    .option("--json", "Output as JSON")
    .action(warnDeprecatedAlias<[string, ReleaseGetOpts]>("show", "get", releaseGetAction));

  release
    .command("delete")
    .description("Delete release(s) by ID, or all releases for a source")
    .argument("[ids...]", "Release ID(s) to delete (rel_…)")
    .option("--file <path>", "File with one release ID per line (use - for stdin)")
    .option("--source <identifier>", "Delete all releases for a source (src_… or slug)")
    .option(
      "--hard",
      "With --source: permanently remove rows (frees the UNIQUE(source_id, url) dedup slot) instead of soft-suppressing. Use before a corrected re-fetch.",
    )
    .option("--dry-run", "Show what would be deleted without deleting")
    .option("--json", "Output as JSON")
    .action(
      async (
        rawIds: string[],
        opts: {
          file?: string;
          source?: string;
          hard?: boolean;
          json?: boolean;
          dryRun?: boolean;
        },
      ) => {
        if (opts.source && (rawIds.length > 0 || opts.file)) {
          console.error("Error: --source cannot be combined with release IDs or --file\n");
          process.exit(1);
        }
        if (rawIds.length === 0 && !opts.file && !opts.source) {
          console.error("Error: provide a release ID, --file, or --source\n");
          process.exit(1);
        }

        let resolvedSource: Awaited<ReturnType<typeof findSource>> | undefined;
        if (opts.source) {
          resolvedSource = await findSource(opts.source);
          if (!resolvedSource) {
            console.error(chalk.red(`Source not found: ${opts.source}`));
            process.exit(1);
          }
        }

        if (!opts.source) {
          const ids = await collectReleaseIds(rawIds, opts.file);

          if (opts.dryRun) {
            if (opts.json)
              await writeJson(markDryRun({ wouldDelete: ids.length, releaseIds: ids }));
            else {
              console.log(chalk.yellow(`[dry-run] Would delete ${ids.length} release(s)`));
              for (const id of ids) console.log(`  ${id}`);
            }
            return;
          }

          if (ids.length === 1) {
            const deleted = await deleteRelease(ids[0]);
            if (!deleted) {
              console.error(chalk.red("No matching releases found."));
              process.exit(1);
            }
            if (opts.json) await writeJson({ deleted: 1 });
            else console.log(chalk.green("Deleted 1 release."));
            return;
          }

          const result = await deleteReleasesBatch(ids);
          if (opts.json) await writeJson(result);
          else {
            console.log(
              chalk.green(
                `Deleted ${result.deleted} release${result.deleted === 1 ? "" : "s"} (requested ${ids.length}).`,
              ),
            );
          }
          return;
        }

        if (resolvedSource) {
          if (opts.dryRun) {
            if (opts.json)
              await writeJson(
                markDryRun({
                  wouldDelete: resolvedSource.slug,
                  hard: opts.hard ?? false,
                }),
              );
            else
              console.log(
                chalk.yellow(
                  `[dry-run] Would ${opts.hard ? "hard-delete" : "suppress"} all releases for source: ${resolvedSource.slug}`,
                ),
              );
            return;
          }
          let result: Awaited<ReturnType<typeof deleteReleasesForSource>>;
          try {
            result = await deleteReleasesForSource(resolvedSource, { hard: opts.hard });
          } catch (err) {
            console.error(chalk.red(err instanceof Error ? err.message : String(err)));
            process.exit(1);
          }
          if (opts.json) await writeJson(result);
          else if ("deleted" in result)
            console.log(
              chalk.green(
                `Hard-deleted ${result.deleted} release${result.deleted === 1 ? "" : "s"}.`,
              ),
            );
          else
            console.log(
              chalk.green(
                `Suppressed ${result.suppressed} release${result.suppressed === 1 ? "" : "s"} (soft — rows still occupy the URL dedup slot; pass --hard to free it for a clean re-fetch).`,
              ),
            );
          return;
        }
      },
    );

  // ── release update (canonical) / release edit (deprecated) ──
  release
    .command("update")
    .description("Update a release")
    .argument("<id>", "Release ID")
    .option("--title <title>", "Update title")
    .option("--version <version>", "Update version")
    .option("--content <content>", "Update content (recomputes contentHash)")
    .option(
      "--title-generated <title>",
      "Update AI-generated self-contained headline (pass empty string to clear)",
    )
    .option(
      "--title-short <title>",
      "Update AI-generated smart-brevity headline (pass empty string to clear)",
    )
    .option("--summary <summary>", "Update AI-generated summary (pass empty string to clear)")
    .option("--url <url>", "Set the release's canonical URL (pass empty string to clear)")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would change without writing")
    .action(releaseUpdateAction);

  release
    .command("edit")
    .description("(deprecated — use update) Edit a release")
    .argument("<id>", "Release ID")
    .option("--title <title>", "Update title")
    .option("--version <version>", "Update version")
    .option("--content <content>", "Update content (recomputes contentHash)")
    .option(
      "--title-generated <title>",
      "Update AI-generated self-contained headline (pass empty string to clear)",
    )
    .option(
      "--title-short <title>",
      "Update AI-generated smart-brevity headline (pass empty string to clear)",
    )
    .option("--summary <summary>", "Update AI-generated summary (pass empty string to clear)")
    .option("--url <url>", "Set the release's canonical URL (pass empty string to clear)")
    .option("--json", "Output as JSON")
    .option("--dry-run", "Show what would change without writing")
    .action(
      warnDeprecatedAlias<[string, ReleaseUpdateOpts]>("edit", "update", releaseUpdateAction),
    );

  release
    .command("suppress")
    .description("Suppress release(s) from appearing in queries and search results")
    .argument("[ids...]", "Release ID(s) to suppress (rel_…)")
    .option("--file <path>", "File with one release ID per line (use - for stdin)")
    .option("--reason <reason>", "Reason for suppression")
    .option("--dry-run", "Show what would be suppressed without writing")
    .option("--json", "Output as JSON")
    .action(
      async (
        rawIds: string[],
        opts: { file?: string; reason?: string; dryRun?: boolean; json?: boolean },
      ) => {
        const ids = await collectReleaseIds(rawIds, opts.file);

        if (opts.dryRun) {
          if (opts.json)
            await writeJson({
              releaseIds: ids,
              suppressed: true,
              reason: opts.reason ?? null,
              dryRun: true,
            });
          else {
            console.log(
              chalk.yellow(
                `[dry-run] Would suppress ${ids.length} release(s)${opts.reason ? ` (${opts.reason})` : ""}`,
              ),
            );
            for (const id of ids) console.log(`  ${id}`);
          }
          return;
        }

        if (ids.length === 1) {
          const found = await suppressRelease(ids[0], opts.reason);
          if (!found) releaseNotFound(ids[0]);
          if (opts.json)
            await writeJsonLine({ id: ids[0], suppressed: true, reason: opts.reason ?? null });
          else
            console.log(
              chalk.green(`Suppressed release ${ids[0]}${opts.reason ? ` (${opts.reason})` : ""}`),
            );
          return;
        }

        const result = await batchSuppressReleases(ids, true, opts.reason);
        if (opts.json) await writeJson({ ...result, releaseIds: ids, suppressed: true });
        else {
          console.log(
            chalk.green(
              `Suppressed ${result.updated} release${result.updated === 1 ? "" : "s"} (requested ${ids.length})${opts.reason ? ` (${opts.reason})` : ""}.`,
            ),
          );
        }
      },
    );

  release
    .command("unsuppress")
    .description("Restore suppressed release(s)")
    .argument("[ids...]", "Release ID(s) to unsuppress (rel_…)")
    .option("--file <path>", "File with one release ID per line (use - for stdin)")
    .option("--dry-run", "Show what would be unsuppressed without writing")
    .option("--json", "Output as JSON")
    .action(async (rawIds: string[], opts: { file?: string; dryRun?: boolean; json?: boolean }) => {
      const ids = await collectReleaseIds(rawIds, opts.file);

      if (opts.dryRun) {
        if (opts.json) await writeJson({ releaseIds: ids, suppressed: false, dryRun: true });
        else {
          console.log(chalk.yellow(`[dry-run] Would unsuppress ${ids.length} release(s)`));
          for (const id of ids) console.log(`  ${id}`);
        }
        return;
      }

      if (ids.length === 1) {
        const found = await unsuppressRelease(ids[0]);
        if (!found) releaseNotFound(ids[0]);
        if (opts.json) await writeJsonLine({ id: ids[0], suppressed: false });
        else console.log(chalk.green(`Unsuppressed release ${ids[0]}`));
        return;
      }

      const result = await batchSuppressReleases(ids, false);
      if (opts.json) await writeJson({ ...result, releaseIds: ids, suppressed: false });
      else {
        console.log(
          chalk.green(
            `Unsuppressed ${result.updated} release${result.updated === 1 ? "" : "s"} (requested ${ids.length}).`,
          ),
        );
      }
    });

  release
    .command("refetch")
    .description("Re-fetch a release's live page and update the row in place (rel_… id preserved)")
    .argument("<releaseId>", "Release ID to refetch (rel_…)")
    .option(
      "--url <canonicalUrl>",
      "Canonical permalink to fetch (required when the stored URL is a synthesized #fragment index anchor; must be on the source's host)",
    )
    .option("--apply", "Write the changes (default is a dry-run preview)")
    .option("--json", "Output the raw response as JSON")
    .addHelpText(
      "after",
      `
Examples:
  releases admin release refetch rel_abc123                          Dry-run preview
  releases admin release refetch rel_abc123 --apply                  Write it
  releases admin release refetch rel_abc123 --url https://example.com/posts/foo --apply
                                                                       Required when the stored URL is a synthesized #fragment anchor

Re-fetches ONE release's live page and updates the row in place: title,
content, and publishedAt are replaced; summary/titleGenerated/titleShort are
nulled for regeneration; media is replaced only when extraction returns items.`,
    )
    .action(releaseRefetchAction);
}
