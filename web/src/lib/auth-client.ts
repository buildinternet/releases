import { createAuthClient } from "better-auth/react";
import { oneTapClient, magicLinkClient } from "better-auth/client/plugins";
import { dashClient } from "@better-auth/infra/client";

/**
 * Google One Tap client id. Unlike the worker's `GOOGLE_CLIENT_ID` (a server
 * secret), One Tap renders Google's popup in the browser, so the SAME client id
 * must be exposed PUBLICLY here via `NEXT_PUBLIC_GOOGLE_CLIENT_ID`. Unset (the
 * default) → the One Tap plugin is not registered, `authClient.oneTap` is
 * undefined, and consumers fall back to the redirect-based Google button. Also
 * requires the web origin under Google Cloud Console → Authorized JavaScript
 * origins, or Google silently refuses to render the prompt.
 */
const GOOGLE_ONE_TAP_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;

/**
 * Better Auth browser client. Points at the API worker (where the auth instance
 * lives), NOT the web origin — `NEXT_PUBLIC_BETTER_AUTH_URL` must be the worker
 * base URL (prod: https://api.releases.sh, local: https://api.releases.localhost).
 *
 * `credentials: "include"` is required so the browser sends/stores the session
 * cookie on these cross-subdomain (same-site) requests; it pairs with the
 * credentialed CORS the worker serves on `/api/auth/*`.
 *
 * Consumed by the auth UI (`auth-form.tsx`, `account-nav.tsx`). When
 * `NEXT_PUBLIC_BETTER_AUTH_URL` is unset the client would fall back to the
 * current origin (which has no auth handler), so that env var must be set
 * wherever the client is actually used.
 */
export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_BETTER_AUTH_URL,
  fetchOptions: { credentials: "include" },
  plugins: [
    // Client half of Better Auth Infrastructure ("dash"). Pairs with the server-side
    // dash() plugin (workers/api/src/auth/index.ts) so the hosted dashboard's
    // admin/audit endpoints are reachable from this client. No API key here — the
    // client plugin only exposes the endpoints; the key lives server-side.
    dashClient(),
    // Magic link — registers the `signIn.magicLink` method. No secret and nothing to
    // gate at construction (mirrors the always-on server plugin); whether the UI
    // surfaces a button is controlled separately by NEXT_PUBLIC_AUTH_MAGIC_LINK in
    // auth-form.tsx. Registering it here unconditionally just makes the method
    // available — it's inert until a caller invokes it.
    magicLinkClient(),
    // Google One Tap — only when its public client id is configured. Mirrors the
    // server seam: the worker registers oneTap() only when Google's secrets resolve,
    // and this bundle reveals it only when the public id is present. Omitted → no
    // Google GSI script loads and `authClient.oneTap` stays undefined.
    ...(GOOGLE_ONE_TAP_CLIENT_ID ? [oneTapClient({ clientId: GOOGLE_ONE_TAP_CLIENT_ID })] : []),
  ],
});

export const {
  signIn,
  signUp,
  signOut,
  useSession,
  getSession,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  oneTap,
} = authClient;
