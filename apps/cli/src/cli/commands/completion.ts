import { Command } from "commander";
import chalk from "chalk";
import {
  commandToSpec,
  generateCompletion,
  isSupportedShell,
  SUPPORTED_SHELLS,
  type SupportedShell,
} from "../completion/generate.js";
import {
  defaultInstallPath,
  detectShell,
  rcSnippet,
  writeCompletionFile,
} from "../completion/install.js";
import { markCompletionHintShown } from "../completion/hint.js";

function exitWithError(message: string, hint: string): never {
  console.error(chalk.red(message) + " " + chalk.dim(hint));
  process.exit(1);
}

function resolveShell(shellArg: string | undefined): SupportedShell {
  if (!shellArg) {
    const detected = detectShell();
    if (!detected) {
      exitWithError(
        "Could not detect shell.",
        `Pass one explicitly: releases completion install <${SUPPORTED_SHELLS.join("|")}>`,
      );
    }
    return detected;
  }
  if (!isSupportedShell(shellArg)) {
    exitWithError(`Unsupported shell: ${shellArg}`, `Supported: ${SUPPORTED_SHELLS.join(", ")}`);
  }
  return shellArg;
}

export function registerCompletionCommand(parent: Command): void {
  const completion = parent
    .command("completion")
    .description("Print or install shell completions")
    .showSuggestionAfterError(true);

  for (const shell of SUPPORTED_SHELLS) {
    completion
      .command(shell)
      .description(`Print the ${shell} completion script to stdout`)
      .action(() => {
        process.stdout.write(generateCompletion(shell, commandToSpec(parent)));
      });
  }

  completion
    .command("install")
    .argument("[shell]", "Shell to install for (auto-detected if omitted)")
    .option("--path <path>", "Override the install path (defaults vary by shell)")
    .description("Detect your shell and write the completion script")
    .action((shellArg: string | undefined, opts: { path?: string }) => {
      const shell = resolveShell(shellArg);
      const path = opts.path ?? defaultInstallPath(shell);
      const content = generateCompletion(shell, commandToSpec(parent));
      const result = writeCompletionFile(path, content);
      markCompletionHintShown();

      const verb = result.alreadyExisted ? "Updated" : "Installed";
      console.log(`${chalk.green("✓")} ${verb} ${shell} completion at ${chalk.bold(path)}`);
      console.log("");
      console.log(chalk.dim(rcSnippet(shell, path)));
    });
}
