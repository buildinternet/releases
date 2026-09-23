/**
 * Server-side audit logging for human auth — structured `logEvent()` records for
 * sign-in (success/failure), sign-up, sign-out / session-revoked, email-verified,
 * and password-reset-completed. This is the security/audit signal Cloudflare's
 * head-sampled invocation logs can't provide (a sign-in can be absent from them
 * entirely); the failed-sign-in stream is the brute-force / credential-stuffing
 * visibility called for in #1427.
 *
 * Distinct from `telemetry_events` (PII-clean OSS CLI contract) and
 * `search_queries`. Worker-safe: logs via `logEvent` from `@releases/lib/log-event`
 * with `component: "auth"`, mirroring the email hooks in `email.ts`. PII is kept
 * minimal — we log the user id, never the email, the session token, or any password
 * material; IPs are truncated (never stored whole) via {@link redactIp}.
 *
 * Two seams feed it, split by outcome (see #1427 and `createAuth`):
 *   - Positive / state-change events ride Better Auth's purpose-built hooks
 *     (`databaseHooks`, `afterEmailVerification`, `onPasswordReset`) — wired in
 *     `createAuth`, where the user/session row gives a reliable `userId`.
 *   - Sign-in FAILURES are observed at the HTTP layer ({@link classifySignInFailure}
 *     over the auth handler's response in `index.ts`), because a rate-limit
 *     rejection (429) short-circuits in Better Auth's router `onRequest` BEFORE any
 *     internal hook runs — so the only place to see all failure modes is the response.
 */
import { logEvent } from "@releases/lib/log-event";

/** Audit events log at `info` (normal action) or `warn` (failure / forced revocation). */
type AuthAuditLevel = "info" | "warn";

/** Fields for an audit event; `event` is the kebab-case action, the rest is context. */
export interface AuthAuditFields {
  event: string;
  [key: string]: unknown;
}

/**
 * Emit one audit event. Injectable so `createAuth` tests can capture events without
 * spying on `console` (mirrors the `sendEmail` dependency seam). The default
 * ({@link makeAuthAudit}) writes through `logEvent`.
 */
export type AuthAuditEmitter = (level: AuthAuditLevel, fields: AuthAuditFields) => void;

/** Env subset the audit emitter stamps onto every event. */
export interface AuthAuditEnv {
  ENVIRONMENT?: string;
}

/**
 * Build the production audit emitter: stamps `component: "auth"` and the
 * environment onto each event and routes it through `logEvent` (worker-safe
 * structured JSON; severity is set by the level arg, never a `level` payload key —
 * see docs/architecture/logging.md).
 */
export function makeAuthAudit(env: AuthAuditEnv): AuthAuditEmitter {
  return (level, fields) => {
    logEvent(level, { component: "auth", environment: env.ENVIRONMENT, ...fields });
  };
}

/**
 * Truncate a client IP for privacy before it lands in a shared log sink: keep the
 * network prefix, drop the host portion so we can still cluster brute-force
 * attempts by network without storing a full PII identifier.
 *   - IPv4 → drop the last octet: `203.0.113.7` → `203.0.113.0/24`.
 *   - IPv6 → keep the first three hextets (/48): `2001:db8:abcd:1::1` → `2001:db8:abcd::/48`.
 * Anything missing or unrecognizable returns `undefined` (we'd rather log no IP
 * than a half-parsed or full one). Pure.
 */
export function redactIp(ip?: string | null): string | undefined {
  if (!ip) return undefined;
  const trimmed = ip.trim();
  if (!trimmed) return undefined;

  // IPv4 dotted-quad.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.\d{1,3}$/.exec(trimmed);
  if (v4) {
    const octets = [v4[1], v4[2], v4[3]];
    if (octets.every((o) => Number(o) <= 255)) {
      return `${octets.join(".")}.0/24`;
    }
    return undefined;
  }

  // IPv6 — keep the /48 prefix (first three hextets). Accepts compressed forms;
  // we only need the leading hextets, so a `::` after the prefix is irrelevant.
  if (trimmed.includes(":")) {
    const head = trimmed.split("::")[0] ?? "";
    const hextets = head.split(":").filter(Boolean);
    if (hextets.length === 0) return undefined; // e.g. "::1" — no routable prefix to keep
    const prefix = hextets.slice(0, 3);
    return `${prefix.join(":")}::/48`;
  }

  return undefined;
}

/** A classified sign-in failure: the audit event plus the (internal) reason. */
export interface SignInFailure {
  event: "sign-in-failure";
  /**
   * Internal reason. `invalid-credentials` deliberately covers BOTH a wrong
   * password and an unknown email — Better Auth returns the same generic
   * `INVALID_EMAIL_OR_PASSWORD` / 401 for both (account-enumeration protection),
   * so they are indistinguishable from any observation point outside its internals.
   */
  reason: "invalid-credentials" | "unverified" | "rate-limited";
}

/** Path suffix of the credentialed email/password sign-in endpoint. */
const SIGN_IN_EMAIL_SUFFIX = "/sign-in/email";

/**
 * Classify a failed credential sign-in from the auth handler's HTTP response —
 * derivable from path + method + status ALONE, so no response-body clone/parse is
 * needed. Returns `null` for anything that isn't a failed `POST /sign-in/email`
 * (successes, other endpoints, other methods), so the caller logs only real
 * failures. Pure.
 *
 * Status → reason (the only failure shapes `/sign-in/email` produces):
 *   - 429 → `rate-limited`  (Better Auth's router rejects before the endpoint runs)
 *   - 403 → `unverified`    (EMAIL_NOT_VERIFIED — sign-in blocked pending verification)
 *   - 401 → `invalid-credentials` (INVALID_EMAIL_OR_PASSWORD — bad password or no such user)
 */
export function classifySignInFailure(args: {
  path: string;
  method: string;
  status: number;
}): SignInFailure | null {
  if (args.method.toUpperCase() !== "POST") return null;
  if (!args.path.endsWith(SIGN_IN_EMAIL_SUFFIX)) return null;
  switch (args.status) {
    case 429:
      return { event: "sign-in-failure", reason: "rate-limited" };
    case 403:
      return { event: "sign-in-failure", reason: "unverified" };
    case 401:
      return { event: "sign-in-failure", reason: "invalid-credentials" };
    default:
      return null;
  }
}

// ── Better Auth hook factories (positive / state-change events) ──
//
// Minimal structural param types: Better Auth passes its own `User` / `Session` /
// `GenericEndpointContext`, which are structurally compatible with these subsets.
// Typing the slices we read (rather than importing the deep Better Auth types)
// keeps this module dependency-light and the hooks easy to unit-test.

interface HookUser {
  id: string;
}
interface HookSession {
  userId: string;
  ipAddress?: string | null;
}
interface HookContext {
  path?: string;
}

/**
 * `databaseHooks` covering sign-up, sign-in-success, and sign-out / session-revoked.
 * Spread into `betterAuth({ databaseHooks })`.
 *   - `user.create.after`    → `sign-up`         (a new account row).
 *   - `session.create.after` → `sign-in-success` (any session creation — email,
 *     social, one-tap, or the auto-sign-in after email verification; carries the
 *     truncated session IP).
 *   - `session.delete.after` → `sign-out` when the request is the user-initiated
 *     `/sign-out`, else `session-revoked` (e.g. a session killed by a password
 *     reset's `revokeSessionsOnPasswordReset`). Revocation logs at `warn`.
 */
export function auditDatabaseHooks(audit: AuthAuditEmitter) {
  return {
    user: {
      create: {
        after: async (u: HookUser) => {
          audit("info", { event: "sign-up", userId: u.id });
        },
      },
    },
    session: {
      create: {
        after: async (s: HookSession) => {
          audit("info", {
            event: "sign-in-success",
            userId: s.userId,
            ip: redactIp(s.ipAddress),
          });
        },
      },
      delete: {
        after: async (s: HookSession, ctx: HookContext | null) => {
          const userInitiated = ctx?.path === "/sign-out";
          audit(userInitiated ? "info" : "warn", {
            event: userInitiated ? "sign-out" : "session-revoked",
            userId: s.userId,
          });
        },
      },
    },
  };
}

/** `emailVerification.afterEmailVerification` → `email-verified`. */
export function auditAfterEmailVerification(audit: AuthAuditEmitter) {
  return async (u: HookUser) => {
    audit("info", { event: "email-verified", userId: u.id });
  };
}

/** `emailAndPassword.onPasswordReset` → `password-reset-completed`. */
export function auditOnPasswordReset(audit: AuthAuditEmitter) {
  return async (data: { user: HookUser }) => {
    audit("info", { event: "password-reset-completed", userId: data.user.id });
  };
}
