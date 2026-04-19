import { Command } from "commander";
import chalk from "chalk";
import { isRemoteMode } from "../../lib/mode.js";
import * as apiClient from "../../api/client.js";

export function registerTaskCommand(program: Command) {
  const task = program
    .command("task")
    .description("Manage remote fetch and discovery sessions")
    .hook("preAction", () => {
      if (!isRemoteMode()) {
        console.error(chalk.red("Task management requires remote mode (RELEASED_API_URL)."));
        process.exit(1);
      }
    });

  task
    .command("list")
    .description("List active and recent sessions")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const sessions = await apiClient.listSessions();

      if (opts.json) {
        console.log(JSON.stringify(sessions, null, 2));
        return;
      }

      if (sessions.length === 0) {
        console.log(chalk.gray("No sessions found."));
        return;
      }

      for (const s of sessions) {
        const age = Math.round((Date.now() - s.startedAt) / 1000);
        const statusColor =
          s.status === "running"
            ? chalk.yellow
            : s.status === "complete"
              ? chalk.green
              : s.status === "cancelled"
                ? chalk.gray
                : chalk.red;
        const sources = s.totalSources ? `${s.sourcesFetched ?? 0}/${s.totalSources} sources` : "";
        const releases = s.releasesInserted ? `${s.releasesInserted} new` : "";
        const details = [sources, releases].filter(Boolean).join(", ");
        const detailStr = details ? chalk.gray(` (${details})`) : "";
        const ageStr =
          age < 60
            ? `${age}s`
            : age < 3600
              ? `${Math.round(age / 60)}m`
              : `${Math.round(age / 3600)}h`;

        console.log(
          `  ${statusColor(s.status.padEnd(10))} ${s.company.padEnd(30)} ${chalk.gray(s.sessionId.slice(0, 8))}  ${chalk.gray(ageStr + " ago")}${detailStr}`,
        );
      }
    });

  task
    .command("cancel")
    .description("Cancel a running session")
    .argument("<sessionId>", "Session ID (or prefix) to cancel")
    .action(async (sessionIdArg: string) => {
      let sessionId = sessionIdArg;
      if (sessionId.length < 36) {
        const sessions = await apiClient.listSessions();
        const matches = sessions.filter((s) => s.sessionId.startsWith(sessionId));
        if (matches.length === 0) {
          console.error(chalk.red(`No session found matching "${sessionId}".`));
          process.exit(1);
        }
        if (matches.length > 1) {
          console.error(chalk.red(`Multiple sessions match "${sessionId}". Be more specific.`));
          for (const m of matches) {
            console.error(`  ${m.sessionId}  ${m.company}  ${m.status}`);
          }
          process.exit(1);
        }
        sessionId = matches[0].sessionId;
      }

      const result = await apiClient.cancelSession(sessionId);
      if (result.ok) {
        console.log(chalk.green(`Cancel requested for session ${sessionId.slice(0, 8)}.`));
      } else {
        console.error(chalk.red(`Failed to cancel: ${result.error}`));
        process.exit(1);
      }
    });
}
