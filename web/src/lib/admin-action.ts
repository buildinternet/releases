import "server-only";
import { cookies } from "next/headers";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl, serverApiKey } from "./env";

/**
 * Resolve `{ apiUrl, apiSecret }` for an admin server action, where `apiSecret`
 * is a Bearer credential the admin API accepts:
 *
 *  - **Local dev** (`isLocalAdminEnabled()`): the root `RELEASES_API_KEY`, as before.
 *  - **Production**: a short-lived, per-user JWT minted from the CALLER's Better
 *    Auth session via `GET /api/auth/token`. Its scope is role-clamped at
 *    issuance, so the API authorizes the operation at the caller's role — a
 *    non-admin's token carries `read` only and admin routes 403. No shared
 *    admin secret sits on the web server; the only credential is the user's own.
 *
 * (Field name `apiSecret` is kept so the many `Bearer ${env.apiSecret}` call
 * sites are unchanged; it holds the root key in dev and the user JWT in prod.)
 */
export async function adminActionEnv(): Promise<
  { apiUrl: string; apiSecret: string } | { error: string }
> {
  const apiUrl = apiBaseUrl() ?? "http://localhost:3456";

  if (isLocalAdminEnabled()) {
    const apiSecret = serverApiKey();
    if (!apiSecret)
      return { error: "RELEASES_API_KEY (or legacy RELEASED_API_KEY) not configured." };
    return { apiUrl, apiSecret };
  }

  const jwt = await mintUserJwt(apiUrl);
  if (!jwt) return { error: "Admin actions require an admin session." };
  return { apiUrl, apiSecret: jwt };
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
