import "server-only";
import { cookies } from "next/headers";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl, serverApiKey } from "./env";

/** Resolved admin credential: the API base URL and a Bearer token to present. */
export interface AdminActionEnv {
  apiUrl: string;
  bearer: string;
}

/**
 * Resolve `{ apiUrl, bearer }` for an admin server action, where `bearer` is a
 * Bearer credential the admin API accepts:
 *
 *  - **Local dev** (`isLocalAdminEnabled()`): the root `RELEASES_API_KEY`, as before.
 *  - **Production**: a short-lived, per-user JWT minted from the CALLER's Better
 *    Auth session via `GET /api/auth/token`. Its scope is role-clamped at
 *    issuance, so the API authorizes the operation at the caller's role — a
 *    non-admin's token carries `read` only and admin routes 403. No shared
 *    admin secret sits on the web server; the only credential is the user's own.
 */
export async function adminActionEnv(): Promise<AdminActionEnv | { error: string }> {
  const apiUrl = apiBaseUrl() ?? "http://localhost:3456";

  if (isLocalAdminEnabled()) {
    const bearer = serverApiKey();
    if (!bearer) return { error: "RELEASES_API_KEY not configured." };
    return { apiUrl, bearer };
  }

  const jwt = await mintUserJwt(apiUrl);
  if (!jwt) return { error: "Admin actions require an admin session." };
  return { apiUrl, bearer: jwt };
}

/**
 * Mint the caller's session JWT from `GET /api/auth/token`, forwarding the
 * incoming `.releases.sh` session cookie. Returns null when there is no session
 * (anonymous caller) or the request fails — the caller then surfaces an error.
 */
async function mintUserJwt(apiUrl: string): Promise<string | null> {
  const cookie = (await cookies()).toString();
  if (!cookie) return null;
  try {
    const res = await fetch(`${apiUrl}/api/auth/token`, {
      headers: webApiHeaders({ Cookie: cookie }),
      cache: "no-store",
      // Bound the mint so a slow/unreachable API can't hang an admin action
      // until the outer platform timeout; the abort throws → caught → null.
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  } catch {
    return null;
  }
}

const REQUEST_TIMEOUT_MS = 10_000;

/** Result shape every admin server action returns; failures never throw. */
export type AdminResult<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Admin fetch that parses the JSON body. The credential is resolved by
 * `adminActionEnv()` — the root key in local dev, or the caller's role-clamped
 * per-user JWT in production (the API enforces `admin` scope). Every failure
 * mode — no admin credential, network error, timeout, non-2xx, or malformed
 * body — is normalized to an `{ ok: false; error }` result so callers never throw.
 *
 * Pass a pre-resolved `env` to reuse one credential across several calls — a
 * multi-step action (e.g. `revokeTokenAction`'s lookup-then-revoke) otherwise
 * re-mints the per-user JWT once per call.
 */
export async function adminFetch<T>(
  path: string,
  init?: RequestInit,
  env?: AdminActionEnv,
): Promise<AdminResult<T>> {
  const resolved = env ?? (await adminActionEnv());
  if ("error" in resolved) return { ok: false, error: resolved.error };
  let res: Response;
  try {
    res = await fetch(`${resolved.apiUrl}${path}`, {
      cache: "no-store",
      ...init,
      headers: webApiHeaders({
        ...(init?.headers as Record<string, string> | undefined),
        Authorization: `Bearer ${resolved.bearer}`,
        "Content-Type": "application/json",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
      return { ok: false, error: `Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s.` };
    }
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return { ok: false, error: `API ${res.status}: ${text || res.statusText}` };
  }
  try {
    return { ok: true, data: (await res.json()) as T };
  } catch {
    return { ok: false, error: `API ${res.status}: malformed response body` };
  }
}
