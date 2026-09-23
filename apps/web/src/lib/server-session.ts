import "server-only";
import { cookies } from "next/headers";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "./env";

/**
 * The caller's Better Auth role, read server-side by forwarding the session
 * cookie to the API's `/api/auth/get-session`. Returns null for anonymous
 * callers or on any failure (fail-closed). Used to gate the `/admin` hub pages;
 * it forces dynamic rendering, which is fine for these low-traffic, non-cached
 * routes.
 */
async function getServerSessionRole(): Promise<string | null> {
  const base = apiBaseUrl();
  if (!base) return null;
  const cookie = (await cookies()).toString();
  if (!cookie) return null;
  try {
    const res = await fetch(`${base}/api/auth/get-session`, {
      headers: webApiHeaders({ Cookie: cookie }),
      cache: "no-store",
      // Bound the session read so a slow/unreachable API can't hang the
      // /admin page render; abort throws → caught → null (fail-closed).
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: { role?: string | null } } | null;
    return body?.user?.role ?? null;
  } catch {
    return null;
  }
}

/** Signed-in user from Better Auth, or null when anonymous / on failure. */
export async function getServerSessionUser(): Promise<{
  email: string;
  name: string | null;
} | null> {
  const base = apiBaseUrl();
  if (!base) return null;
  const cookie = (await cookies()).toString();
  if (!cookie) return null;
  try {
    const res = await fetch(`${base}/api/auth/get-session`, {
      headers: webApiHeaders({ Cookie: cookie }),
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as {
      user?: { email?: string; name?: string | null };
    } | null;
    const email = body?.user?.email?.trim();
    if (!email) return null;
    return { email, name: body?.user?.name ?? null };
  } catch {
    return null;
  }
}

/** True when the caller may view admin pages: the local-dev override, or an admin-role session. */
export async function isAdminViewer(): Promise<boolean> {
  if (isLocalAdminEnabled()) return true;
  return (await getServerSessionRole()) === "admin";
}
