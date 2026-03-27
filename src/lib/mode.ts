import { logger } from "./logger.js";

// Cache env var reads — these don't change during process lifetime
let _remote: boolean | null = null;
let _apiUrl: string | null = null;
let _apiKey: string | null = null;

export function isRemoteMode(): boolean {
  if (_remote === null) _remote = !!process.env.RELEASED_API_URL;
  return _remote;
}

export function getApiUrl(): string {
  if (!_apiUrl) {
    const url = process.env.RELEASED_API_URL;
    if (!url) throw new Error("RELEASED_API_URL is not set");
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
 * Call at CLI startup when RELEASED_API_URL is set.
 * Validates that RELEASED_API_KEY is also present and exits with a clear message if not.
 */
export function validateRemoteMode(): void {
  if (!isRemoteMode()) return;

  if (!process.env.RELEASED_API_KEY) {
    logger.error("RELEASED_API_URL is set but RELEASED_API_KEY is missing.");
    logger.error("Set RELEASED_API_KEY to authenticate with the remote API.");
    process.exit(1);
  }
}
