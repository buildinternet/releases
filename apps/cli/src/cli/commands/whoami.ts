import { Command } from "commander";
import { printAuthStatus } from "./auth.js";

export function registerWhoamiCommand(parent: Command): void {
  parent
    .command("whoami")
    .description("Show current CLI auth status (alias for `auth status`)")
    .option("--json", "Output as JSON")
    .option("--check", "Probe the API to verify the token")
    .action(async (opts: { json?: boolean; check?: boolean }) => {
      await printAuthStatus({ json: opts.json, verify: opts.check });
    });
}
