import { Command } from "commander";
import chalk from "chalk";
import { setTelemetryEnabled, telemetryStatus } from "../../lib/telemetry.js";
import { writeJson } from "../../lib/output.js";

export function registerTelemetryCommand(parent: Command): void {
  const cmd = parent.command("telemetry").description("Manage anonymous usage telemetry");

  cmd
    .command("status")
    .description("Show current telemetry configuration")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const s = telemetryStatus();
      if (opts.json) {
        await writeJson(s);
        return;
      }
      const state = s.enabled ? chalk.green("enabled") : chalk.red("disabled");
      console.log(`${chalk.bold("Telemetry:")} ${state}`);
      if (!s.enabled && s.reason) console.log(`${chalk.dim("Reason:")}  ${s.reason}`);
      console.log(`${chalk.dim("Anon ID:")} ${s.anonId}`);
      console.log(`${chalk.dim("Kind:")}    ${s.clientKind}`);
      console.log(`${chalk.dim("Endpoint:")}${" "}${s.endpoint}/v1/telemetry`);
      console.log("");
      console.log(
        chalk.dim("Collected: command name, CLI version, OS/arch, runtime, exit code, duration."),
      );
      console.log(chalk.dim("Never collected: arguments, flag values, paths, slugs, or content."));
    });

  cmd
    .command("enable")
    .description("Enable anonymous usage telemetry")
    .action(() => {
      setTelemetryEnabled(true);
      console.log(chalk.green("Telemetry enabled."));
    });

  cmd
    .command("disable")
    .description("Disable anonymous usage telemetry")
    .action(() => {
      setTelemetryEnabled(false);
      console.log(chalk.yellow("Telemetry disabled."));
    });
}
