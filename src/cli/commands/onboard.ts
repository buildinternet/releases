import { Command } from "commander";
import chalk from "chalk";
import { runDiscovery, type DiscoveryState } from "../../agent/discovery.js";
import { registerOnboardApplyCommand } from "./onboard-apply.js";

export function registerOnboardCommand(program: Command) {
  const onboard = program
    .command("onboard")
    .description("Discover and onboard changelog sources for a company using AI agent")
    .argument("<company>", "Company or product name to discover sources for")
    .option("--domain <domain>", "Seed the agent with the company's domain")
    .option("--github-org <org>", "Seed the agent with the company's GitHub organization")
    .option("--json", "Output results as JSON")
    .addHelpText("after", `
Examples:
  released onboard "Vercel"
  released onboard "Stripe" --domain stripe.com --github-org stripe
  released onboard "Acme" --json`)
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
          onProgress: opts.json ? undefined : (text) => {
            process.stderr.write(chalk.dim(text));
          },
          onToolUse: opts.json ? undefined : (toolName, command) => {
            if (toolName === "Bash" && command) {
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

        printSummary(state);
      },
    );

  registerOnboardApplyCommand(onboard);
}

function printSummary(state: DiscoveryState): void {
  const { sources } = state;
  const write = (s: string) => process.stderr.write(s + "\n");

  write("");
  write(chalk.bold(`Discovery results for ${state.product}`));
  write("");

  if (state.domain) write(chalk.gray(`  Domain: ${state.domain}`));
  if (state.githubOrg) write(chalk.gray(`  GitHub: ${state.githubOrg}`));

  if (sources.length === 0) {
    write(chalk.yellow("\n  No sources discovered."));
    return;
  }

  const validated = sources.filter((s) => s.validated);
  const failed = sources.filter((s) => s.validationError);

  write(
    chalk.gray(
      `  ${sources.length} source(s) found, ${validated.length} validated, ${failed.length} failed`,
    ),
  );
  write("");

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

    write(`  ${chalk.cyan(s.slug)} ${chalk.dim(s.type)} ${conf} — ${status}${dup}`);
    write(chalk.dim(`    ${s.url}`));
  }

  write(chalk.dim(`\n  Status: ${state.status}`));
}
