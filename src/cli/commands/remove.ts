import { Command } from "commander";
import chalk from "chalk";
import { findSourcesBySlugs, deleteSources, addIgnoredUrl } from "../../db/queries.js";
import { logger } from "@releases/lib/logger";

export function registerRemoveCommand(program: Command) {
  program
    .command("remove")
    .description("Remove one or more changelog sources by slug")
    .argument("<slugs...>", "Slugs of sources to remove")
    .option("--ignore", "Add each source URL to the ignored list before removing")
    .option("--reason <reason>", "Reason for ignoring (used with --ignore)")
    .option("--dry-run", "Show what would be removed without deleting")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases admin source remove my-source
  releases admin source remove source-a source-b source-c
  releases admin source remove my-source --ignore --reason "no longer maintained"
  releases admin source remove my-source --dry-run`)
    .action(async (slugs: string[], opts: { ignore?: boolean; reason?: string; json?: boolean; dryRun?: boolean }) => {
      const existing = await findSourcesBySlugs(slugs);

      const foundSlugs = new Set(existing.map((s) => s.slug));
      const results: { slug: string; name?: string; url?: string; status: "removed" | "not_found"; ignored?: boolean }[] = [];
      let hasError = false;

      // Dry-run mode
      if (opts.dryRun) {
        const dryResults = slugs.map((slug) => {
          const found = existing.find((s) => s.slug === slug);
          return found
            ? { slug, name: found.name, url: found.url, status: "would_remove" as const }
            : { slug, status: "not_found" as const };
        });

        if (opts.json) {
          console.log(JSON.stringify(dryResults, null, 2));
        } else {
          for (const r of dryResults) {
            if (r.status === "not_found") {
              console.error(chalk.red(`Source not found: ${r.slug}`));
            } else {
              console.log(chalk.yellow(`[dry-run] Would remove: ${r.name} (${r.slug})`));
            }
          }
        }

        if (dryResults.some((r) => r.status === "not_found")) process.exit(1);
        return;
      }

      // Report not-found slugs
      for (const slug of slugs) {
        if (!foundSlugs.has(slug)) {
          results.push({ slug, status: "not_found" });
          logger.error(`Source not found: ${slug}`);
          hasError = true;
        }
      }

      // Optionally ignore URLs before deleting
      if (opts.ignore && existing.length > 0) {
        for (const source of existing) {
          if (!source.orgId) {
            if (!opts.json) {
              logger.warn(chalk.yellow(`Cannot ignore ${source.url} — source has no organization. Use 'block add' for global blocking.`));
            }
            continue;
          }
          await addIgnoredUrl(source.url, source.orgId, opts.reason);
          if (!opts.json) {
            logger.info(chalk.yellow(`Ignored URL: ${source.url}${opts.reason ? ` (${opts.reason})` : ""}`));
          }
        }
      }

      // Delete all found sources
      if (existing.length > 0) {
        const foundSlugList = existing.map((s) => s.slug);
        await deleteSources(foundSlugList);

        for (const source of existing) {
          results.push({
            slug: source.slug,
            name: source.name,
            url: source.url,
            status: "removed",
            ...(opts.ignore ? { ignored: true } : {}),
          });
          if (!opts.json) {
            logger.info(chalk.green(`Removed source: ${source.name} (${source.slug})`));
          }
        }
      }

      if (opts.json) {
        console.log(JSON.stringify(results, null, 2));
      }

      if (hasError) {
        process.exit(1);
      }
    });
}
