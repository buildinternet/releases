import { logger } from "./logger.js";

const DEFAULT_API_URL = "https://api.releases.sh";

// Cache env var reads — these don't change during process lifetime
let _remote: boolean | null = null;
let _admin: boolean | null = null;
let _apiUrl: string | null = null;
let _apiKey: string | null = null;

/** Compiled binaries lack local SQLite support, so always use remote mode. */
function isCompiledBinary(): boolean {
  return !process.argv[1]?.endsWith(".ts");
}

export function isRemoteMode(): boolean {
  if (_remote === null) _remote = !!process.env.RELEASED_API_URL || isCompiledBinary();
  return _remote;
}

/**
 * Admin mode is enabled when an API key is configured.
 * Public users see only consumer commands.
 */
export function isAdminMode(): boolean {
  if (_admin === null) {
    _admin = !!process.env.RELEASED_API_KEY;
  }
  return _admin;
}

export function getApiUrl(): string {
  if (!_apiUrl) {
    const url = process.env.RELEASED_API_URL || DEFAULT_API_URL;
    _apiUrl = url.replace(/\/$/, "");
  }
  return _apiUrl;
}

export function getApiKey(): string {
  if (!_apiKey) {
    const key = process.env.RELEASED_API_KEY;
    if (!key) throw new Error("RELEASED_API_KEY is not set");
    _apiKey = key;
  }
  return _apiKey;
}

/**
 * Call at CLI startup. Validates remote mode configuration.
 * - Explicit RELEASED_API_URL without RELEASED_API_KEY is an error (likely misconfigured admin setup).
 * - Compiled binaries default to remote mode and work without any env vars (public consumer access).
 */
export function validateRemoteMode(): void {
  if (!isRemoteMode()) return;

  // Only enforce API key when the URL was explicitly set (admin/operator use)
  if (process.env.RELEASED_API_URL && !process.env.RELEASED_API_KEY) {
    logger.error("RELEASED_API_URL is set but RELEASED_API_KEY is missing.");
    logger.error("Set RELEASED_API_KEY to authenticate with the remote API.");
    process.exit(1);
  }
}
