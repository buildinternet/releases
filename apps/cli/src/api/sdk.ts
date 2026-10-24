import { Releases, ReleasesError } from "@buildinternet/releases-sdk";
import { ApiError } from "../lib/errors.js";
import { getApiUrl } from "../lib/mode.js";
import { cliFetch, IDEMPOTENCY_CONFLICT_MESSAGE } from "./core.js";

/**
 * The CLI's client for public API routes, `@buildinternet/releases-sdk` over
 * the CLI's own transport (`cliFetch`: user agent, stored credential,
 * idempotency keys, mutation log). Built per call so it follows the current
 * API URL and credential. Internal routes the SDK doesn't cover stay on
 * `apiFetch`.
 */
export function sdk(): Releases {
  return new Releases({
    baseUrl: getApiUrl(),
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      cliFetch(String(input), init)) as typeof fetch,
  });
}

/**
 * A client that authenticates with `token` alone, never the stored admin key
 * or login. `releases publish` uses it with its publish token.
 */
export function sdkWithToken(token: string): Releases {
  return new Releases({
    baseUrl: getApiUrl(),
    apiKey: token,
    fetch: ((input: string | URL | Request, init?: RequestInit) =>
      cliFetch(String(input), { ...init, skipDefaultAuth: true })) as typeof fetch,
  });
}

/**
 * Run an SDK call under the CLI's error contract: a non-2xx response becomes
 * an `ApiError`, and a transport failure rethrows `cliFetch`'s error (which
 * carries the TLS-proxy hint).
 */
export async function call<T>(
  fn: (client: Releases) => Promise<T>,
  client: Releases = sdk(),
): Promise<T> {
  try {
    return await fn(client);
  } catch (err) {
    throw toCliError(err);
  }
}

/** `call` for a lookup: a 404 resolves to `null`, as `apiFetch` does for GETs. */
export async function find<T>(fn: (client: Releases) => Promise<T>): Promise<T | null> {
  try {
    return await fn(sdk());
  } catch (err) {
    if (err instanceof ReleasesError && err.status === 404) return null;
    throw toCliError(err);
  }
}

function toCliError(err: unknown): unknown {
  if (!(err instanceof ReleasesError)) return err;
  if (err.status === 0) return err.cause ?? err;
  return new ApiError({
    status: err.status,
    method: err.method,
    path: `/v1${err.path}`,
    serverMessage:
      err.status === 409 && err.code === "idempotency_conflict"
        ? IDEMPOTENCY_CONFLICT_MESSAGE
        : err.message,
  });
}
