import { Command } from "commander";
import chalk from "chalk";
import { evaluateChangelog, applyEvaluation, type EvaluationResult } from "../../ai/evaluate.js";
import { findSourceBySlug } from "../../db/queries.js";
import { logger } from "../../lib/logger.js";

function formatResult(result: EvaluationResult, url: string): string {
  const lines: string[] = [];

  const confidenceColor =
    result.confidence === "high" ? chalk.green : result.confidence === "medium" ? chalk.yellow : chalk.red;

  lines.push(chalk.bold(`Evaluation: ${url}`));
  lines.push("");
  lines.push(`  Method:      ${chalk.bold(result.recommendedMethod)}`);
  lines.push(`  URL:         ${result.recommendedUrl}`);
  lines.push(`  Confidence:  ${confidenceColor(result.confidence)}`);
  lines.push(`  Structure:   ${result.pageStructure}`);

  if (result.provider) {
    lines.push(`  Provider:    ${result.provider}`);
  }
  if (result.feedUrl) {
    lines.push(`  Feed:        ${result.feedUrl} (${result.feedType ?? "unknown"})`);
  }
  if (result.githubRepo) {
    lines.push(`  GitHub:      ${result.githubRepo}`);
  }

  if (result.alternatives.length > 0) {
    lines.push("");
    lines.push(chalk.dim("  Alternatives:"));
    for (const alt of result.alternatives) {
      lines.push(`    ${alt.method}: ${alt.url}`);
      if (alt.note) lines.push(`      ${chalk.dim(alt.note)}`);
    }
  }

  if (result.notes) {
    lines.push("");
    lines.push(chalk.dim(`  Notes: ${result.notes}`));
  }

  return lines.join("\n");
}

export function registerEvaluateCommand(program: Command) {
  program
    .command("evaluate")
    .description("Evaluate a changelog URL to find the best ingestion method")
    .argument("<url>", "URL of the changelog or release notes page")
    .option("--source <slug>", "Save results to an existing source's metadata")
    .option("--json", "Output as JSON")
    .addHelpText("after", `
Examples:
  released evaluate https://code.claude.com/docs/en/changelog
  released evaluate https://code.claude.com/docs/en/changelog --source claude-code
  released evaluate https://github.com/vercel/next.js --json`)
    .action(async (url: string, opts: { source?: string; json?: boolean }) => {
      try {
        new URL(url);
      } catch {
        logger.error(`Invalid URL: ${url}`);
        process.exit(1);
      }

      logger.info(`Evaluating ${url}...`);

      try {
        const result = await evaluateChangelog(url);

        // Persist to source if --source is given
        if (opts.source) {
          const source = await findSourceBySlug(opts.source);
          if (!source) {
            logger.error(`Source not found: ${opts.source}`);
            process.exit(1);
          }
          await applyEvaluation(source, result);
          logger.info(`Evaluation saved to source ${chalk.bold(source.slug)}`);
        }

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
        } else {
          console.log(formatResult(result, url));
        }
      } catch (err) {
        logger.error(`Evaluation failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(1);
      }
    });
}
