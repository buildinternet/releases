import "server-only";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { apiBaseUrl, serverApiKey } from "./env";

/**
 * Resolve the API base URL + admin secret for a dev-local admin server action,
 * or return an error when the local-admin gate is closed or the key is unset.
 * Shared by the org/release admin actions so the gate + env resolution lives
 * in one place. Re-checks the gate here as defense-in-depth — a stray
 * invocation in production cannot mutate state.
 */
export function adminActionEnv(): { apiUrl: string; apiSecret: string } | { error: string } {
  if (!isLocalAdminEnabled()) {
    return { error: "Admin actions are disabled in this environment." };
  }
  const apiUrl = apiBaseUrl() ?? "http://localhost:3456";
  const apiSecret = serverApiKey();
  if (!apiSecret) return { error: "RELEASED_API_KEY not configured." };
  return { apiUrl, apiSecret };
}
