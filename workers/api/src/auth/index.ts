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

/**
 * Web origins permitted to call the auth API with credentials. The releases.sh /
 * releases.localhost family (incl. subdomains + local worktree hosts) is always
 * trusted; `BETTER_AUTH_TRUSTED_ORIGINS` (comma-separated) adds any extras (e.g.
 * a Vercel preview origin).
 */
export function authTrustedOrigins(env: Bindings): string[] {
  const defaults = ["https://releases.sh", "https://releases.localhost"];
  const extra = (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set([...defaults, ...extra])];
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
 * answers OPTIONS and returns). Origin allow-list is the releases.sh/.localhost
 * family — our own first-party web surfaces.
 */
export function authCorsMiddleware(): MiddlewareHandler<Env> {
  return cors({
    origin: (origin) => (origin && isReleasesFamilyOrigin(origin) ? origin : null),
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
      // enabled unconditionally; domain only when resolvable (else Better Auth
      // derives it from baseURL).
      crossSubDomainCookies: { enabled: true, ...(cookieDomain ? { domain: cookieDomain } : {}) },
    },
  });
}
