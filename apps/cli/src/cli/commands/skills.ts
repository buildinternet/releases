import { Command } from "commander";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import chalk from "chalk";
import { buildSkillsArgs, SKILLS_SOURCE } from "../skills/build-args.js";
import { recordSkillsInstallBaseline } from "../../lib/skills-update-check.js";

function exitWithError(message: string, hint: string): never {
  console.error(chalk.red(message) + " " + chalk.dim(hint));
  process.exit(1);
}

function whichSync(cmd: string): boolean {
  const finder = process.platform === "win32" ? "where" : "which";
  const result = spawnSync(finder, [cmd], {
    stdio: ["ignore", "ignore", "ignore"],
  });
  return result.status === 0;
}

type Runner = "npx" | "bunx";

function resolveRunner(): Runner {
  if (whichSync("npx")) return "npx";
  if (whichSync("bunx")) return "bunx";
  exitWithError(
    "Could not find `npx` or `bunx` on PATH.",
    "Install Node.js (https://nodejs.org) or Bun (https://bun.sh), then re-run.",
  );
}

function forwardSignals(child: ChildProcess): void {
  const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
  for (const sig of signals) {
    process.on(sig, () => {
      try {
        child.kill(sig);
      } catch {
        // child already exited
      }
    });
  }
}

function printRefreshHint(): void {
  console.log("");
  console.log(
    chalk.dim(
      "Re-run `releases skills install` to refresh. Skills are symlinked by default,\n" +
        "so most updates flow without re-running. For a single skill: `npx skills update releases-cli`.",
    ),
  );
}

export function registerSkillsCommand(parent: Command): void {
  const skills = parent
    .command("skills")
    .description("Install the bundled agent skills into your coding agent")
    .showSuggestionAfterError(true);

  skills
    .command("install")
    .description(
      "Install the bundled releases skills (releases-mcp, releases-cli, analyzing-releases) into the detected coding agent",
    )
    .argument("[skills...]", "specific skills to install (default: all bundled skills)")
    .option("-g, --global", "install to user dir instead of the current project")
    .option("-a, --agent <name>", "override agent auto-detection (e.g. claude-code, cursor, codex)")
    .option("--copy", "copy files instead of symlinking")
    .option("-l, --list", "list available skills without installing")
    .option("-y, --yes", "skip confirmation prompts")
    .option("--no-yes", "force interactive prompts (default is to skip them)")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  $ releases skills install                       # install all bundled skills into the detected agent",
        "  $ releases skills install releases-mcp          # just the user-facing lookup skill",
        "  $ releases skills install --global              # user-wide instead of project",
        "  $ releases skills install --agent cursor        # override detection",
        "  $ releases skills install --list                # show available skills, exit",
        "",
        `Under the hood this runs \`npx skills add ${SKILLS_SOURCE}\` from`,
        "the open agent-skills ecosystem (vercel-labs/skills). Run",
        "`npx skills add --help` for the full flag list.",
      ].join("\n"),
    )
    .action(
      async (
        skillNames: string[],
        opts: {
          global?: boolean;
          agent?: string;
          copy?: boolean;
          list?: boolean;
          yes?: boolean;
        },
      ) => {
        const runner = resolveRunner();
        const args = buildSkillsArgs({
          skills: skillNames,
          global: opts.global,
          agent: opts.agent,
          copy: opts.copy,
          list: opts.list,
          yes: opts.yes,
        });

        const child = spawn(runner, args, { stdio: "inherit" });
        forwardSignals(child);

        const code = await new Promise<number>((resolve) => {
          child.on("exit", (c, signal) => {
            // Signal-terminated child reports exitCode === null. Treat that
            // as failure so SIGINT/SIGTERM aren't masked as success.
            if (signal) resolve(1);
            else resolve(c ?? 1);
          });
          child.on("error", () => resolve(1));
        });

        if (code !== 0) {
          process.exit(code);
        }

        // Record the post-install baseline so `checkForSkillsUpdate` has a
        // SHA to compare against later. Skip for --list (no install happened).
        if (!opts.list) {
          await recordSkillsInstallBaseline();
        }

        if (process.stdout.isTTY && !opts.list) {
          printRefreshHint();
        }
      },
    );
}
