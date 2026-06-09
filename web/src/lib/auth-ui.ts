/**
 * Master switch for the human-auth UI surface — the header sign-in/account control
 * and the `/login` + `/signup` routes. **Off unless `NEXT_PUBLIC_AUTH_UI_ENABLED`
 * is exactly `"true"`.**
 *
 * Keeps the surface dark in any environment that hasn't explicitly opted in —
 * notably production, where the Better Auth backend is live but human auth isn't
 * wired to anything yet and open email/password signup (no verification / auth
 * rate-limit tuning) shouldn't be publicly exposed. Flip it on in local dev (and
 * later in prod, once human auth has a purpose) to reveal the surface.
 *
 * `NEXT_PUBLIC_*` is inlined at build time, so this gates both the client header
 * control and the server-rendered route guards from a single value.
 */
export const AUTH_UI_ENABLED = process.env.NEXT_PUBLIC_AUTH_UI_ENABLED === "true";

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
