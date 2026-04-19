import { Command } from "commander";
import { readFileSync } from "node:fs";
import chalk from "chalk";
import { verifySignature } from "@releases/core/webhook-sign";

export interface VerifyArgs {
  secret: string;
  timestamp: number;
  signature: string;
  body: string;
}

export async function verifySignatureCli(args: VerifyArgs): Promise<{ ok: boolean }> {
  const ok = await verifySignature(args.secret, args.timestamp, args.body, args.signature);
  return { ok };
}

export function registerWebhookCommand(program: Command) {
  const webhook = program.command("webhook").description("Webhook utilities");

  webhook
    .command("verify")
    .description("Verify an X-Released-Signature locally against a captured payload")
    .requiredOption("--secret <key>", "Signing key (hex) — the value 'releases admin webhook add' printed at creation")
    .requiredOption("--signature <header>", "Value of the X-Released-Signature header (e.g. sha256=...)")
    .requiredOption("--timestamp <unix>", "Value of the X-Released-Timestamp header (unix seconds)")
    .requiredOption("--body-file <path>", "Path to the raw request body")
    .action(async (opts: { secret: string; signature: string; timestamp: string; bodyFile: string }) => {
      const ts = parseInt(opts.timestamp, 10);
      if (isNaN(ts)) {
        console.error(chalk.red(`Invalid --timestamp: ${opts.timestamp} (expected unix seconds)`));
        process.exit(1);
      }
      let body: string;
      try {
        body = readFileSync(opts.bodyFile, "utf8");
      } catch {
        console.error(chalk.red(`Cannot read --body-file: ${opts.bodyFile}`));
        process.exit(1);
      }
      const result = await verifySignatureCli({
        secret: opts.secret,
        timestamp: ts,
        signature: opts.signature,
        body,
      });
      if (result.ok) {
        console.log(chalk.green("OK — signature is valid"));
        process.exit(0);
      } else {
        console.error(chalk.red("FAIL — signature did not match"));
        process.exit(1);
      }
    });
}
