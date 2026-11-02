import { safeRedirect } from "./auth-redirect";

const SAFE_CODE = /^[A-Za-z0-9_-]{1,80}$/;

/** Absolute `/auth/error` on this web origin. Better Auth rejects a relative one. */
export function authErrorCallbackURL(origin: string): string {
  return new URL("/auth/error", origin).toString();
}

/**
 * Success URL for flows that append `?error=` onto `callbackURL` (email
 * verification has no separate `errorCallbackURL`). `/auth/continue` shows
 * the error page when the query carries `error`, and otherwise continues to
 * `next`.
 */
export function authContinueCallbackURL(origin: string, next: string): string {
  const url = new URL("/auth/continue", origin);
  url.searchParams.set("next", safeRedirect(next));
  return url.toString();
}

function firstString(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return undefined;
}

/**
 * Redirect target for `/auth/continue`. An `error` query always wins, and an
 * unsafe code still lands on `/auth/error` (generic copy) rather than a blank
 * page or an open redirect. `next` is constrained to a same-origin path.
 */
export function authContinueTarget(params: { error?: unknown; next?: unknown }): string {
  const raw = firstString(params.error);
  if (raw && raw.length > 0) {
    return SAFE_CODE.test(raw) ? `/auth/error?error=${encodeURIComponent(raw)}` : "/auth/error";
  }
  return safeRedirect(params.next);
}
