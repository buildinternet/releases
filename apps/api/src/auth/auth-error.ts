/**
 * Sign-in failures Better Auth does not already audit as `sign-in-failure`.
 *
 * Two shapes, because the router treats them differently:
 *   - A browser redirect (`ctx.redirect`, status FOUND) never reaches
 *     `onAPIError.onError`. The `/api/auth/*` handler classifies the Location
 *     instead ({@link classifyAuthRedirectFailure}).
 *   - A thrown API error becomes JSON. `onAPIError.onError` logs the code
 *     ({@link classifyAuthApiError}). Credential failures stay on the existing
 *     `sign-in-failure` event so they are not counted twice.
 *
 * Logs carry the error code and, for an OAuth callback, the provider id.
 * They never carry `error_description`, the error message, or an email —
 * those fields are attacker-controlled or PII.
 */

import type { AuthAuditFields } from "./audit.js";

const SAFE_CODE = /^[A-Za-z0-9_-]{1,80}$/;
const SAFE_PROVIDER = /^[a-z0-9_-]{1,32}$/;

/**
 * Codes already recorded as `sign-in-failure` (or routine validation the user
 * sees in the form). Anything else that reaches `onError` is otherwise silent.
 */
const ALREADY_AUDITED = new Set([
  "INVALID_EMAIL_OR_PASSWORD",
  "INVALID_PASSWORD",
  "EMAIL_NOT_VERIFIED",
  "USER_ALREADY_EXISTS",
  "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL",
]);

export interface AuthRedirectFailure extends AuthAuditFields {
  event: "auth-redirect-error";
  code: string;
  provider?: string;
}

export interface AuthApiFailure extends AuthAuditFields {
  event: "auth-api-error";
  code: string;
}

/** Browser navigations whose 5xx must not render as a JSON body. */
export function isBrowserAuthNavigation(pathname: string): boolean {
  return (
    /\/api\/auth\/callback\/[^/]+$/.test(pathname) ||
    pathname.endsWith("/api/auth/magic-link/verify") ||
    pathname.endsWith("/api/auth/verify-email") ||
    pathname.endsWith("/api/auth/oauth2/authorize") ||
    /\/api\/auth\/reset-password\/[^/]+$/.test(pathname) ||
    pathname.endsWith("/api/auth/error")
  );
}

function pathnameOf(value: string): string | null {
  try {
    const path = new URL(value, "https://releases.invalid").pathname;
    return path.replace(/\/+$/, "") || "/";
  } catch {
    return null;
  }
}

function safeCode(value: string | null | undefined): string {
  if (value && SAFE_CODE.test(value)) return value;
  return "unknown";
}

function providerFromPath(pathname: string): string | undefined {
  const match = pathname.match(/\/api\/auth\/callback\/([^/]+)$/);
  const provider = match?.[1];
  if (provider && SAFE_PROVIDER.test(provider)) return provider;
  return undefined;
}

/**
 * A redirect that lands the browser on an error (our `/auth/error` page, or
 * any other URL carrying `?error=`). Skips the OAuth callback's POST→GET hop,
 * which still points at `/api/auth/callback/:provider` and is not the page
 * the user sees.
 */
export function classifyAuthRedirectFailure(args: {
  path: string;
  method: string;
  status: number;
  location: string | null;
}): AuthRedirectFailure | null {
  const method = args.method.toUpperCase();
  if (method !== "GET" && method !== "POST") return null;
  if (args.status < 300 || args.status >= 400) return null;
  if (!args.location) return null;

  const requestPath = pathnameOf(args.path);
  const locationPath = pathnameOf(args.location);
  if (!requestPath || !locationPath) return null;
  if (!isBrowserAuthNavigation(requestPath)) return null;
  if (isBrowserAuthNavigation(locationPath)) return null;

  let error: string | null = null;
  try {
    error = new URL(args.location, "https://releases.invalid").searchParams.get("error");
  } catch {
    return null;
  }
  if (!error) return null;

  const provider = providerFromPath(requestPath);
  return {
    event: "auth-redirect-error",
    code: safeCode(error),
    ...(provider ? { provider } : {}),
  };
}

/** Non-redirect API error for `onAPIError.onError`. `null` when already audited. */
export function classifyAuthApiError(error: unknown): AuthApiFailure | null {
  if (!error || typeof error !== "object") {
    return { event: "auth-api-error", code: "unknown" };
  }
  const record = error as { status?: unknown; body?: { code?: unknown } };
  const status = typeof record.status === "string" ? record.status : undefined;
  if (status === "FOUND" || status === "TOO_MANY_REQUESTS") return null;
  const raw = typeof record.body?.code === "string" ? record.body.code : undefined;
  if (raw && ALREADY_AUDITED.has(raw)) return null;
  if (raw) return { event: "auth-api-error", code: safeCode(raw) };
  // Some throws (One Tap's "invalid id token") set a status and no code.
  if (status && SAFE_CODE.test(status)) return { event: "auth-api-error", code: status };
  return { event: "auth-api-error", code: "unknown" };
}

function codeFromBody(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as { code?: unknown };
  return typeof record.code === "string" && SAFE_CODE.test(record.code) ? record.code : undefined;
}

/**
 * Turn an unhandled 5xx on a browser auth navigation into a redirect to the
 * web error page. Returns `null` when the response should pass through
 * (XHR sign-in, session reads, anything that already redirected).
 */
export async function rewriteBrowserAuthServerError(
  requestUrl: string,
  method: string,
  response: Response,
  errorPage: string,
): Promise<Response | null> {
  if (response.status < 500) return null;
  const upper = method.toUpperCase();
  if (upper !== "GET" && upper !== "POST") return null;
  const pathname = pathnameOf(requestUrl);
  if (!pathname || !isBrowserAuthNavigation(pathname)) return null;

  let code = "internal_server_error";
  try {
    const parsed: unknown = await response.clone().json();
    const fromBody = codeFromBody(parsed);
    if (fromBody) code = fromBody;
  } catch {
    // Empty or non-JSON 500 — the generic code still sends the user to the page.
  }

  const location = new URL(errorPage);
  location.searchParams.set("error", code);
  return new Response(null, { status: 302, headers: { Location: location.toString() } });
}
