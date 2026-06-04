import { createAuthClient } from "better-auth/react";
import { dashClient } from "@better-auth/infra/client";

/**
 * Better Auth browser client. Points at the API worker (where the auth instance
 * lives), NOT the web origin — `NEXT_PUBLIC_BETTER_AUTH_URL` must be the worker
 * base URL (prod: https://api.releases.sh, local: https://api.releases.localhost).
 *
 * `credentials: "include"` is required so the browser sends/stores the session
 * cookie on these cross-subdomain (same-site) requests; it pairs with the
 * credentialed CORS the worker serves on `/api/auth/*`.
 *
 * No UI consumes this yet — it's the wired-but-unused client seam for the first
 * login surface. When `NEXT_PUBLIC_BETTER_AUTH_URL` is unset the client would
 * fall back to the current origin (which has no auth handler), so that env var
 * must be set wherever the client is actually used.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
  fetchOptions: { credentials: "include" },
  // Client half of Better Auth Infrastructure ("dash"). Pairs with the server-side
  // dash() plugin (workers/api/src/auth/index.ts) so the hosted dashboard's
  // admin/audit endpoints are reachable from this client. No API key here — the
  // client plugin only exposes the endpoints; the key lives server-side.
  plugins: [dashClient()],
});

export const { signIn, signUp, signOut, useSession, getSession } = authClient;
