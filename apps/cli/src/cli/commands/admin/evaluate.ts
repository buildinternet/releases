import { Command } from "commander";
import chalk from "chalk";
import { logger } from "@buildinternet/releases-lib/logger";
import { evaluateUrl } from "../../../api/sources.js";
import { writeJson } from "../../../lib/output.js";

interface EvaluateOpts {
  json?: boolean;
}

export function registerEvaluateCommand(program: Command) {
  program
    .command("evaluate")
    .description("Evaluate a URL for best changelog ingestion method")
    .argument("<url>", "URL to evaluate")
    .option("--json", "Output as JSON")
    .action(async (url: string, opts: EvaluateOpts) => {
      try {
        void new URL(url);
      } catch {
        logger.error(`Invalid URL: ${url}`);
        process.exit(1);
      }

      const result = await evaluateUrl(url);

      if (opts.json) {
        await writeJson(result);
        return;
      }

      const confColor =
        result.confidence === "high"
          ? chalk.green
          : result.confidence === "medium"
            ? chalk.yellow
            : chalk.gray;

      console.log();
      console.log(`  ${chalk.bold("Method")}    ${result.recommendedMethod}`);
      console.log(`  ${chalk.bold("URL")}       ${result.recommendedUrl}`);
      if (result.feedUrl) {
        console.log(
          `  ${chalk.bold("Feed")}      ${result.feedUrl}` +
            chalk.gray(` (${result.feedType ?? "feed"})`),
        );
      }
      if (result.githubRepo) {
        console.log(`  ${chalk.bold("GitHub")}    ${result.githubRepo}`);
      }
      if (result.provider) {
        console.log(`  ${chalk.bold("Provider")}  ${result.provider}`);
      }
      console.log(`  ${chalk.bold("Structure")} ${result.pageStructure}`);
      console.log(`  ${chalk.bold("Confidence")} ${confColor(result.confidence)}`);

      if (result.alternatives.length > 0) {
        console.log();
        console.log(chalk.bold("  Alternatives"));
        for (const alt of result.alternatives) {
          console.log(`    ${chalk.gray("•")} ${alt.method.padEnd(8)} ${alt.url}`);
          if (alt.note) console.log(`      ${chalk.gray(alt.note)}`);
        }
      }

      if (result.notes) {
        console.log();
        console.log(chalk.gray(`  ${result.notes}`));
      }
      console.log();
    });
}
