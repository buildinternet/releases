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
    if (!bearer) return { error: "RELEASES_API_KEY (or legacy RELEASED_API_KEY) not configured." };
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
