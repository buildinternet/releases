import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "@buildinternet/releases-lib/config";
import { logger } from "@buildinternet/releases-lib/logger";

export interface StoredCredential {
  token: string;
  /**
   * @deprecated No longer written. A device-flow session token is a
   * full-account credential (broader than `token` — it can manage the
   * account), so it is never persisted: `releases login`/`keys`/
   * `publish-token` establish one, use it, and sign it out in the same
   * command (see `withSession` in `./session.js`). This field is read-only
   * tolerance for a credential file saved before that change —
   * `retireStoredSession()` signs out and strips any value found here.
   */
  sessionToken?: string;
  /**
   * Server-side id of `token`, when it was minted via the device flow
   * (`releases login`). Lets a later `releases login` revoke the exact key
   * it's replacing instead of leaking a new one every run (#418). Absent on
   * credentials predating this field, or on a manually-pasted `auth login`
   * token — never guess it from `start`, which is only a few characters and
   * not unique enough to match safely.
   */
  keyId?: string;
  name?: string;
  scopes?: string[];
  /** API URL the token was verified against (prod/staging tokens don't cross DBs). */
  apiUrl: string;
  savedAt: string;
}

function credentialPath(): string {
  return join(getDataDir(), "credentials");
}

export function readCredential(): StoredCredential | null {
  const path = credentialPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredCredential;
    // The file is a trust boundary (it may be hand-edited or corrupt), so
    // validate the full shape and return null on any mismatch — callers can then
    // trust the returned StoredCredential matches its declared type.
    if (typeof parsed?.token !== "string" || !parsed.token) return null;
    if (typeof parsed.apiUrl !== "string" || !parsed.apiUrl) return null;
    if (typeof parsed.savedAt !== "string" || !parsed.savedAt) return null;
    if (parsed.name !== undefined && typeof parsed.name !== "string") return null;
    if (
      parsed.sessionToken !== undefined &&
      (typeof parsed.sessionToken !== "string" || !parsed.sessionToken)
    ) {
      return null;
    }
    if (parsed.keyId !== undefined && (typeof parsed.keyId !== "string" || !parsed.keyId)) {
      return null;
    }
    // `scopes` is optional, but if present it must be a string array — a malformed
    // value (e.g. a hand-edited string) would crash callers that iterate or
    // `.join` it (auth status, the admin scope pre-flight).
    if (
      parsed.scopes !== undefined &&
      (!Array.isArray(parsed.scopes) || !parsed.scopes.every((s) => typeof s === "string"))
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

function hardenWindowsAcl(path: string): void {
  const user = process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : process.env.USERNAME;
  if (!user) return; // can't identify the user; leave default ACLs
  try {
    execFileSync("icacls", [path, "/inheritance:r"], { stdio: "ignore" });
    execFileSync("icacls", [path, "/grant:r", `${user}:F`], { stdio: "ignore" });
  } catch (err) {
    logger.warn(`Could not restrict credential file permissions on Windows: ${String(err)}`);
  }
}

export function writeCredential(
  cred: StoredCredential,
  platform: NodeJS.Platform = process.platform,
): void {
  const path = credentialPath();
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write: temp file + rename so a crash never leaves a partial file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600); // no-op on Windows, harmless
  if (platform === "win32") hardenWindowsAcl(path);
}

/** Remove the stored credential. Returns true if a file was actually removed. */
export function clearCredential(): boolean {
  const path = credentialPath();
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
