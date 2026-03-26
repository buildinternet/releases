// src/cli/commands/onboard.ts
import { Command } from "commander";
import chalk from "chalk";
import { runDiscovery, type DiscoveryState } from "../../agent/discovery.js";

export function registerOnboardCommand(program: Command) {
  program
    .command("onboard")
    .description("Discover and onboard changelog sources for a company using AI agent")
    .argument("<company>", "Company or product name to discover sources for")
    .option("--domain <domain>", "Seed the agent with the company's domain")
    .option("--github-org <org>", "Seed the agent with the company's GitHub organization")
    .option("--json", "Output results as JSON")
    .action(
      async (
        company: string,
        opts: { domain?: string; githubOrg?: string; json?: boolean },
      ) => {
        if (!opts.json) {
          process.stderr.write(
            chalk.bold(`Onboarding "${company}"`) +
              chalk.gray(" — discovery agent is running...\n\n"),
          );
        }

        let lastToolName = "";

        const state = await runDiscovery({
          company,
          domain: opts.domain,
          githubOrg: opts.githubOrg,
          json: opts.json,
          onProgress: (text) => {
            if (!opts.json) {
              process.stderr.write(chalk.dim(text));
            }
          },
          onToolUse: (toolName, command) => {
            if (opts.json) return;
            if (toolName === "Bash" && command) {
              // Show CLI commands the agent runs (truncate long ones)
              const display = command.length > 120 ? command.slice(0, 117) + "..." : command;
              process.stderr.write(chalk.gray(`  $ ${display}\n`));
            } else if (toolName !== lastToolName) {
              process.stderr.write(chalk.gray(`  [${toolName}]\n`));
            }
            lastToolName = toolName;
          },
        });

        if (opts.json) {
          console.log(JSON.stringify(state, null, 2));
          return;
        }

        // Print summary
        printSummary(state);
      },
    );
}

function printSummary(state: DiscoveryState): void {
  const { sources } = state;

  process.stderr.write("\n");
  console.log(chalk.bold(`Discovery results for ${state.product}\n`));

  if (state.domain) console.log(chalk.gray(`  Domain: ${state.domain}`));
  if (state.githubOrg) console.log(chalk.gray(`  GitHub: ${state.githubOrg}`));

  if (sources.length === 0) {
    console.log(chalk.yellow("\n  No sources discovered."));
    return;
  }

  const validated = sources.filter((s) => s.validated);
  const failed = sources.filter((s) => s.validationError);

  console.log(
    chalk.gray(
      `  ${sources.length} source(s) found, ${validated.length} validated, ${failed.length} failed\n`,
    ),
  );

  for (const s of sources) {
    const conf =
      s.confidence === "high"
        ? chalk.green(s.confidence)
        : s.confidence === "medium"
          ? chalk.yellow(s.confidence)
          : chalk.red(s.confidence);
    const status = s.validationError
      ? chalk.red("failed")
      : s.validated
        ? chalk.green(`${s.releaseCount ?? 0} releases`)
        : chalk.gray("not validated");
    const dup = s.duplicateOf ? chalk.dim(` (dup of ${s.duplicateOf})`) : "";

    console.log(`  ${chalk.cyan(s.slug)} ${chalk.dim(s.type)} ${conf} — ${status}${dup}`);
    console.log(chalk.dim(`    ${s.url}`));
  }

  console.log(chalk.dim(`\n  Status: ${state.status}`));
}
