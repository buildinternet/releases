/**
 * Whether the human-auth UI surface (header sign-in/account control, `/login` +
 * `/signup`, password reset, passkeys, etc.) can function — i.e. the Better Auth
 * client base URL is configured. This is an **environment prerequisite, not a
 * feature flag**: without `NEXT_PUBLIC_BETTER_AUTH_URL` the client resolves
 * `/api/auth/*` against the *web* origin (which has no auth handler) and
 * `useSession` 404s every page, so the surface must stay dark. The prior
 * `NEXT_PUBLIC_AUTH_UI_ENABLED` master kill-switch has been retired — human auth is
 * live (email verification is required, brute-force rate limiting is on), so the
 * surface is no longer gated behind an explicit opt-in; it simply follows whether
 * the backend URL is wired. `NEXT_PUBLIC_*` is inlined at build time, so this gates
 * both the client header control and the server-rendered route guards.
 */
export const AUTH_CONFIGURED = Boolean(process.env.NEXT_PUBLIC_BETTER_AUTH_URL);

/**
 * Reveal the self-serve API Keys panel (`/account`). **Off unless
 * `NEXT_PUBLIC_USER_API_KEYS` is exactly `"true"`.** Mirrors the server-side
 * `user-api-keys-enabled` Flagship flag so the panel stays dark until the backend
 * accepts `relu_` keys. `NEXT_PUBLIC_*` is inlined at build time.
 */
export const USER_API_KEYS_ENABLED = process.env.NEXT_PUBLIC_USER_API_KEYS === "true";

/**
 * Reveal the device-authorization verification pages (`/device`, `/device/approve`)
 * that back `releases login` from the CLI. **Off unless
 * `NEXT_PUBLIC_DEVICE_AUTH_ENABLED` is exactly `"true"`.** The backend always
 * registers the device plugin now, so this web flag alone gates whether the
 * pages are revealed. `NEXT_PUBLIC_*` is inlined at build time.
 */
export const DEVICE_AUTH_ENABLED = process.env.NEXT_PUBLIC_DEVICE_AUTH_ENABLED === "true";
