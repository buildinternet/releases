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
  return url.replace(/\/$/, "");
}

/**
 * Pull a human-readable message off a non-ok JSON response, falling back to the
 * caller's default. `|| fallback` (not `??`) on purpose: an empty-string
 * `message` is useless, so treat it like an absent one and use the fallback.
 */
export async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}
