/**
 * Shared admin API client for scripts/.
 *
 * Reads RELEASES_API_URL / RELEASES_API_KEY once at module scope. All helpers
 * prepend "/v1" to the path argument, so callers pass bare resource paths
 * (e.g. "/admin/batch-runs").
 *
 * Two error semantics:
 *
 *   throwOnError: false (default) — best-effort. Returns null / void silently
 *     when the key is absent, the request times out, or the server returns a
 *     non-2xx. Meant for fire-and-forget observability writes where failure
 *     must not abort a larger operation.
 *
 *   throwOnError: true — required. Throws when the key is absent or the
 *     request fails. Meant for reads and writes that are load-bearing.
 *
 * Timeout defaults:
 *   - best-effort calls: 3 000 ms (matches the original generate-release-content.ts)
 *   - required calls:    10 000 ms
 *   Override per-call with opts.timeoutMs. Pass opts.signal to layer in an
 *   external AbortSignal (e.g. from a cron cancellation fence).
 */

import { logger } from "@buildinternet/releases-lib/logger";

const BASE_URL = (
  process.env.RELEASES_API_URL ??
  process.env.RELEASED_API_URL ??
  "https://api.releases.sh"
).replace(/\/$/, "");
const API_KEY = process.env.RELEASES_API_KEY ?? process.env.RELEASED_API_KEY;
const STAGING_KEY = process.env.STAGING_ACCESS_KEY;

// ── Defaults ─────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_BEST_EFFORT = 3_000;
const DEFAULT_TIMEOUT_REQUIRED = 10_000;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface AdminClientOptions {
  /** true = throw on any error; false (default) = best-effort, return null/void */
  throwOnError?: boolean;
  /** timeout in ms; defaults differ by mode (see above) */
  timeoutMs?: number;
  /** external abort signal (composed with the internal timeout signal) */
  signal?: AbortSignal;
}

// ── Internal ──────────────────────────────────────────────────────────────────

function resolveTimeout(opts: AdminClientOptions | undefined): number {
  if (opts?.timeoutMs !== undefined) return opts.timeoutMs;
  return opts?.throwOnError ? DEFAULT_TIMEOUT_REQUIRED : DEFAULT_TIMEOUT_BEST_EFFORT;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

/**
 * Compose an internal AbortController (timeout) with an optional external
 * signal from the caller. Returns the composed signal and a cleanup function
 * that must be called after the request completes.
 */
function makeSignal(
  timeoutMs: number,
  external?: AbortSignal,
): { signal: AbortSignal; cleanup: () => void; isTimeout: () => boolean } {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let onAbort: (() => void) | null = null;
  if (external) {
    // If the external signal is already aborted, propagate immediately.
    if (external.aborted) {
      controller.abort();
    } else {
      onAbort = () => controller.abort();
      external.addEventListener("abort", onAbort);
    }
  }

  const cleanup = () => {
    clearTimeout(timer);
    if (external && onAbort) {
      external.removeEventListener("abort", onAbort);
    }
  };

  return { signal: controller.signal, cleanup, isTimeout: () => timedOut };
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  opts?: AdminClientOptions,
): Promise<T | null> {
  const required = opts?.throwOnError ?? false;

  if (!API_KEY) {
    if (required) {
      throw new Error("RELEASES_API_KEY is not set");
    }
    return null;
  }

  const timeoutMs = resolveTimeout(opts);
  const { signal, cleanup, isTimeout } = makeSignal(timeoutMs, opts?.signal);

  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    Accept: "application/json",
  };
  if (STAGING_KEY) {
    headers["X-Releases-Staging-Key"] = STAGING_KEY;
  }
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }

  try {
    const res = await fetch(`${BASE_URL}/v1${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      const msg = `${method} /v1${path} → ${res.status}: ${text.slice(0, 200)}`;
      if (required) {
        throw new Error(msg);
      }
      logger.warn(msg);
      return null;
    }

    // For methods that don't return a body (DELETE, PATCH returning 204)
    if (res.status === 204 || res.headers.get("content-length") === "0") {
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError" && isTimeout()) {
      if (required)
        throw new Error(`${method} /v1${path} timed out after ${timeoutMs}ms`, { cause: err });
      return null;
    }
    if (required) throw err;
    logger.warn(`${method} /v1${path} failed: ${errorMessage(err)}`);
    return null;
  } finally {
    cleanup();
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function adminGet<T>(path: string, opts?: AdminClientOptions): Promise<T | null> {
  return request<T>("GET", path, undefined, opts);
}

export async function adminPost<T>(
  path: string,
  body: unknown,
  opts?: AdminClientOptions,
): Promise<T | null> {
  return request<T>("POST", path, body, opts);
}

export async function adminPatch(
  path: string,
  body: unknown,
  opts?: AdminClientOptions,
): Promise<void> {
  await request<never>("PATCH", path, body, opts);
}

export async function adminDelete(path: string, opts?: AdminClientOptions): Promise<void> {
  await request<never>("DELETE", path, undefined, opts);
}
