import chalk from "chalk";
import {
  readCredential as readCredentialFromDisk,
  writeCredential as writeCredentialToDisk,
  type StoredCredential,
} from "./credentials.js";
import { runDeviceAuth, signOutSession, type DevicePurpose } from "./device-auth.js";
import { openBrowser } from "./open-browser.js";

/**
 * Injectable device-flow entry points (production uses the real RFC 8628 flow;
 * tests inject deterministic stand-ins).
 */
export interface SessionDeps {
  /** Runs the device flow for `purpose` and returns a fresh session token. */
  deviceAuth?: (apiUrl: string, purpose: DevicePurpose) => Promise<string>;
  /** Best-effort session sign-out; returns the failure message or null. */
  signOut?: (apiUrl: string, sessionToken: string) => Promise<string | null>;
  print?: (line: string) => void;
  readCredential?: () => StoredCredential | null;
  writeCredential?: (cred: StoredCredential) => void;
  /**
   * Whether the DEFAULT device-auth flow should try to launch a real browser
   * (`releases keys ... --no-browser` etc. thread their flag through here).
   * Defaults to true. Ignored when `deviceAuth` is overridden — an injected
   * `deviceAuth` (every test in this repo) never reaches the real opener at
   * all, since it replaces `defaultDeviceAuth` entirely.
   */
  openInBrowser?: boolean;
}

// `withSession` backs commands whose stdout must stay machine-readable
// (`releases keys create --json`, `releases publish-token create | gh secret
// set ...`), but the device flow it runs still needs to talk to the human
// approving it in a browser. Every line that flow prints — the verify URL,
// user code, "Opening your browser…", "Waiting for authorization…",
// "Authorized as …", and any sign-out failure note — goes to stderr so it
// never pollutes a piped or `--json` stdout.
const defaultPrint = (line: string): void => {
  process.stderr.write(`${line}\n`);
};

function defaultDeviceAuth(
  apiUrl: string,
  purpose: DevicePurpose,
  openInBrowser: boolean,
): Promise<string> {
  return runDeviceAuth({
    apiUrl,
    purpose,
    openInBrowser,
    deps: { openBrowser, print: defaultPrint },
  }).then((r) => r.sessionToken);
}

function defaultSignOut(apiUrl: string, sessionToken: string): Promise<string | null> {
  return signOutSession(apiUrl, sessionToken);
}

/**
 * Run `fn` with a freshly established, one-shot device-flow session for
 * `purpose`, then sign that session out — even if `fn` throws. Every call to
 * a session-authed command (`releases keys …`, `releases publish-token …`)
 * opens exactly one browser approval and closes it out right after, rather
 * than keeping a signed-in session on disk between commands.
 */
export async function withSession<T>(
  apiUrl: string,
  purpose: DevicePurpose,
  fn: (sessionToken: string) => Promise<T>,
  deps: SessionDeps = {},
): Promise<T> {
  await retireStoredSession(deps);

  const sessionToken = await (
    deps.deviceAuth ??
    ((u: string, p: DevicePurpose) => defaultDeviceAuth(u, p, deps.openInBrowser ?? true))
  )(apiUrl, purpose);
  try {
    return await fn(sessionToken);
  } finally {
    const print = deps.print ?? defaultPrint;
    const failure = await (deps.signOut ?? defaultSignOut)(apiUrl, sessionToken);
    if (failure) print(chalk.dim(`Could not sign out: ${failure}`));
  }
}

/**
 * Best-effort retirement of a legacy stored session token (from a credential
 * file saved before session tokens stopped being persisted). Signs it out
 * against the credential's own apiUrl and rewrites the credential without it.
 * Quiet on success — this is invisible cleanup, not something worth
 * announcing — and prints a dim note only if the sign-out itself fails.
 * Called at the start of `withSession`, `releases login`, and
 * `releases auth logout` so a legacy session never lingers.
 */
export async function retireStoredSession(deps: SessionDeps = {}): Promise<void> {
  const readCredential = deps.readCredential ?? readCredentialFromDisk;
  const writeCredential = deps.writeCredential ?? writeCredentialToDisk;

  const existing = readCredential();
  if (!existing?.sessionToken) return;

  const print = deps.print ?? defaultPrint;
  const failure = await (deps.signOut ?? defaultSignOut)(existing.apiUrl, existing.sessionToken);
  if (failure) print(chalk.dim(`Could not sign out the previous session: ${failure}`));

  const { sessionToken: _drop, ...rest } = existing;
  writeCredential({ ...rest, savedAt: new Date().toISOString() });
}
