/**
 * Shared browser-client helpers for the signed-in user surfaces on the API
 * worker (`/v1/me/*`, `/v1/api-keys`). Both talk to the Better Auth worker
 * origin with `credentials: "include"` so the cross-subdomain (`.releases.sh`)
 * session cookie rides along. Extracted from `follows.ts` / `api-keys.ts` so the
 * base-URL resolution and error-body unwrapping live in exactly one place.
 */

/** The API worker origin (`NEXT_PUBLIC_BETTER_AUTH_URL`), trailing slash stripped. */
export function apiBase(): string {
  const url = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  if (!url) throw new Error("NEXT_PUBLIC_BETTER_AUTH_URL is not set");
  // Callers append `/v1/...` themselves. A mistaken env value like
  // `https://api.releases.sh/v1` would otherwise double the prefix and hit the
  // public wildcard CORS layer — browsers block credentialed `*` responses.
  return url.replace(/\/+$/, "").replace(/\/v1$/, "");
}

/**
 * Pull a human-readable message off a non-ok JSON response, falling back to the
 * caller's default. Prefers the standardized `respondError` envelope
 * (`{ error: { message } }`), then a flat `message` if present. `|| fallback`
 * (not `??`) on purpose: an empty-string message is useless.
 */
export async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as {
      message?: string;
      error?: { message?: string } | string;
    };
    const nested =
      typeof body.error === "object" && body.error != null ? body.error.message : undefined;
    const flat = typeof body.message === "string" ? body.message : undefined;
    return nested || flat || fallback;
  } catch {
    return fallback;
  }
}

/** Match RSC settings bootstrap (`me-settings-server.ts`) so stalled requests fail closed. */
const ME_GET_TIMEOUT_MS = 10_000;

/** Credentialed GET against the API worker; throws with a human message on non-OK. */
export async function meGet<T>(path: string, fallback: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${apiBase()}${path}`, {
      credentials: "include",
      signal: AbortSignal.timeout(ME_GET_TIMEOUT_MS),
    });
  } catch {
    throw new Error(fallback);
  }
  if (!res.ok) throw new Error(await errorMessage(res, fallback));
  return (await res.json()) as T;
}
