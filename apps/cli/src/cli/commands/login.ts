import { hostname } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { getDataDir } from "@buildinternet/releases-lib/config";
import { getApiUrl } from "../../lib/mode.js";
import {
  writeCredential as writeCredentialToDisk,
  readCredential as readCredentialFromDisk,
  type StoredCredential,
} from "../../lib/credentials.js";
import { openBrowser } from "../../lib/open-browser.js";
import { retireStoredSession } from "../../lib/session.js";
import {
  runDeviceAuth,
  createUserApiKey,
  revokeKeyQuietly,
  signOutSession,
  type DeviceLoginDeps,
} from "../../lib/device-auth.js";

export interface LoginFlowDeps extends DeviceLoginDeps {
  readCredential?: () => StoredCredential | null;
  writeCredential?: (cred: StoredCredential) => void;
}

export interface LoginFlowArgs {
  apiUrl: string;
  openInBrowser: boolean;
  /** Name recorded on the minted key (`releases-cli (<hostname>)`). */
  keyName: string;
  deps?: LoginFlowDeps;
}

/**
 * `releases login`: device-authorize, mint a fresh read key, persist it
 * WITHOUT the session token (a full-account credential that never touches
 * disk), revoke the key the PREVIOUS credential for this same apiUrl pointed
 * at, then sign the session out. The revoke runs only after the new key is
 * stored, so a failed login never leaves the user keyless, and it's
 * best-effort. The sign-out is in a `finally`, so it runs even when minting,
 * the write, or the revoke fails. A credential with no `keyId` (saved before
 * #418, or via `auth login`) is left alone rather than guessed at.
 */
export async function runLoginFlow(args: LoginFlowArgs): Promise<StoredCredential> {
  const { readCredential = readCredentialFromDisk, writeCredential = writeCredentialToDisk } =
    args.deps ?? {};
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const print = args.deps?.print ?? ((l: string) => console.log(l));

  await retireStoredSession({
    print,
    readCredential,
    writeCredential,
    signOut: (apiUrl, sessionToken) => signOutSession(apiUrl, sessionToken, fetchImpl),
  });

  const previous = readCredential();
  const { sessionToken } = await runDeviceAuth({
    apiUrl: args.apiUrl,
    purpose: "login",
    openInBrowser: args.openInBrowser,
    deps: { ...args.deps, print },
  });

  try {
    const created = await createUserApiKey(args.apiUrl, sessionToken, args.keyName, fetchImpl);
    const cred: StoredCredential = {
      token: created.key,
      keyId: created.id,
      name: created.name ?? args.keyName,
      scopes: [created.scope ?? "read"],
      apiUrl: args.apiUrl,
      savedAt: new Date().toISOString(),
    };
    writeCredential(cred);

    print(
      `${chalk.green("Signed in")} ${chalk.dim(`(scopes: ${(cred.scopes ?? []).join(", ")})`)}`,
    );
    print(chalk.dim(`  Saved to ${join(getDataDir(), "credentials")}`));

    const replaced = previous?.apiUrl === args.apiUrl ? previous.keyId : undefined;
    if (replaced && replaced !== created.id) {
      const failure = await revokeKeyQuietly(args.apiUrl, sessionToken, replaced, fetchImpl);
      print(
        chalk.dim(
          failure
            ? `  Could not revoke the previous key (${replaced}): ${failure}`
            : `  Revoked previous key ${replaced}.`,
        ),
      );
    }
    return cred;
  } finally {
    const failure = await signOutSession(args.apiUrl, sessionToken, fetchImpl);
    if (failure) print(chalk.dim(`  Could not sign out: ${failure}`));
  }
}

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Sign in via your browser and store a read-only API key (device authorization)")
    .option("--no-browser", "Print the URL instead of opening a browser")
    .action(async (opts: { browser?: boolean }) => {
      try {
        await runLoginFlow({
          apiUrl: getApiUrl(),
          openInBrowser: opts.browser !== false,
          keyName: `releases-cli (${hostname()})`,
          deps: { openBrowser },
        });
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
