import { logger } from "@buildinternet/releases-lib/logger";
import { legacyEnv } from "@buildinternet/releases-lib/legacy-env";
import { readCredential } from "./credentials.js";

const DEFAULT_API_URL = "https://api.releases.sh";

export interface ResolvedCredential {
  token: string | null;
  source: "env" | "file" | "none";
  scopes?: string[];
  name?: string;
  apiUrl?: string;
}

/** Resolve the active credential: explicit env var wins, then the stored file. */
export function resolveCredential(): ResolvedCredential {
  const envKey = legacyEnv("RELEASES_API_KEY", "RELEASED_API_KEY");
  if (envKey) return { token: envKey, source: "env" };
  const stored = readCredential();
  if (stored) {
    return {
      token: stored.token,
      source: "file",
      scopes: stored.scopes,
      name: stored.name,
      apiUrl: stored.apiUrl,
    };
  }
  return { token: null, source: "none" };
}

/** True when any credential resolves (env var or stored file). */
export function isAuthenticated(): boolean {
  return resolveCredential().token !== null;
}

/** Back-compat alias — historically "admin mode" meant "a credential is present". */
export const isAdminMode = isAuthenticated;

// Deliberately NOT memoized. A previous version cached this into a
// module-level `_apiUrl` on first call, which is harmless for a real CLI
// invocation (one process, one env) but poisons `bun test`: all test files
// share one process, so whichever file calls this first locks the base URL
// for the entire run and any file that sets RELEASES_API_URL afterward gets
// the stale value instead (see #388). Re-reading the env var per call is
// cheap (string compare + a regex) and removes the whole class of bug.
export function getApiUrl(): string {
  const url = legacyEnv("RELEASES_API_URL", "RELEASED_API_URL") || DEFAULT_API_URL;
  return url.replace(/\/$/, "");
}

export function getApiKey(): string {
  const { token } = resolveCredential();
  if (!token) {
    throw new Error("Not authenticated. Run `releases auth login` or set RELEASES_API_KEY.");
  }
  return token;
}

/**
 * Call at CLI startup. With stored credentials, a custom RELEASES_API_URL is no
 * longer fatal (you may be about to `releases auth login`, or doing anonymous
 * reads) — it downgrades to a warning. Also warns when a stored token was
 * verified against a different environment than the active URL.
 */
export function validateConfig(): void {
  const cred = resolveCredential();
  if (legacyEnv("RELEASES_API_URL", "RELEASED_API_URL") && cred.source === "none") {
    logger.warn(
      "RELEASES_API_URL is set but no API token is configured. Requests will be unauthenticated — run `releases auth login` to authenticate.",
    );
  }
  if (cred.source === "file" && cred.apiUrl && cred.apiUrl !== getApiUrl()) {
    logger.warn(
      `Stored token was verified against ${cred.apiUrl}, but the active API URL is ${getApiUrl()}. It may not be accepted.`,
    );
  }
}
