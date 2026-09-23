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
 * Whether the CURRENT browser origin can actually complete an auth flow, or is a
 * preview/branch deployment where sign-in is structurally broken.
 *
 * Auth is pinned to the canonical web-domain family derived from the API worker
 * base (`NEXT_PUBLIC_BETTER_AUTH_URL`): the worker drops that host's leftmost
 * label to scope the session cookie cross-subdomain (`api.releases.sh` →
 * `.releases.sh`), its credentialed CORS reflects only that family, and the
 * passkey relying-party id is the web hostname. So from an off-family origin —
 * e.g. a Vercel branch deploy like `*.vercel.app` — every path fails at once:
 * the `.releases.sh` cookie is never sent (cross-site, blocked outright on
 * mobile), CORS rejects the origin, and WebAuthn throws a `SecurityError` on the
 * rpID mismatch. The visible symptom is a generic "couldn't sign in" with no
 * hint that the deployment URL is the cause — this lets the UI say so instead.
 *
 * `deriveCookieDomain()` in `workers/api/src/auth/index.ts` is the server twin of
 * this leftmost-label drop; keep the two in step.
 *
 * Returns `{ supported: false, canonicalOrigin }` on an off-family origin so the
 * caller can warn and point users at the real site, or `{ supported: true }`
 * everywhere auth can work (the common case) AND whenever support can't be
 * determined (no `window`, auth URL unset/unparseable, or a base host we can't
 * meaningfully split) — fail open, never warn spuriously.
 */
export function authOriginSupport():
  | { supported: true }
  | { supported: false; canonicalOrigin: string } {
  const authUrl = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  if (!authUrl || typeof window === "undefined") return { supported: true };
  let base: URL;
  try {
    base = new URL(authUrl);
  } catch {
    return { supported: true };
  }
  // Mirror deriveCookieDomain: the registrable base is the worker host minus its
  // leftmost label (api.releases.sh → releases.sh). A result with no dot left
  // (e.g. a bare `api.localhost` → `localhost`) is too coarse to scope a
  // cross-site cookie to, so we can't reason about it — fail open.
  const labels = base.hostname.split(".");
  if (labels.length < 2) return { supported: true };
  const baseDomain = labels.slice(1).join(".");
  if (!baseDomain.includes(".")) return { supported: true };
  const host = window.location.hostname;
  if (host === baseDomain || host.endsWith(`.${baseDomain}`)) return { supported: true };
  return { supported: false, canonicalOrigin: `${base.protocol}//${baseDomain}` };
}

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

/**
 * The email to SHOW the user, preferring the original-cased `displayEmail` the
 * backend captures from the OAuth profile (e.g. `Dunn.zach@gmail.com`) over the
 * canonical `email`, which the Sentinel `emailNormalization` pass lowercases and
 * (for Gmail) strips dots from (`dunnzach@gmail.com`). Falls back to `email` for
 * rows without a display form — existing users and email/password sign-ups, where
 * no provider profile carried the original. `displayEmail` is a server-set Better
 * Auth additional field present on the session user at runtime but absent from the
 * client's inferred `useSession` type, so it's read via a narrow cast here. Never
 * use this where the canonical address is required (sign-in identity, dedup, where
 * to send mail) — only for display.
 */
export function displayEmailOf(user: { email: string; displayEmail?: string | null }): string {
  const display = (user as { displayEmail?: unknown }).displayEmail;
  return typeof display === "string" && display ? display : user.email;
}
