import { Command } from "commander";
import { printAuthStatus } from "./auth.js";

/**
 * Kept for back-compat — still exported because tests/unit/whoami.test.ts
 * imports it directly. The whoami command no longer calls it.
 */
export function redactApiKey(key: string): string {
  if (key.length <= 8) return "****";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

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
