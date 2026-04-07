import { Command } from "commander";
import chalk from "chalk";
import { enrichReleases, type EnrichResult } from "../../adapters/enrich.js";
import { elapsedFormatted } from "../../lib/dates.js";
import { stripAnsi } from "../../lib/sanitize.js";

export function registerEnrichCommand(program: Command) {
  program
    .command("enrich")
    .description("Enrich sparse releases by fetching full page content")
    .argument("<slug>", "Source slug")
    .option("--dry-run", "Preview what would be enriched without updating")
    .option("--limit <n>", "Maximum number of releases to process")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  releases enrich sentry-changelog              Enrich sparse releases
  releases enrich sentry-changelog --dry-run    Preview without updating
  releases enrich sentry-changelog --limit 5    Process at most 5 releases
  releases enrich sentry-changelog --json       Machine-readable output`)
    .action(async (slug: string, opts: { dryRun?: boolean; limit?: string; json?: boolean }) => {
      const start = performance.now();

      try {
        const result = await enrichReleases({
          sourceSlug: slug,
          dryRun: opts.dryRun,
          limit: opts.limit ? parseInt(opts.limit) : undefined,
        });

        const elapsed = elapsedFormatted(start);

        if (opts.json) {
          console.log(JSON.stringify({
            ...result,
            dryRun: opts.dryRun ?? false,
            elapsed,
          }, null, 2));
          return;
        }

        printResult(result, slug, elapsed, opts.dryRun);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (opts.json) {
          console.log(JSON.stringify({ error: msg }));
        } else {
          console.error(chalk.red(`Enrichment failed: ${msg}`));
        }
        process.exit(1);
      }
    });
}

function printResult(result: EnrichResult, slug: string, elapsed: string, dryRun?: boolean) {
  const prefix = dryRun ? chalk.yellow("[dry-run] ") : "";
  console.log(`\n${prefix}${chalk.bold(`Enrichment results for ${slug}`)} (${elapsed})\n`);

  console.log(`  ${chalk.green(`Enriched: ${result.enriched}`)}`);
  console.log(`  ${chalk.dim(`Skipped:  ${result.skipped}`)}`);
  if (result.errors > 0) console.log(`  ${chalk.red(`Errors:   ${result.errors}`)}`);

  console.log(`\n  ${chalk.dim("Token usage:")}`);
  console.log(`    Triage:     ${result.triageTokens.toLocaleString()} tokens`);
  console.log(`    Extraction: ${result.extractTokens.toLocaleString()} tokens`);
  console.log(`    Total:      ${(result.triageTokens + result.extractTokens).toLocaleString()} tokens`);

  if (result.releases.some((r) => r.status === "enriched")) {
    console.log(`\n  ${chalk.dim("Enriched releases:")}`);
    for (const r of result.releases.filter((r) => r.status === "enriched")) {
      console.log(`    ${chalk.green("✓")} ${stripAnsi(r.title)}`);
    }
  }

  if (result.errors > 0) {
    console.log(`\n  ${chalk.dim("Errors:")}`);
    for (const r of result.releases.filter((r) => r.status === "error")) {
      console.log(`    ${chalk.red("✗")} ${stripAnsi(r.title)}: ${r.reason ? stripAnsi(r.reason) : ""}`);
    }
  }

  console.log();
}
