import { Command } from "commander";
import chalk from "chalk";
import { readContentArg } from "../../lib/input.js";
import { registerWebhookManageCommands } from "./webhook-manage.js";

// Web Crypto only — no node:crypto dependency.
const enc = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0) throw new Error("invalid hex length");
  const out = new Uint8Array(new ArrayBuffer(hex.length / 2));
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function bytesToHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < view.length; i++) out += view[i].toString(16).padStart(2, "0");
  return out;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export const MAX_SKEW_SECONDS = 5 * 60;

export type VerifyResult =
  | { ok: true }
  | { ok: false; reason: "invalid_timestamp" | "timestamp_outside_window" | "signature_mismatch" };

/**
 * Core verification logic — exported for unit testing.
 *
 * @param signingKeyHex  Hex-encoded HMAC-SHA256 signing key.
 * @param timestampHeader  Raw value of X-Releases-Timestamp.
 * @param rawBody  Raw UTF-8 request body.
 * @param signatureHeader  Raw value of X-Releases-Signature (expected "sha256=<hex>").
 * @param allowStale  When true, skip the timestamp-window check.
 * @param nowMs  Injectable clock (defaults to Date.now()).
 */
export async function verifyWebhookPayload(args: {
  signingKeyHex: string;
  timestampHeader: string;
  rawBody: string;
  signatureHeader: string;
  allowStale?: boolean;
  nowMs?: number;
}): Promise<VerifyResult> {
  // Strict integer match — parseInt would silently accept "1700000000junk"
  // and parse just the prefix, which would let a tampered header pass.
  if (!/^-?\d+$/.test(args.timestampHeader)) {
    return { ok: false, reason: "invalid_timestamp" };
  }
  const ts = Number(args.timestampHeader);
  if (!Number.isSafeInteger(ts)) {
    return { ok: false, reason: "invalid_timestamp" };
  }

  if (!args.allowStale) {
    const nowSec = Math.floor((args.nowMs ?? Date.now()) / 1000);
    if (Math.abs(nowSec - ts) > MAX_SKEW_SECONDS) {
      return { ok: false, reason: "timestamp_outside_window" };
    }
  }

  const keyBytes = hexToBytes(args.signingKeyHex);
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const data = enc.encode(`${ts}.${args.rawBody}`);
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, data);
  const expected = `sha256=${bytesToHex(sig)}`;

  if (!constantTimeEqual(expected, args.signatureHeader)) {
    return { ok: false, reason: "signature_mismatch" };
  }

  return { ok: true };
}

interface VerifyOpts {
  key: string;
  signature: string;
  timestamp: string;
  bodyFile?: string;
  body?: string;
  allowStale?: boolean;
}

export function registerWebhookCommand(parent: Command): void {
  const webhook = parent
    .command("webhook")
    .description("Manage your webhook subscriptions and verify signatures")
    .showSuggestionAfterError(true);

  registerWebhookManageCommands(webhook);

  webhook
    .command("verify")
    .description("Verify a webhook payload signature")
    .requiredOption("--key <hex>", "Hex-encoded signing key (from the webhook subscription)")
    .requiredOption("--signature <value>", "X-Releases-Signature header value (sha256=<hex>)")
    .requiredOption("--timestamp <value>", "X-Releases-Timestamp header value (Unix seconds)")
    .option("--body <string>", "Raw request body as a string")
    .option(
      "--body-file <path>",
      'Path to a file containing the raw request body, or "-" to read from stdin',
    )
    .option(
      "--allow-stale",
      "Skip the ±5 minute timestamp-window check (for verifying old captured payloads)",
    )
    .action(async (opts: VerifyOpts) => {
      // Exactly one of --body or --body-file is required. Use `!== undefined`
      // rather than truthy checks so an intentional empty payload (--body "")
      // is accepted and the exclusivity rule still fires.
      const hasBody = opts.body !== undefined;
      const hasBodyFile = opts.bodyFile !== undefined;
      if (!hasBody && !hasBodyFile) {
        console.error(chalk.red("Error: provide --body <string> or --body-file <path>"));
        process.exit(1);
      }
      if (hasBody && hasBodyFile) {
        console.error(chalk.red("Error: --body and --body-file are mutually exclusive"));
        process.exit(1);
      }

      const rawBody = hasBodyFile ? await readContentArg(opts.bodyFile!) : opts.body!;

      let result: VerifyResult;
      try {
        result = await verifyWebhookPayload({
          signingKeyHex: opts.key,
          timestampHeader: opts.timestamp,
          rawBody,
          signatureHeader: opts.signature,
          allowStale: opts.allowStale,
        });
      } catch (err) {
        // Malformed signing key or other internal error — surface as a clean
        // CLI failure instead of a stack trace.
        console.error(
          chalk.red(`✗ Verification error: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }

      if (result.ok) {
        console.log(chalk.green("✓ Signature valid"));
        return;
      }

      if (result.reason === "invalid_timestamp") {
        console.error(chalk.red("✗ Invalid timestamp: X-Releases-Timestamp is not a valid number"));
        process.exit(1);
      }

      if (result.reason === "timestamp_outside_window") {
        console.error(
          chalk.red(
            `✗ Timestamp outside ±${MAX_SKEW_SECONDS / 60}-minute window — pass --allow-stale to skip this check`,
          ),
        );
        process.exit(1);
      }

      // signature_mismatch
      console.error(chalk.red("✗ Signature mismatch"));
      process.exit(1);
    });
}
