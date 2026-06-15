import { createAuthClient } from "better-auth/react";
import type { BetterAuthClientPlugin } from "better-auth/client";
import {
  oneTapClient,
  magicLinkClient,
  deviceAuthorizationClient,
  lastLoginMethodClient,
} from "better-auth/client/plugins";
import { dashClient, sentinelClient } from "@better-auth/infra/client";

/**
 * `@better-auth/infra`'s client plugins ship `.d.ts` types built against an OLDER
 * `better-auth` (its devDependency is pinned to 1.6.15), so under a newer core the
 * `getActions` signature on its plugins no longer structurally matches the one
 * `BetterAuthClientPlugin` now requires. A single non-conforming element in the
 * `plugins` tuple poisons the whole client's inferred type — stripping `passkey`,
 * `oneTap`, `magicLink`, `device`, etc. — and breaks `next build`'s type check (#1620).
 *
 * This swaps ONLY the offending `getActions` member for the shape the current core
 * expects, preserving each plugin's `id` / `$InferServerPlugin` / `pathMethods` so
 * session and action inference for the rest of the client stay intact (a blanket
 * cast to `BetterAuthClientPlugin` instead erases `$InferServerPlugin` and collapses
 * `useSession()` to `never`). We never call dash/sentinel action methods on the
 * client — they're registered only for their endpoint + fetch-hook side effects — so
 * narrowing `getActions` is lossless. Drop once `@better-auth/infra` ships types
 * built against this core.
 */
const asClientPlugin = <P>(p: P) =>
  p as unknown as Omit<P, "getActions"> & Pick<BetterAuthClientPlugin, "getActions">;
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
import { passkeyClient } from "@better-auth/passkey/client";

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
 * Sentinel project-scoped identify ingestion endpoint — the browser POSTs its
 * device-identify data here. Must be the SAME project URL the worker passes to the
 * server `sentinel()` plugin as `kvUrl` (its `BETTER_AUTH_IDENTIFY_URL`, e.g.
 * `https://kv.better-auth.com/projects/<id>`), exposed publicly here because the
 * ingestion call happens client-side. Unset → the client falls back to Better Auth's
 * default GLOBAL ingestion endpoint and logs "Default global identify ingestion is
 * active but not recommended" — functional, but the client telemetry isn't scoped to
 * our project. Setting it silences that warning and scopes identify to our project.
 */
const SENTINEL_IDENTIFY_URL = process.env.NEXT_PUBLIC_BETTER_AUTH_IDENTIFY_URL;

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
    asClientPlugin(dashClient()),
    // Client half of Sentinel (the server-side sentinel() plugin lives in
    // workers/api/src/auth/index.ts). It attaches a stable device fingerprint via
    // the `X-Visitor-Id` header (feeding credential-stuffing + abuse detection) and,
    // with `autoSolveChallenge`, transparently solves the server's Proof-of-Work
    // challenge and retries — so a legit user briefly caught by a "challenge" action
    // (bots / suspicious IP) sails through instead of seeing a 423. No API key here
    // (it lives server-side); inert when the server plugin isn't mounted. Registered
    // unconditionally, like dashClient(). `identifyUrl` points client-side identify
    // ingestion at our project endpoint (see SENTINEL_IDENTIFY_URL); omitted when unset
    // so local dev just falls back to the library default.
    asClientPlugin(
      sentinelClient({
        autoSolveChallenge: true,
        ...(SENTINEL_IDENTIFY_URL ? { identifyUrl: SENTINEL_IDENTIFY_URL } : {}),
      }),
    ),
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
    // Device authorization (RFC 8628) — the browser half of `releases login`.
    // Registers `authClient.device()` (verify a user code) plus `device.approve` /
    // `device.deny`, used by the /device and /device/approve pages. Takes no options
    // (so nothing to gate at construction); the pages themselves are flag-gated.
    // The CLI does NOT use this client — it speaks the raw HTTP endpoints directly.
    deviceAuthorizationClient(),
    // Last-login-method (client half). Reads the non-httpOnly
    // `better-auth.last_used_login_method` cookie the server plugin sets — scoped
    // to `.releases.sh`, so it's readable here on the web origin even though the
    // worker (api.releases.sh) set it — and exposes `getLastUsedLoginMethod()` /
    // `isLastUsedLoginMethod()`. The sign-in form uses it to badge the method the
    // returning user last used. Cookie carries only a method name, no PII.
    lastLoginMethodClient(),
    // OAuth provider client — registers ONLY a fetch hook that injects the signed
    // `oauth_query` into consent POSTs. It does NOT register callable action
    // methods: `authClient.oauth2Consent(...)` would fall through to the generic
    // proxy and hit `/oauth2-consent` (404) instead of `/oauth2/consent`. So the
    // /oauth/consent page calls the endpoints by their LITERAL paths via
    // `authClient.$fetch("/oauth2/consent" | "/oauth2/public-client", …)`; the hook
    // still wraps those. Inert until that page calls it.
    oauthProviderClient(),
    // Passkeys (WebAuthn / FIDO2) — client half of the always-on server `passkey()`
    // plugin. Registers `authClient.passkey.*` (add / list / rename / delete) and
    // `signIn.passkey` (used by the /account passkeys panel and the sign-in form's
    // passkey button + conditional-UI autofill). Takes no options; the relying-party
    // config lives server-side. Inert until a caller invokes it.
    passkeyClient(),
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
  getLastUsedLoginMethod,
  passkey,
  // Account-settings self-service. These are core Better Auth actions (no plugin):
  // `changeEmail` requests a confirmation link to the current address (server gated
  // on `user.changeEmail.enabled`), and `listAccounts` / `linkSocial` /
  // `unlinkAccount` manage the user's linked credential + social accounts.
  changeEmail,
  listAccounts,
  linkSocial,
  unlinkAccount,
} = authClient;
