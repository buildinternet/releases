import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { oneTap, magicLink } from "better-auth/plugins";
import { dash } from "@better-auth/infra";
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { getSecret } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import { user, session, account, verification, rateLimit } from "../db/schema-auth.js";
import type { Env } from "../index.js";
import {
  sendAuthEmail,
  verifyEmailTemplate,
  resetPasswordTemplate,
  magicLinkTemplate,
  type AuthEmailMessage,
} from "./email.js";

type Bindings = Env["Bindings"];

/** A value bound as a Secrets Store binding (prod) or a plain string (local .dev.vars / wrangler var). */
type SecretLike = string | Parameters<typeof getSecret>[0];

/**
 * Resolve a secret that may be bound either way: a Secrets Store binding (prod)
 * or a plain string (local `.dev.vars` / `wrangler dev`). Returns null when
 * absent so callers can treat "unset" uniformly.
 *
 * A Secrets Store binding can be *present but unresolvable* in local `wrangler
 * dev` (no local value) — `getSecret` throws there. We treat any resolution
 * failure as "not configured" so a missing secret degrades gracefully (e.g.
 * Better Auth's dev-secret fallback, or a social provider simply staying off)
 * instead of 500ing every `/api/auth/*` request. Callers decide what an absent
 * secret means; `createAuth` logs when the *signing* secret is the one missing.
 */
async function resolveSecret(value: SecretLike): Promise<string | null> {
  if (value == null) return null;
  if (typeof value === "string") return value;
  try {
    return await getSecret(value);
  } catch {
    return null;
  }
}

type SocialProvider = {
  clientId: string;
  clientSecret: string;
  /**
   * Re-import the provider's profile (`name`, `image`) onto the user on EVERY
   * sign-in, not just the first. Better Auth defaults this off; we opt Google in
   * so the avatar we surface stays current. Safe today — there's no profile-edit
   * UI whose values this could clobber. See `buildSocialProviders`.
   */
  overrideUserInfoOnSignIn?: boolean;
};

/**
 * Build the `socialProviders` map, **gating each provider on both halves of its
 * credential pair**. A provider is included only when its client id AND secret
 * both resolve to non-empty values; otherwise it's silently omitted (no crash).
 * This is the "social-ready" seam — dropping the Google/GitHub secrets into the
 * environment activates them with zero code change. Pure + synchronous so it can
 * be unit-tested without touching the database or the network.
 *
 * Google additionally carries `overrideUserInfoOnSignIn` so the Google profile
 * photo (mapped to `user.image` by Better Auth's default profile mapping) and
 * name re-sync on every Google sign-in. GitHub keeps the plain import-on-signup
 * default — only Google was asked to stay fresh.
 */
export function buildSocialProviders(creds: {
  googleClientId?: string | null;
  googleClientSecret?: string | null;
  githubClientId?: string | null;
  githubClientSecret?: string | null;
}): Record<string, SocialProvider> {
  const providers: Record<string, SocialProvider> = {};
  if (creds.googleClientId && creds.googleClientSecret) {
    providers.google = {
      clientId: creds.googleClientId,
      clientSecret: creds.googleClientSecret,
      overrideUserInfoOnSignIn: true,
    };
  }
  if (creds.githubClientId && creds.githubClientSecret) {
    providers.github = { clientId: creds.githubClientId, clientSecret: creds.githubClientSecret };
  }
  return providers;
}

/** Operator-configured extra trusted origins (`BETTER_AUTH_TRUSTED_ORIGINS`, comma-separated). */
function extraTrustedOrigins(env: Bindings): string[] {
  return (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Web origins permitted to call the auth API with credentials. Mirrors the CORS
 * allow-list ({@link isReleasesFamilyOrigin} + {@link isLoopbackOrigin}) so an
 * origin the CORS layer reflects is also accepted by Better Auth's own origin
 * check — never trusted by one and rejected by the other.
 *
 * The releases.sh / releases.localhost family is the apex (exact origin) plus every
 * subdomain (host wildcard `*.releases.sh` — Better Auth matches a no-scheme
 * wildcard against the request host, exactly like `isReleasesFamilyOrigin`).
 * `BETTER_AUTH_TRUSTED_ORIGINS` (comma-separated) adds explicit extras — a Vercel
 * preview origin, or a portless custom-TLD dev host (e.g.
 * `https://releases.local.buildinternet.dev`, which Google OAuth accepts where the
 * `*.releases.localhost` portless hosts are rejected).
 *
 * Outside production we additionally trust any bare-loopback web origin
 * (`http://localhost:*` / `http://127.0.0.1:*`, any port) so local OAuth can run on
 * plain `localhost` ports without config. Prod stays locked to the releases.sh
 * family plus whatever is explicitly configured.
 */
export function authTrustedOrigins(env: Bindings): string[] {
  const defaults = [
    "https://releases.sh",
    "*.releases.sh",
    "https://releases.localhost",
    "*.releases.localhost",
  ];
  const localDev =
    env.ENVIRONMENT === "production" ? [] : ["http://localhost:*", "http://127.0.0.1:*"];
  return [...new Set([...defaults, ...localDev, ...extraTrustedOrigins(env)])];
}

/** True for an origin in the releases.sh / releases.localhost family (any subdomain). */
function isReleasesFamilyOrigin(origin: string): boolean {
  try {
    const host = new URL(origin).hostname;
    return (
      host === "releases.sh" ||
      host.endsWith(".releases.sh") ||
      host === "releases.localhost" ||
      host.endsWith(".releases.localhost")
    );
  } catch {
    return false;
  }
}

/**
 * True for a bare-loopback origin (`http(s)://localhost[:port]` /
 * `http(s)://127.0.0.1[:port]`). Allowed by the auth CORS allow-list only outside
 * production — see {@link authTrustedOrigins} for why local OAuth needs it.
 */
function isLoopbackOrigin(origin: string): boolean {
  try {
    const { hostname } = new URL(origin);
    return hostname === "localhost" || hostname === "127.0.0.1";
  } catch {
    return false;
  }
}

/** True for an IP-literal host: an IPv4 dotted-quad or a bracketed/colon IPv6 literal. */
function isIpHost(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.includes(":") || host.startsWith("[");
}

/**
 * Cross-subdomain cookie domain. Explicit `BETTER_AUTH_COOKIE_DOMAIN` wins;
 * otherwise derive it from `BETTER_AUTH_URL` by dropping the leftmost host label
 * (`api.releases.sh` → `.releases.sh`). Undefined when neither is available — in
 * which case Better Auth scopes the cookie to the request host.
 *
 * A single-label host (`localhost`) or an IP literal (`127.0.0.1`) has no
 * registrable parent: label-dropping would yield a bogus cookie domain
 * (`127.0.0.1` → `.0.0.1`) and wrongly switch on cross-subdomain cookies. Both
 * return undefined so the cookie stays host-only.
 */
export function deriveCookieDomain(env: Bindings): string | undefined {
  if (env.BETTER_AUTH_COOKIE_DOMAIN) return env.BETTER_AUTH_COOKIE_DOMAIN;
  if (!env.BETTER_AUTH_URL) return undefined;
  try {
    const host = new URL(env.BETTER_AUTH_URL).hostname;
    if (isIpHost(host)) return undefined;
    const parts = host.split(".");
    if (parts.length < 2) return undefined;
    return "." + parts.slice(1).join(".");
  } catch {
    return undefined;
  }
}

/**
 * Scoped, credentialed CORS for `/api/auth/*`. The worker's global `cors()` is
 * wildcard-origin / no-credentials, which cannot carry `Access-Control-Allow-
 * Credentials`; auth needs a reflected origin + credentials so the browser will
 * send and store the session cookie. MUST be registered BEFORE the global
 * `cors()` so it owns the auth preflight (the first matching CORS middleware
 * answers OPTIONS and returns). Allow-list mirrors {@link authTrustedOrigins}: the
 * releases.sh/.localhost family (our first-party web surfaces), every operator-
 * configured `BETTER_AUTH_TRUSTED_ORIGINS` entry (Vercel preview / portless dev
 * host), and bare-loopback origins outside production. Keeping the two in lockstep
 * means CORS never silently blocks an origin Better Auth already trusts.
 */
export function authCorsMiddleware(): MiddlewareHandler<Env> {
  return cors({
    origin: (origin, c) => {
      if (!origin) return null;
      if (isReleasesFamilyOrigin(origin)) return origin;
      const env = c.env as Bindings;
      if (extraTrustedOrigins(env).includes(origin)) return origin;
      if (env.ENVIRONMENT !== "production" && isLoopbackOrigin(origin)) return origin;
      return null;
    },
    allowHeaders: ["Content-Type", "Authorization"],
    allowMethods: ["POST", "GET", "OPTIONS"],
    exposeHeaders: ["Content-Length"],
    maxAge: 600,
    credentials: true,
  });
}

/**
 * Send a fully-rendered auth email. Injectable so tests can capture without I/O.
 * The default RETURNS the send promise (not `void`) so `scheduleSend` can hand the
 * real async work to `waitUntil` — a discarded promise would let the isolate tear
 * down mid-send. A capturing test sender may return `void` (it records synchronously).
 */
export type AuthEmailSender = (msg: AuthEmailMessage) => void | Promise<unknown>;

export interface CreateAuthDeps {
  /**
   * DB handle — tests pass `createTestDb()` (BunSQLite); production uses
   * `createDb(env.DB)` (D1). Both extend `BaseSQLiteDatabase`, which is what
   * `drizzleAdapter` actually requires at runtime.
   */
  // oxlint-disable-next-line no-explicit-any
  db?: BaseSQLiteDatabase<any, any, any, any>;
  /** Email sender — tests capture; defaults to the real `sendAuthEmail`. */
  sendEmail?: AuthEmailSender;
}

/**
 * Build a per-request Better Auth instance bound to this worker's environment —
 * mirrors `createDb(env.DB)`. Cheap to construct; the Workers model gives us env
 * bindings per request, so the instance is created per request rather than once.
 *
 * Email/password is always on (the dependency-free path). Google + GitHub are
 * registered only when their secrets resolve (see `buildSocialProviders`).
 */
export async function createAuth(
  env: Bindings,
  /**
   * `waitUntil` from the request's execution context. When provided, Better Auth's
   * background work (account-enumeration dummy ops, etc.) AND our fire-and-forget
   * verification/reset email sends are registered with it so they complete after the
   * response instead of being dropped when the Worker isolate is torn down. Omitted
   * in non-request contexts (e.g. tests) → background tasks fall back to Better Auth's
   * default and `scheduleSend` runs the send inline.
   */
  waitUntil?: (promise: Promise<unknown>) => void,
  /** Test-only injection — a capturing email sender and/or an in-memory DB. Production passes neither. */
  deps: CreateAuthDeps = {},
) {
  const secret = (await resolveSecret(env.BETTER_AUTH_SECRET)) ?? undefined;
  if (!secret) {
    // Deployed envs supply this via the Secrets Store binding (validated at
    // deploy). An unresolved secret here is expected only in local `wrangler
    // dev` (no .dev.vars) — Better Auth falls back to an ephemeral dev secret.
    // Logged at warn so a genuine deployed-env misconfig surfaces in Workers Logs.
    logEvent("warn", {
      component: "auth",
      event: "secret-unresolved",
      message: "BETTER_AUTH_SECRET unresolved; Better Auth will use an ephemeral dev secret",
      environment: env.ENVIRONMENT,
    });
  }
  const socialProviders = buildSocialProviders({
    googleClientId: await resolveSecret(env.GOOGLE_CLIENT_ID),
    googleClientSecret: await resolveSecret(env.GOOGLE_CLIENT_SECRET),
    githubClientId: await resolveSecret(env.GITHUB_CLIENT_ID),
    githubClientSecret: await resolveSecret(env.GITHUB_CLIENT_SECRET),
  });
  const cookieDomain = deriveCookieDomain(env);
  const db = deps.db ?? createDb(env.DB);
  const sendEmail: AuthEmailSender = deps.sendEmail ?? ((msg) => sendAuthEmail(env, msg));

  // Fire-and-forget an email send: hand the REAL send promise to the request's
  // `waitUntil` so it outlives the response (the Better Auth docs flag AWAITING the
  // send as a timing-attack oracle, and on Workers a bare floating promise is
  // cancelled when the response returns). With no exec-ctx (tests / non-request
  // callers) it runs inline, where the injected capturing sender records
  // synchronously. `Promise.resolve` only normalizes a `void`-returning test sender;
  // a real send promise passes through unwrapped so `waitUntil` tracks it.
  const scheduleSend = (run: () => void | Promise<unknown>): void => {
    const result = run();
    if (waitUntil) waitUntil(Promise.resolve(result));
  };

  // Better Auth Infrastructure ("dash") — the hosted admin/analytics dashboard at
  // dash.better-auth.com reads from THIS self-hosted backend through the dash()
  // plugin (user management, session monitoring, sign-up/sign-in analytics, audit
  // logs). Gated on the API key resolving, same graceful-degradation seam as the
  // social providers above: present (prod Secrets Store binding, or local
  // .dev.vars) → the plugin mounts and the dashboard connects; absent (e.g. local
  // dev without the key) → it stays off rather than making keyless outbound calls.
  // Activity tracking is ON: dash() stamps `user.lastActiveAt` on non-GET authed
  // requests (throttled to updateInterval, default 5 min) so the dashboard can show
  // "last active". Best-effort on Workers — the plugin fires the write without
  // awaiting it — so it's approximate, not a per-request heartbeat; the dashboard
  // also lazily backfills it from session timestamps. The `last_active_at` column is
  // paired in schema-auth.ts + migration 20260604010000_add_user_last_active_at.sql.
  const dashApiKey = await resolveSecret(env.BETTER_AUTH_API_KEY);

  // Google One Tap (`/api/auth/one-tap/*`): the popup renders on the web origin
  // with the PUBLIC client id and posts the Google ID token here for verification.
  // Gated on Google being configured — the endpoint only verifies a Google ID
  // token, so it's meaningless (a dangling route) without the client id. Same
  // fail-safe seam as `buildSocialProviders`: present → mounts; absent → omitted.
  // The client id is the one Google already uses for the social provider; pass it
  // explicitly rather than leaning on the plugin's socialProviders fallback.
  //
  // Magic link (`/api/auth/sign-in/magic-link`, `/api/auth/magic-link/verify`):
  // passwordless email sign-in. Always registered — unlike the social providers it
  // needs no credential pair, only the AUTH_EMAIL binding already used by the
  // verify/reset emails (a missing binding degrades to a logged no-send, never a
  // crash). The verification token rides Better Auth's existing `verification`
  // table; `storeToken: "hashed"` keeps only a hash at rest so a D1 read can't
  // replay a live link, and the token is single-use + 15-min TTL. disableSignUp is
  // left default-false: an unknown email auto-creates a verified account on click
  // (Better Auth writes `name: ""` when none is supplied — satisfies the NOT NULL
  // `user.name` column). The send routes through the same `scheduleSend` →
  // `waitUntil` seam as verify/reset so it outlives the response on Workers.
  const plugins = [
    ...(dashApiKey ? [dash({ apiKey: dashApiKey, activityTracking: { enabled: true } })] : []),
    ...(socialProviders.google ? [oneTap({ clientId: socialProviders.google.clientId })] : []),
    magicLink({
      expiresIn: 60 * 15,
      storeToken: "hashed",
      sendMagicLink: async ({ email, url }) => {
        const msg: AuthEmailMessage = { to: email, ...magicLinkTemplate({ url }) };
        scheduleSend(() => sendEmail(msg));
      },
    }),
  ];

  return betterAuth({
    // Display name Better Auth surfaces in OTP/passkey labels, the hosted
    // dashboard, and the verification/reset transactional emails. Resolves the
    // dashboard's "Missing Application Name" insight.
    appName: "Releases",
    secret,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: authTrustedOrigins(env),
    database: drizzleAdapter(db, {
      provider: "sqlite",
      // Schema key `rateLimit` must match Better Auth's default rate-limit model name.
      schema: { user, session, account, verification, rateLimit },
    }),
    emailAndPassword: {
      enabled: true,
      // Block sign-in until the email is verified. Sign-up returns a success
      // response with NO session (also enables Better Auth's enumeration
      // protection), and each unverified sign-in attempt re-sends the link.
      requireEmailVerification: true,
      // Resetting a password kills the user's other sessions.
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user: u, url }) => {
        const msg: AuthEmailMessage = { to: u.email, ...resetPasswordTemplate({ url }) };
        scheduleSend(() => sendEmail(msg));
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      // Re-send a fresh verification link on each unverified sign-in attempt
      // (the web form surfaces "we just sent a fresh link" on the 403).
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user: u, url }) => {
        const msg: AuthEmailMessage = { to: u.email, ...verifyEmailTemplate({ url }) };
        scheduleSend(() => sendEmail(msg));
      },
    },
    socialProviders,
    plugins,
    // Rate limiting backed by D1 so counters survive across Worker isolates — the
    // in-memory default resets per isolate and is useless on serverless. Better
    // Auth's own prod auto-enable keys off NODE_ENV, which Workers don't set, so we
    // gate it explicitly. Sensitive endpoints (sign-in/up) get the built-in
    // 3-requests-per-10s rule, keyed by `cf-connecting-ip` (advanced.ipAddress).
    //
    // FAIL-CLOSED: on in any deployed prod env, full stop. We deliberately do NOT
    // couple this to the signing secret resolving — local dev and a broken prod
    // deploy are indistinguishable by (ENVIRONMENT, secret), and a transiently
    // unresolved secret in prod must never silently drop brute-force protection on
    // the most sensitive endpoints. `AUTH_RATE_LIMIT_DISABLED` is the explicit,
    // auditable opt-out (a plain var, never a transient Secrets-Store failure):
    // default OFF so prod stays protected; set it to "true" in local `.dev.vars` to
    // skip rate limiting (and its `rate_limit` table dependency) during sign-in
    // testing. Local dev otherwise mirrors prod once the table exists
    // (`bun run db:reset:local`).
    rateLimit: {
      enabled: env.ENVIRONMENT === "production" && env.AUTH_RATE_LIMIT_DISABLED !== "true",
      storage: "database",
    },
    advanced: {
      // Hand Better Auth's background work (account-enumeration dummy ops, etc.) to
      // the request's waitUntil so it completes after the response on Workers instead
      // of being dropped when the isolate is torn down. Omitted when there's no
      // execution context (tests) → Better Auth's default floating behavior.
      ...(waitUntil
        ? { backgroundTasks: { handler: (promise: Promise<unknown>) => waitUntil(promise) } }
        : {}),
      // True client IP behind Cloudflare. `cf-connecting-ip` is the single
      // authoritative client IP CF sets on every request; `x-forwarded-for` is the
      // fallback (and what local `wrangler dev` / non-CF paths populate). Drives
      // Better Auth's rate-limit keying and the dash plugin's IP-based analytics —
      // without it the worker would see one upstream IP for everyone behind the CDN.
      ipAddress: {
        ipAddressHeaders: ["cf-connecting-ip", "x-forwarded-for"],
      },
      // Engage cross-subdomain cookies only when a real cookie domain is
      // derivable (prod `.releases.sh`, local portless `.releases.localhost`).
      // On bare loopback the host is single-label and no domain resolves —
      // leave it OFF so Better Auth sets a clean host-only cookie shared across
      // `localhost` ports. See `authTrustedOrigins` for the local OAuth rationale.
      crossSubDomainCookies: cookieDomain
        ? { enabled: true, domain: cookieDomain }
        : { enabled: false },
    },
  });
}
