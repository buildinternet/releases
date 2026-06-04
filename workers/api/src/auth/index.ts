import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import { getSecret } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import { createDb } from "../db.js";
import { user, session, account, verification } from "../db/schema-auth.js";
import type { Env } from "../index.js";

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

type SocialProvider = { clientId: string; clientSecret: string };

/**
 * Build the `socialProviders` map, **gating each provider on both halves of its
 * credential pair**. A provider is included only when its client id AND secret
 * both resolve to non-empty values; otherwise it's silently omitted (no crash).
 * This is the "social-ready" seam — dropping the Google/GitHub secrets into the
 * environment activates them with zero code change. Pure + synchronous so it can
 * be unit-tested without touching the database or the network.
 */
export function buildSocialProviders(creds: {
  googleClientId?: string | null;
  googleClientSecret?: string | null;
  githubClientId?: string | null;
  githubClientSecret?: string | null;
}): Record<string, SocialProvider> {
  const providers: Record<string, SocialProvider> = {};
  if (creds.googleClientId && creds.googleClientSecret) {
    providers.google = { clientId: creds.googleClientId, clientSecret: creds.googleClientSecret };
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
 * Web origins permitted to call the auth API with credentials. The releases.sh /
 * releases.localhost family (incl. subdomains + local worktree hosts) is always
 * trusted; `BETTER_AUTH_TRUSTED_ORIGINS` (comma-separated) adds any extras — a
 * Vercel preview origin, or a portless custom-TLD dev host (e.g.
 * `https://releases.local.buildinternet.dev`, which Google OAuth accepts where the
 * `*.releases.localhost` portless hosts are rejected).
 *
 * Outside production we additionally trust bare-loopback web origins
 * (`http://localhost:3000`, `http://127.0.0.1:3000`) so local OAuth can also run on
 * plain `localhost` ports without any config. Prod stays locked to the releases.sh
 * family plus whatever is explicitly configured.
 */
export function authTrustedOrigins(env: Bindings): string[] {
  const defaults = ["https://releases.sh", "https://releases.localhost"];
  const localDev =
    env.ENVIRONMENT === "production" ? [] : ["http://localhost:3000", "http://127.0.0.1:3000"];
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

/**
 * Cross-subdomain cookie domain. Explicit `BETTER_AUTH_COOKIE_DOMAIN` wins;
 * otherwise derive it from `BETTER_AUTH_URL` by dropping the leftmost host label
 * (`api.releases.sh` → `.releases.sh`). Undefined when neither is available — in
 * which case Better Auth scopes the cookie to the request host.
 */
export function deriveCookieDomain(env: Bindings): string | undefined {
  if (env.BETTER_AUTH_COOKIE_DOMAIN) return env.BETTER_AUTH_COOKIE_DOMAIN;
  if (!env.BETTER_AUTH_URL) return undefined;
  try {
    const host = new URL(env.BETTER_AUTH_URL).hostname;
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
 * Build a per-request Better Auth instance bound to this worker's environment —
 * mirrors `createDb(env.DB)`. Cheap to construct; the Workers model gives us env
 * bindings per request, so the instance is created per request rather than once.
 *
 * Email/password is always on (the dependency-free path). Google + GitHub are
 * registered only when their secrets resolve (see `buildSocialProviders`).
 */
export async function createAuth(env: Bindings) {
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

  return betterAuth({
    secret,
    baseURL: env.BETTER_AUTH_URL,
    trustedOrigins: authTrustedOrigins(env),
    database: drizzleAdapter(createDb(env.DB), {
      provider: "sqlite",
      schema: { user, session, account, verification },
    }),
    emailAndPassword: { enabled: true },
    socialProviders,
    advanced: {
      // Engage cross-subdomain cookies only when a real cookie domain is
      // derivable (prod `.releases.sh`, local portless `.releases.localhost`).
      // On bare loopback (`http://localhost:8787`) the host is single-label and
      // no domain resolves — leave it OFF so Better Auth sets a clean host-only
      // cookie shared across `localhost` ports rather than a `Domain=localhost`
      // cookie. See `authTrustedOrigins` for the local OAuth rationale.
      crossSubDomainCookies: cookieDomain
        ? { enabled: true, domain: cookieDomain }
        : { enabled: false },
    },
  });
}
