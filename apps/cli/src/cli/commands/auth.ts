import { Command } from "commander";
import chalk from "chalk";
import { join } from "node:path";
import { getDataDir } from "@buildinternet/releases-lib/config";
import { legacyEnv } from "@buildinternet/releases-lib/legacy-env";
import { getApiUrl, resolveCredential } from "../../lib/mode.js";
import {
  writeCredential,
  readCredential,
  clearCredential,
  type StoredCredential,
} from "../../lib/credentials.js";
import { revokePresentedKey, type RevokePresentedKeyResult } from "../../lib/device-auth.js";
import { retireStoredSession } from "../../lib/session.js";
import { hiddenPromptReader } from "../../lib/prompt-hidden.js";
import type { PromptReader } from "../../lib/confirm.js";
import { writeJson } from "../../lib/output.js";
import { RELEASES_CLI_UA } from "../../lib/user-agent.js";

export interface TokenIdentity {
  kind: "root" | "token";
  name: string;
  scopes: string[];
  principalType?: string;
  principalId?: string | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}

/** Verify a token against GET /v1/tokens/me. Throws a friendly Error on failure. */
export async function verifyToken(
  token: string,
  apiUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<TokenIdentity> {
  const res = await fetchFn(`${apiUrl}/v1/tokens/me`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": RELEASES_CLI_UA },
  });
  if (res.status === 401) throw new Error("Token rejected by the server (401).");
  if (!res.ok) throw new Error(`Server returned ${res.status} verifying the token.`);
  return (await res.json()) as TokenIdentity;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Resolve the token from --token (value or "-"), stdin, or an interactive prompt. */
export async function resolveTokenInput(
  optToken: string | undefined,
  reader: PromptReader,
): Promise<string> {
  if (optToken === "-") return readStdin();
  if (optToken) return optToken.trim();
  const entered = await reader("Paste your API token: ");
  if (entered === null) {
    throw new Error("No token provided. Pass --token <token> (or '-' to read from stdin).");
  }
  return entered.trim();
}

/** Shared status renderer used by `auth status` and `whoami`. */
export async function printAuthStatus(opts: { json?: boolean; verify?: boolean }): Promise<void> {
  const cred = resolveCredential();
  const apiUrl = getApiUrl();
  let identity: TokenIdentity | null = null;
  let verifyError: string | null = null;
  // Env-sourced tokens have no stored metadata, so verify to learn name/scopes.
  if (cred.token && (opts.verify || cred.source === "env")) {
    try {
      identity = await verifyToken(cred.token, apiUrl);
    } catch (err) {
      verifyError = (err as Error).message;
    }
  }
  const scopes = identity?.scopes ?? cred.scopes ?? null;
  const name = identity?.name ?? cred.name ?? null;

  if (opts.json) {
    await writeJson({
      authenticated: cred.token !== null,
      source: cred.source,
      apiUrl,
      name,
      scopes,
      verified: identity !== null,
      verifyError,
    });
    return;
  }

  const label = (k: string) => chalk.dim(k.padEnd(10));
  console.log(chalk.bold("releases auth\n"));
  console.log(
    `${label("Status")}${cred.token ? chalk.green("authenticated") : chalk.red("not authenticated")}`,
  );
  console.log(`${label("Source")}${cred.source === "none" ? chalk.dim("—") : cred.source}`);
  console.log(`${label("API URL")}${apiUrl}`);
  console.log(`${label("Name")}${name ?? chalk.dim("—")}`);
  console.log(`${label("Scopes")}${scopes ? scopes.join(", ") : chalk.dim("—")}`);
  if (verifyError) console.log(`${label("Verify")}${chalk.red(verifyError)}`);
  else if (identity) console.log(`${label("Verify")}${chalk.green("✓ live")}`);
}

export interface LogoutFlowDeps {
  readCredential?: () => StoredCredential | null;
  clearCredential?: () => boolean;
  retireStoredSession?: () => Promise<void>;
  revokePresentedKey?: (apiUrl: string, key: string) => Promise<RevokePresentedKeyResult>;
  /** Diagnostic notes only (server-revoke outcome) — never the final status line. */
  print?: (line: string) => void;
}

/**
 * `releases auth logout`: retire any legacy stored session, best-effort
 * self-revoke the stored `relu_` key server-side (no browser approval
 * needed — the key can revoke itself via `DELETE /v1/tokens/me`), then
 * ALWAYS delete the local credential file, regardless of whether the
 * server-side revoke succeeded. Local logout must never fail.
 */
export async function runLogoutFlow(deps: LogoutFlowDeps = {}): Promise<{ removed: boolean }> {
  const {
    readCredential: readCred = readCredential,
    clearCredential: clearCred = clearCredential,
    retireStoredSession: retire = () => retireStoredSession(),
    revokePresentedKey: revoke = revokePresentedKey,
    print = (l: string) => console.error(l),
  } = deps;

  // Retire any legacy session token left over from a credential saved before
  // session tokens stopped being persisted (best-effort sign-out).
  await retire();

  // Best-effort server-side revoke of the presented key itself. That route
  // only accepts a `relu_` key (400 otherwise), so skip it for a
  // manually-pasted `auth login` token of a different kind.
  const stored = readCred();
  if (stored?.token?.startsWith("relu_")) {
    const result = await revoke(stored.apiUrl, stored.token);
    if (!result.ok) {
      print(chalk.dim(`Could not revoke the stored key server-side: ${result.error}`));
    } else if (result.alreadyRevoked) {
      print(chalk.dim("Stored key was already revoked server-side."));
    }
  }

  const removed = clearCred();
  return { removed };
}

export function registerAuthCommand(parent: Command): void {
  const auth = parent.command("auth").description("Manage CLI authentication");

  auth
    .command("login")
    .description("Verify and store an API token")
    .option("--token <token>", "Token value, or '-' to read from stdin")
    .action(async (opts: { token?: string }) => {
      let token: string;
      try {
        token = await resolveTokenInput(opts.token, hiddenPromptReader);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
      if (!token) {
        console.error(chalk.red("No token provided."));
        process.exit(1);
      }
      const apiUrl = getApiUrl();
      let identity: TokenIdentity;
      try {
        identity = await verifyToken(token, apiUrl);
      } catch (err) {
        console.error(chalk.red(`✗ ${(err as Error).message} Not saved.`));
        process.exit(1);
      }
      const cred: StoredCredential = {
        token,
        name: identity.name,
        scopes: identity.scopes,
        apiUrl,
        savedAt: new Date().toISOString(),
      };
      writeCredential(cred);
      console.log(
        `${chalk.green("✓")} Verified — ${chalk.bold(identity.name)} ${chalk.dim(
          `(scopes: ${identity.scopes.join(", ")})`,
        )}`,
      );
      console.log(chalk.dim(`  Saved to ${join(getDataDir(), "credentials")}`));
    });

  auth
    .command("logout")
    .description("Remove the stored API token")
    .action(async () => {
      const { removed } = await runLogoutFlow();
      if (legacyEnv("RELEASES_API_KEY", "RELEASED_API_KEY")) {
        console.log(
          chalk.yellow(
            "Removed any stored token, but RELEASES_API_KEY is still set in your environment.",
          ),
        );
      } else if (removed) {
        console.log(`${chalk.green("✓")} Logged out (stored token removed).`);
      } else {
        console.log(chalk.dim("No stored token to remove."));
      }
    });

  auth
    .command("status")
    .description("Show authentication status")
    .option("--json", "Output as JSON")
    .option("--verify", "Re-check the token against the API")
    .action(async (opts: { json?: boolean; verify?: boolean }) => {
      await printAuthStatus(opts);
    });

  auth
    .command("token")
    .description("Print the current API token (for scripts)")
    .action(() => {
      const { token } = resolveCredential();
      if (!token) {
        console.error(
          chalk.red("Not authenticated. Run `releases auth login` or set RELEASES_API_KEY."),
        );
        process.exit(1);
      }
      process.stdout.write(`${token}\n`);
    });
}
