import { AsyncLocalStorage } from "node:async_hooks";
import { betterAuth } from "better-auth/minimal";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import {
  oneTap,
  magicLink,
  deviceAuthorization,
  bearer,
  jwt,
  admin,
  lastLoginMethod,
} from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { oauthProvider } from "@better-auth/oauth-provider";
import { passkey as passkeyPlugin } from "@better-auth/passkey";
import { dash, sentinel } from "@better-auth/infra";
import { apiKey } from "@better-auth/api-key";
import { stripe as stripePlugin } from "@better-auth/stripe";
import Stripe from "stripe";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import { cors } from "hono/cors";
import type { MiddlewareHandler } from "hono";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { getSecret } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import { FLAGS, flag } from "@releases/lib/flags";
import { audienceVariants } from "@releases/lib/oauth-jwt";
import { USER_API_KEY_PREFIX, DEVICE_AUTH_CLIENT_ID } from "@buildinternet/releases-core/api-token";
import { oauthAccessTokenClaims, consentScopeViolation, jwtSessionPayload } from "./entitlement.js";
import { scopeToPermissions } from "./api-key-scope.js";
import { CLIENT_SECRET_PREFIX } from "./oauth-clients.js";
import {
  USER_API_KEY_MAX_ACTIVE,
  API_KEY_LIMIT_CODE,
  API_KEY_LIMIT_MESSAGE,
  countActiveUserKeys,
} from "./api-key-limit.js";
import { createDb, type AnyDb } from "../db.js";
import { and, eq, isNull } from "drizzle-orm";
import {
  user,
  session,
  account,
  verification,
  rateLimit,
  apikey,
  deviceCode,
  oauthClient,
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
  jwks,
  passkey,
} from "../db/schema-auth.js";
import type { Env } from "../index.js";
import {
  sendAuthEmail,
  verifyEmailTemplate,
  resetPasswordTemplate,
  magicLinkTemplate,
  changeEmailTemplate,
  type AuthEmailMessage,
} from "./email.js";
import {
  makeAuthAudit,
  auditDatabaseHooks,
  auditAfterEmailVerification,
  auditOnPasswordReset,
  type AuthAuditEmitter,
} from "./audit.js";

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

/**
 * Resolve the Better Auth signing secret, with a local-dev fallback.
 *
 * In deployed envs `BETTER_AUTH_SECRET` is a Secrets Store binding (validated at
 * deploy). In local `wrangler dev` that binding can't reach the Secrets Store, and
 * — the footgun — a same-named `.dev.vars` plain string does NOT override it
 * (wrangler binds the store binding), so the signing secret silently became an
 * ephemeral per-restart random value (#1425). We therefore read a DISTINCT
 * plain-string var, `BETTER_AUTH_SECRET_DEV`, and prefer it only when the binding
 * is unresolvable: local dev gets a stable secret (sessions survive restarts,
 * tokens are mintable for tests) without the prod secret ever touching a laptop.
 *
 * Safe in prod: the binding resolves there so its value wins, and
 * `BETTER_AUTH_SECRET_DEV` is never bound in deployed envs anyway. Deliberately
 * NOT gated on `ENVIRONMENT` — local `wrangler dev` defaults `ENVIRONMENT` to
 * `production`, so such a gate would disable the fallback exactly where it's needed.
 */
export async function resolveSigningSecret(env: {
  BETTER_AUTH_SECRET?: SecretLike;
  BETTER_AUTH_SECRET_DEV?: string;
}): Promise<string | null> {
  // `||`, not `??`: an empty-string secret is never usable, so an empty/unresolved
  // binding must fall through to the dev var (and an empty dev var to null) — the
  // same "no usable value" rule getSecretWithFallback uses.
  const resolved = await resolveSecret(env.BETTER_AUTH_SECRET);
  return resolved || env.BETTER_AUTH_SECRET_DEV || null;
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
  /**
   * Map the raw provider profile onto extra user fields at create/override time.
   * We use it to capture `displayEmail` — the provider's email with its ORIGINAL
   * casing/dots — before the Sentinel `emailNormalization` pass rewrites the
   * canonical `email` column (lowercase + Gmail dots stripped). Better Auth merges
   * the returned object onto the user it creates, and Sentinel's user create/update
   * hooks spread `...user` (touching only `email`), so `displayEmail` survives. See
   * `mapDisplayEmail` and the `user.additionalFields.displayEmail` declaration.
   */
  mapProfileToUser?: (profile: { email?: string | null }) => { displayEmail?: string };
};

/**
 * Capture the provider profile's email verbatim into the `displayEmail` field.
 * Both the Google (decoded id token) and GitHub (resolved primary email) profiles
 * expose `.email`; an absent email yields no field (the read path falls back to the
 * canonical `email`). Shared by every provider so the display form is preserved
 * uniformly. Pure so it's unit-testable in isolation.
 */
export function mapDisplayEmail(profile: { email?: string | null }): { displayEmail?: string } {
  return typeof profile.email === "string" && profile.email ? { displayEmail: profile.email } : {};
}

/**
 * `user.update.before` transform that keeps `displayEmail` from going stale when the
 * canonical `email` changes (the self-serve change-email confirmation, which applies
 * `updateUser({ email })`). Sets `displayEmail` to the incoming email so the account
 * page never shows the OLD address after a change.
 *
 * The guard is load-bearing: it acts ONLY when `email` is in the update AND no
 * explicit `displayEmail` is — because Google's `overrideUserInfoOnSignIn` re-imports
 * the profile on EVERY sign-in via `mapProfileToUser`, sending an update that carries
 * BOTH the (lowercased) `email` and the original-cased `displayEmail`. Without the
 * `displayEmail == null` check we'd overwrite that nicely-cased value with the
 * lowercased email on every Google sign-in. Returns `{ data }` (Better Auth's
 * modify-shape) only when it changes something, else `undefined` (a no-op passthrough).
 * Pure + exported for unit testing.
 */
export function syncDisplayEmailOnUpdate(
  data: Record<string, unknown>,
): { data: Record<string, unknown> } | undefined {
  if (typeof data.email !== "string" || data.email === "") return undefined;
  if (data.displayEmail != null) return undefined;
  return { data: { ...data, displayEmail: data.email } };
}

/**
 * Recover the original-cased email claim from a Google ID token's payload.
 *
 * Google One Tap (the `oneTap` plugin) verifies its own ID token at
 * `/one-tap/callback` and hands the canonical email to the link/create path — it
 * never routes through a provider's `mapProfileToUser`, so unlike the standard
 * OAuth flow, nothing captures the verbatim `displayEmail` for a One-Tap user. We
 * re-read it from the SAME token to drive the backfill. This decode is NOT a
 * verification: the after-hook only runs it for an already-verified token (the
 * callback returns a user solely when the plugin's `jwtVerify` passed), so we just
 * need the `email` claim back, not to re-establish trust.
 *
 * Decodes the middle (payload) segment as base64url. Pure + exported for unit
 * testing; returns `undefined` for anything malformed or emailless.
 */
export function emailFromGoogleIdToken(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  const segment = idToken.split(".")[1];
  if (!segment) return undefined;
  try {
    let b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
    b64 += "=".repeat((4 - (b64.length % 4)) % 4);
    const payload = JSON.parse(atob(b64)) as { email?: unknown };
    return typeof payload.email === "string" && payload.email ? payload.email : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide the `displayEmail` to backfill onto an EXISTING user row at sign-in, or
 * `undefined` for a no-op. Pure + exported for unit testing (mirrors
 * {@link syncDisplayEmailOnUpdate}).
 *
 * Needed for the Google One Tap path even though `mapDisplayEmail` already maps it
 * on the standard flow: One Tap bypasses `mapProfileToUser` entirely (it verifies
 * its own ID token), so neither the create nor the re-login path ever sets
 * `displayEmail` for a One-Tap user. We fill it ourselves from the token's
 * original-cased email — but ONLY when the row's value is still empty, so a value
 * set by `mapDisplayEmail` (a standard-flow create) or by a self-serve
 * change-email (`syncDisplayEmailOnUpdate`) is never clobbered.
 */
export function displayEmailBackfill(
  current: { displayEmail?: string | null } | undefined,
  originalEmail: string,
): string | undefined {
  if (!current) return undefined; // no matching row (a new user takes the create path)
  if (current.displayEmail != null && current.displayEmail !== "") return undefined; // already set
  if (!originalEmail) return undefined;
  return originalEmail;
}

let warnedDisplayEmailBackfill = false;

/**
 * Best-effort: backfill an existing user's `display_email` from the original-cased
 * OAuth profile email at sign-in, when it's still empty. Used by the Google One
 * Tap after-hook (see {@link createAuth}), whose flow never reaches
 * `mapProfileToUser`. A failure must never disturb sign-in, so everything is
 * swallowed (warn once via logEvent).
 *
 * @param normalizedEmail the deduped canonical email — matches the stored `email` key
 * @param originalEmail   the verbatim provider email, with casing/dots preserved
 */
async function backfillDisplayEmailOnSignIn(
  db: AnyDb,
  normalizedEmail: string,
  originalEmail: string,
): Promise<void> {
  try {
    const [row] = await db
      .select({ id: user.id, displayEmail: user.displayEmail })
      .from(user)
      .where(eq(user.email, normalizedEmail))
      .limit(1);
    const next = displayEmailBackfill(row, originalEmail);
    if (!row || next === undefined) return;
    // Guard the write with `display_email IS NULL` too, so a concurrent sign-in
    // (or a change-email that lands first) can't be clobbered between read and write.
    await db
      .update(user)
      .set({ displayEmail: next })
      .where(and(eq(user.id, row.id), isNull(user.displayEmail)));
  } catch (err) {
    if (!warnedDisplayEmailBackfill) {
      warnedDisplayEmailBackfill = true;
      logEvent("warn", {
        component: "auth",
        event: "display-email-backfill-failed",
        message: "displayEmail backfill on One Tap sign-in failed",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

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
      mapProfileToUser: mapDisplayEmail,
    };
  }
  if (creds.githubClientId && creds.githubClientSecret) {
    providers.github = {
      clientId: creds.githubClientId,
      clientSecret: creds.githubClientSecret,
      mapProfileToUser: mapDisplayEmail,
    };
  }
  return providers;
}

/**
 * Build the Better Auth Stripe plugin (`@better-auth/stripe`), GATED on BOTH the
 * secret API key and the webhook signing secret resolving — the same graceful-
 * degradation seam as `dash()` / `sentinel()` / the social providers. Absent
 * either → returns `null` and the plugin is omitted entirely: no Stripe client is
 * constructed and no Stripe writes happen, so the feature is inert until the
 * secrets are provisioned. Present both → it mounts, and a Stripe Customer is
 * created on every sign-up (`createCustomerOnSignUp`) and linked to the user via
 * the `stripeCustomerId` column. Dropping the two secrets into the environment
 * activates it with zero code change — the "billing-ready" seam.
 *
 * Customer management ONLY for now: `subscription` is left disabled (the plugin's
 * default), so no `subscription` table is touched. This is the billing foundation
 * — getting every user registered as a Stripe Customer — not billing itself.
 *
 * Worker-compat: the Stripe Node SDK's default HTTP transport isn't available on
 * Cloudflare Workers, so the client is constructed with the Fetch HTTP client.
 * Webhook signature verification (the plugin calls `constructEventAsync`
 * internally) uses WebCrypto on Workers — no extra wiring needed. `apiVersion` is
 * left at the SDK default so its value always matches the installed SDK's types.
 *
 * Not split into a pure-config half + a separate construction step (unlike
 * `buildSocialProviders`) because the plugin requires a live `stripeClient`
 * instance; the `Stripe` constructor performs no network I/O, so this stays
 * cheap and unit-testable (the gating is asserted via the resolved plugin id).
 */
export function buildStripePlugin(creds: {
  secretKey?: string | null;
  webhookSecret?: string | null;
}): BetterAuthPlugin | null {
  if (!creds.secretKey || !creds.webhookSecret) return null;
  const stripeClient = new Stripe(creds.secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });
  return stripePlugin({
    stripeClient,
    stripeWebhookSecret: creds.webhookSecret,
    createCustomerOnSignUp: true,
  }) as BetterAuthPlugin;
}

/**
 * Override resolution for the `last-login-method` plugin. Better Auth's default
 * resolver already maps the Google redirect callback (`/callback/google`),
 * password sign-in (`/sign-in/email` → `"email"`), and `/magic-link/verify`, but
 * NOT Google One Tap — that flow completes at `/one-tap/callback`, which the
 * default misses. Mapping it to `"google"` keeps One Tap and the redirect
 * "Continue with Google" button on a single badge. Returning `null` falls through
 * to the plugin's default resolution for every other path. Pure + synchronous so
 * it's unit-testable in isolation (mirrors `buildSocialProviders`).
 */
export function resolveLastLoginMethodOverride(path: string | null | undefined): string | null {
  if (path === "/one-tap/callback") return "google";
  return null;
}

/** Operator-configured extra trusted origins (`BETTER_AUTH_TRUSTED_ORIGINS`, comma-separated). */
function extraTrustedOrigins(env: Bindings): string[] {
  return (env.BETTER_AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does `origin` match any operator-configured `BETTER_AUTH_TRUSTED_ORIGINS` entry?
 * Supports the two forms Better Auth's own origin check accepts, so the CORS layer
 * stays in lockstep — an entry Better Auth trusts is never silently blocked by CORS:
 *
 *  • an exact origin (`https://foo.example.com`) — matched verbatim against the
 *    request origin (the pre-wildcard behavior);
 *  • a host wildcard (`*.example.com`, optionally scheme-prefixed) — matched against
 *    the request HOST as a glob (`*` = any run of chars, `?` = one char). A single
 *    `*.example.com` entry therefore covers every subdomain, including the
 *    worktree-prefixed dev hosts (`feat-x.example.com`) that an exact-match list
 *    can't enumerate. The apex is NOT matched by `*.example.com` (mirrors Better
 *    Auth / standard glob — there's no leading-dot segment), so list it separately.
 *
 * This is what lets the local-dev origin live entirely in `.dev.vars` instead of
 * being hard-coded here: set `BETTER_AUTH_TRUSTED_ORIGINS` to the apex + `*.` wildcard.
 */
function matchesTrustedOrigin(origin: string, entries: string[]): boolean {
  let host: string;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (entry.includes("*") || entry.includes("?")) {
      // Host wildcard. Drop an optional `scheme://` so `https://*.example.com` and
      // the bare `*.example.com` form both reduce to a host glob.
      const pattern = entry.replace(/^[a-z][a-z\d+.-]*:\/\//i, "");
      return globToHostRegExp(pattern).test(host);
    }
    return entry === origin;
  });
}

/**
 * Compile a host glob (`*.example.com`) to an anchored RegExp: escape every regex
 * metachar, then translate the glob wildcards — `*` → any run of characters, `?` →
 * a single character. Hostnames contain no `/`, so `.*` faithfully reproduces Better
 * Auth's `[^/]*?` for this input.
 */
function globToHostRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replace(/\*/g, ".*").replace(/\?/g, ".")}$`);
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
 * preview origin, or the portless custom-TLD dev host (Google/Apple OAuth accept a
 * real TLD where the `*.releases.localhost` portless hosts are rejected). Entries
 * may be exact origins OR host wildcards (`*.releases.local.buildinternet.dev`),
 * which Better Auth's origin check and {@link matchesTrustedOrigin} both honor — a
 * single wildcard entry covers worktree-prefixed dev hosts. The dev origin lives in
 * config (`.dev.vars`), not hard-coded here, so nothing org-specific ships in code.
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

/**
 * Fallback issuer/audience origin when `BETTER_AUTH_URL` is unset (e.g. in tests
 * that build `createAuth` from a bare env). The oauth-provider plugin's `init`
 * does `new URL(issuer)` on the baseURL and throws on an empty string, so a
 * parseable default keeps the AS from crashing auth context creation. Prod +
 * staging always set `BETTER_AUTH_URL`, so this only bites the test path.
 */
const DEFAULT_AUTH_ORIGIN = "https://api.releases.sh";

/**
 * Product display name Better Auth surfaces in OTP/passkey prompts, the hosted
 * dashboard, and transactional emails. Single source so the betterAuth `appName`
 * and the passkey `rpName` ({@link derivePasskeyRp}) can't drift apart.
 */
const APP_NAME = "Releases";

/**
 * Valid `aud` values for issued OAuth access tokens: the origin of this AS
 * (`BETTER_AUTH_URL`) unioned with every comma-separated entry of
 * `OAUTH_RESOURCE_AUDIENCES` (the resource servers — e.g. the MCP worker). Pure
 * + exported so it's unit-testable. Falls back to the prod API origin when
 * nothing resolves, so a token always has a defined audience.
 */
export function oauthValidAudiences(env: Bindings): string[] {
  const auds = new Set<string>();
  if (env.BETTER_AUTH_URL) {
    try {
      auds.add(new URL(env.BETTER_AUTH_URL).origin);
    } catch {
      /* ignore malformed */
    }
  }
  for (const entry of (env.OAUTH_RESOURCE_AUDIENCES ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed) auds.add(trimmed);
  }
  if (auds.size === 0) auds.add(DEFAULT_AUTH_ORIGIN);
  // Accept both the bare-origin and trailing-slash form of every audience. The
  // oauth-provider plugin validates the client's RFC 8707 `resource` parameter
  // against this set by exact string, and MCP clients derive that resource via
  // WHATWG URL normalization (`new URL("https://mcp.releases.sh").href` →
  // `"https://mcp.releases.sh/"`), so a root-hosted resource server is requested
  // with a trailing slash our config omits. The RS verifier accepts the matching
  // pair (`audienceVariants` in @releases/lib/oauth-jwt) — keep them in lockstep.
  return [...new Set([...auds].flatMap(audienceVariants))];
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
 * WebAuthn relying-party config for the passkey plugin. The crux: the WebAuthn
 * ceremony runs in the BROWSER on the WEB origin (releases.sh), NOT on this API
 * worker's origin (api.releases.sh). Left to its defaults the passkey plugin
 * derives `rpID` and `origin` from `baseURL` — the API origin — which makes the
 * browser's rpID/origin checks reject every registration and authentication. So
 * we derive them from `WEB_BASE_URL` instead:
 *
 *  • `rpID` is the web HOST (`releases.sh`). A passkey scoped to the apex is
 *    usable from both `releases.sh` and `api.releases.sh` because rpID must be a
 *    registrable suffix of the page origin and the apex is a suffix of itself.
 *  • `origin` is the full web ORIGIN (`https://releases.sh`) — the value the
 *    browser writes into clientDataJSON, which the plugin verifies verbatim (no
 *    trailing slash).
 *  • `rpName` is the human-facing label shown in the OS/browser passkey prompt.
 *
 * Prod/staging set `WEB_BASE_URL`; the fallback keeps the prod web origin so a
 * missing var degrades to the right host rather than the API host. Locally
 * `WEB_BASE_URL` is the portless web origin (`https://releases.localhost`),
 * yielding rpID `releases.localhost` — valid for WebAuthn dev. A worktree-prefixed
 * dev host (`feat-x.releases.localhost`) won't match this single origin, so passkey
 * testing in a worktree needs `WEB_BASE_URL` pointed at that exact host. Pure +
 * exported so it's unit-testable in isolation (mirrors `deriveCookieDomain`).
 */
export function derivePasskeyRp(env: { WEB_BASE_URL?: string }): {
  rpID: string;
  rpName: string;
  origin: string;
} {
  const base = env.WEB_BASE_URL ?? "https://releases.sh";
  try {
    const url = new URL(base);
    return { rpID: url.hostname, rpName: APP_NAME, origin: url.origin };
  } catch {
    return { rpID: "releases.sh", rpName: APP_NAME, origin: "https://releases.sh" };
  }
}

/** Web origin for links in user-facing auth email templates. */
function webOriginForEmail(env: { WEB_BASE_URL?: string }): string {
  return derivePasskeyRp(env).origin;
}

/**
 * Scoped, credentialed CORS for `/api/auth/*` AND the session-authed self-serve
 * surface `/v1/api-keys` (see index.ts). The worker's global `cors()` is
 * wildcard-origin / no-credentials, which cannot carry `Access-Control-Allow-
 * Credentials`; both surfaces need a reflected origin + credentials so the browser
 * will send and store the session cookie. MUST be registered BEFORE the global
 * `cors()` so it owns the preflight (the first matching CORS middleware
 * answers OPTIONS and returns). Allow-list mirrors {@link authTrustedOrigins}: the
 * releases.sh/.localhost family (our first-party web surfaces), every operator-
 * configured `BETTER_AUTH_TRUSTED_ORIGINS` entry — exact origins OR host wildcards
 * (Vercel preview / the portless dev host + its worktree subdomains via a `*.`
 * entry; see {@link matchesTrustedOrigin}) — and bare-loopback origins outside
 * production. Keeping the two in lockstep means CORS never silently blocks an origin
 * Better Auth already trusts.
 *
 * `DELETE` is allowed for the `/v1/api-keys/:id` revoke endpoint; `PUT` for
 * `/v1/me/digest` cadence writes; `PATCH` for `/v1/me/webhooks/:id` updates
 * (pause/resume, filter edits). Better Auth's own `/api/auth/*` routes are
 * POST/GET only, so the extra verbs are no-ops there. The allow-list must cover
 * every method any `/v1/me/*` handler uses or the browser blocks that preflight.
 *
 * The Sentinel client (`sentinelClient`, #1544) stamps every `/api/auth/*` request
 * with custom `X-Visitor-Id` / `X-Request-Id` fingerprint headers (and `X-PoW-Solution`
 * on a proof-of-work challenge retry). These MUST be in `allowHeaders` or the browser
 * blocks the cross-origin preflight for EVERY auth call — get-session, Google One Tap,
 * and the regular SSO callback alike. {@link AUTH_CORS_ALLOWED_HEADERS} is asserted in
 * sync with the headers the sentinel client actually sets by a drift test (auth.test.ts)
 * that scans `@better-auth/infra`'s client bundle, so a future package bump that adds a
 * header fails CI instead of silently breaking sign-in.
 */
export const AUTH_CORS_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  // Sentinel client fingerprint / PoW headers — see the note above.
  "X-Visitor-Id",
  "X-Request-Id",
  "X-PoW-Solution",
] as const;

export function authCorsMiddleware(): MiddlewareHandler<Env> {
  return cors({
    origin: (origin, c) => {
      if (!origin) return null;
      if (isReleasesFamilyOrigin(origin)) return origin;
      const env = c.env as Bindings;
      if (matchesTrustedOrigin(origin, extraTrustedOrigins(env))) return origin;
      if (env.ENVIRONMENT !== "production" && isLoopbackOrigin(origin)) return origin;
      return null;
    },
    allowHeaders: [...AUTH_CORS_ALLOWED_HEADERS],
    allowMethods: ["POST", "GET", "PUT", "PATCH", "DELETE", "OPTIONS"],
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
  /**
   * Audit-event sink — tests capture the emitted security/audit events without
   * spying on `console`; defaults to the real `logEvent`-backed emitter
   * ({@link makeAuthAudit}). See `audit.ts`.
   */
  audit?: AuthAuditEmitter;
}

/**
 * The endpoint-hook context Better Auth hands a `createAuthMiddleware` handler —
 * inferred from the wrapper so we get the real shape (`.path`, `.body`,
 * `.context`, and the fields `getSessionFromCtx` needs) instead of the looser
 * top-level-hook type.
 */
type ApiKeyHookCtx = Parameters<Parameters<typeof createAuthMiddleware>[0]>[0];

/**
 * Resolve the owning userId for an api-key create/delete hook. A real session
 * wins (the native HTTP endpoint rejects a body.userId and authenticates by
 * session); our trusted server call carries the verified owner as `body.userId`
 * with no session. So "session ?? body.userId" is the effective owner on every
 * path — and a forged body.userId can't game it, because a present session
 * always takes precedence. Session resolution failures degrade to body.userId.
 */
async function resolveApiKeyHookOwner(ctx: ApiKeyHookCtx): Promise<string | undefined> {
  const session = await getSessionFromCtx(ctx).catch(() => null);
  if (session?.user?.id) return session.user.id;
  const body = ctx.body as { userId?: unknown } | undefined;
  return typeof body?.userId === "string" ? body.userId : undefined;
}

/**
 * Better Auth plugin governing the user-key (`relu_`) lane: a per-user active-key
 * cap (before `/api-key/create`) and an audit trail (after create/delete). The
 * idiomatic matcher-scoped plugin form — handlers run ONLY for those two
 * endpoints (not on every auth request) and receive the properly-typed endpoint
 * context from `createAuthMiddleware`. Covers BOTH our `/v1/api-keys` route (a
 * server `auth.api.createApiKey` call) AND Better Auth's native
 * `/api/auth/api-key/*` HTTP endpoints, so neither the cap nor the audit can be
 * sidestepped by hitting the native endpoint directly.
 *
 * NOTE: our `/v1/api-keys/:id` DELETE hard-deletes via Drizzle (not
 * `auth.api.deleteApiKey`), so its revoke audit is emitted in the route; this
 * after-hook covers create on every path plus the native delete endpoint.
 */
function apiKeyGovernancePlugin(deps: {
  // oxlint-disable-next-line no-explicit-any -- matches CreateAuthDeps.db (D1 in prod, BunSQLite in tests)
  db: BaseSQLiteDatabase<any, any, any, any>;
  audit: AuthAuditEmitter;
}): BetterAuthPlugin {
  const { db, audit } = deps;
  return {
    id: "api-key-governance",
    hooks: {
      // BEFORE create: enforce the per-user active-key cap. Fail OPEN on an
      // unexpected count error — the cap is anti-sprawl, not a security control,
      // and must never break key creation on a transient DB hiccup.
      before: [
        {
          matcher: (ctx) => ctx.path === "/api-key/create",
          handler: createAuthMiddleware(async (ctx) => {
            const userId = await resolveApiKeyHookOwner(ctx);
            if (!userId) return; // no resolvable owner — the endpoint itself will 401
            let active: number;
            try {
              active = await countActiveUserKeys(db, userId);
            } catch (err) {
              logEvent("warn", {
                component: "user-api-keys",
                event: "cap-check-error",
                message: "active-key count failed; allowing create (fail-open)",
                error: err instanceof Error ? err.message : String(err),
              });
              return;
            }
            if (active >= USER_API_KEY_MAX_ACTIVE) {
              throw new APIError("FORBIDDEN", {
                code: API_KEY_LIMIT_CODE,
                message: API_KEY_LIMIT_MESSAGE,
              });
            }
          }),
        },
      ],
      // AFTER create/delete: emit the audit trail on the same `component: "auth"`
      // stream as sign-up / sign-in (with the owning userId), so issuance and
      // revocation are queryable alongside the other auth events. After-hooks run
      // even when the endpoint threw (the APIError lands in `returned`), so guard
      // on a successful result.
      after: [
        {
          matcher: (ctx) => ctx.path === "/api-key/create" || ctx.path === "/api-key/delete",
          handler: createAuthMiddleware(async (ctx) => {
            const returned = (ctx.context as { returned?: unknown }).returned;
            if (!returned || returned instanceof APIError) return; // endpoint failed
            const userId = await resolveApiKeyHookOwner(ctx);
            if (ctx.path === "/api-key/create") {
              const keyId = (returned as { id?: string }).id;
              audit("info", { event: "api-key-created", userId, keyId });
            } else {
              const body = ctx.body as { keyId?: unknown } | undefined;
              const keyId = typeof body?.keyId === "string" ? body.keyId : undefined;
              audit("info", { event: "api-key-revoked", userId, keyId });
            }
          }),
        },
      ],
    },
  };
}

type WaitUntilFn = (promise: Promise<unknown>) => void;

// Memoized instance must not close over one request's executionCtx. Per-request
// waitUntil is scoped via AsyncLocalStorage on /api/auth/* only.
// https://better-auth.com/docs/guides/optimizing-for-performance#background-tasks
const waitUntilAls = new AsyncLocalStorage<WaitUntilFn>();

/** Run `fn` with a request-scoped waitUntil (auth handler routes only). */
export function runAuthWithWaitUntil<T>(waitUntil: WaitUntilFn | undefined, fn: () => T): T {
  if (!waitUntil) return fn();
  return waitUntilAls.run(waitUntil, fn);
}

function runInBackground(promise: Promise<unknown>): void {
  const waitUntil = waitUntilAls.getStore();
  if (waitUntil) waitUntil(promise);
}

function secretBindingCacheKey(binding: SecretLike | undefined): string {
  if (binding == null) return "";
  return typeof binding === "string" ? binding : "store";
}

async function authCacheKey(env: Bindings): Promise<string> {
  const userApiKeysOn = await flag(env.FLAGS, env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled);
  return JSON.stringify({
    ENVIRONMENT: env.ENVIRONMENT ?? "",
    AUTH_RATE_LIMIT_DISABLED: env.AUTH_RATE_LIMIT_DISABLED ?? "",
    USER_API_KEYS_ENABLED: userApiKeysOn,
    BETTER_AUTH_URL: env.BETTER_AUTH_URL ?? "",
    WEB_BASE_URL: env.WEB_BASE_URL ?? "",
    BETTER_AUTH_COOKIE_DOMAIN: env.BETTER_AUTH_COOKIE_DOMAIN ?? "",
    BETTER_AUTH_TRUSTED_ORIGINS: env.BETTER_AUTH_TRUSTED_ORIGINS ?? "",
    BETTER_AUTH_IDENTIFY_URL: env.BETTER_AUTH_IDENTIFY_URL ?? "",
    OAUTH_RESOURCE_AUDIENCES: env.OAUTH_RESOURCE_AUDIENCES ?? "",
    BETTER_AUTH_SECRET_DEV: env.BETTER_AUTH_SECRET_DEV ?? "",
    BETTER_AUTH_SECRET: secretBindingCacheKey(env.BETTER_AUTH_SECRET),
    BETTER_AUTH_API_KEY: secretBindingCacheKey(env.BETTER_AUTH_API_KEY),
    GOOGLE_CLIENT_ID: secretBindingCacheKey(env.GOOGLE_CLIENT_ID),
    GOOGLE_CLIENT_SECRET: secretBindingCacheKey(env.GOOGLE_CLIENT_SECRET),
    GITHUB_CLIENT_ID: secretBindingCacheKey(env.GITHUB_CLIENT_ID),
    GITHUB_CLIENT_SECRET: secretBindingCacheKey(env.GITHUB_CLIENT_SECRET),
    STRIPE_SECRET_KEY: secretBindingCacheKey(env.STRIPE_SECRET_KEY),
    STRIPE_WEBHOOK_SECRET: secretBindingCacheKey(env.STRIPE_WEBHOOK_SECRET),
  });
}

const authInstanceCache = new Map<string, ReturnType<typeof buildAuthInstance>>();

/** Clear the per-isolate auth cache (tests only). */
export function resetAuthCacheForTests(): void {
  authInstanceCache.clear();
}

function hasCustomAuthDeps(deps: CreateAuthDeps): boolean {
  return deps.db != null || deps.sendEmail != null || deps.audit != null;
}

/**
 * Build the Better Auth instance for this worker's environment. Email/password is
 * always on (the dependency-free path). Google + GitHub are registered only when
 * their secrets resolve (see `buildSocialProviders`).
 */
async function buildAuthInstance(env: Bindings, deps: CreateAuthDeps = {}) {
  const secret = (await resolveSigningSecret(env)) ?? undefined;
  if (!secret) {
    // Deployed envs supply this via the Secrets Store binding (validated at
    // deploy). An unresolved secret here is expected only in local `wrangler dev`
    // with neither the binding nor `BETTER_AUTH_SECRET_DEV` set — Better Auth then
    // falls back to an ephemeral dev secret. Logged at warn so a genuine
    // deployed-env misconfig surfaces in Workers Logs.
    logEvent("warn", {
      component: "auth",
      event: "secret-unresolved",
      message:
        "BETTER_AUTH_SECRET unresolved (and no BETTER_AUTH_SECRET_DEV fallback); " +
        "Better Auth will use an ephemeral dev secret",
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
  // Audit-event sink for human-auth business actions (sign-up, sign-in-success,
  // sign-out / session-revoked, email-verified, password-reset-completed). Tests
  // inject a capturing sink; production routes through logEvent. Sign-in FAILURES
  // are logged separately at the HTTP layer (see index.ts) — a 429 rate-limit
  // never reaches these hooks. See audit.ts and #1427.
  const audit: AuthAuditEmitter = deps.audit ?? makeAuthAudit(env);

  // Fire-and-forget an email send: hand the REAL send promise to the request's
  // `waitUntil` so it outlives the response (the Better Auth docs flag AWAITING the
  // send as a timing-attack oracle, and on Workers a bare floating promise is
  // cancelled when the response returns). With no exec-ctx (tests / non-request
  // callers) it runs inline, where the injected capturing sender records
  // synchronously. `Promise.resolve` only normalizes a `void`-returning test sender;
  // a real send promise passes through unwrapped so `waitUntil` tracks it.
  const scheduleSend = (run: () => void | Promise<unknown>): void => {
    runInBackground(Promise.resolve(run()));
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

  // Sentinel (Better Auth Infrastructure abuse/security protection) shares the
  // BETTER_AUTH_API_KEY credential with dash() and talks to the *project-scoped*
  // KV "identify" endpoint — BETTER_AUTH_IDENTIFY_URL, e.g.
  // `https://kv.better-auth.com/projects/<id>` — onto which the plugin appends
  // `/identify/:requestId`, `/email/validate`, etc. The plugin's own default
  // (`https://kv.better-auth.com`, no project) is the WRONG target, so the URL
  // must be supplied as `kvUrl`. Workers read config from `env` bindings, not
  // `process.env`, so neither the key nor the URL is auto-discovered — pass both
  // explicitly. Sentinel mounts only when BOTH resolve: a missing key (or a
  // worker that never set the project URL) must NOT start making mis-targeted
  // outbound calls on every auth request. Same graceful-degradation seam as
  // dash()/social — absence is the natural off-switch, so no feature flag.
  const sentinelIdentifyUrl = env.BETTER_AUTH_IDENTIFY_URL;

  // userApiKeysOn — the relu_ user-key path (Flagship → var → default false); when
  // off, apiKey() and its self-serve endpoints aren't registered. Mirrors the
  // middleware/auth.ts gate.
  const userApiKeysOn = await flag(env.FLAGS, env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled);
  // deviceAuthOn — the device-authorization (RFC 8628) path backing `releases login`.
  // The deviceAuthorization() + bearer() plugins are always registered now. Device
  // login mints relu_ keys via the /v1/api-keys route (gated on userApiKeysEnabled),
  // so it is only USEFUL with that one also on.
  const deviceAuthOn = true;

  // Stripe customer registration (`@better-auth/stripe`). Built only when BOTH the
  // secret key and webhook signing secret resolve — same fail-safe seam as
  // dash()/sentinel()/social. Inert (null → omitted) until the secrets are
  // provisioned; once present, a Stripe Customer is created on every sign-up and
  // linked via user.stripeCustomerId. See `buildStripePlugin`.
  const stripeInstance = buildStripePlugin({
    secretKey: await resolveSecret(env.STRIPE_SECRET_KEY),
    webhookSecret: await resolveSecret(env.STRIPE_WEBHOOK_SECRET),
  });

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
    // Sentinel security/abuse protection. CONSERVATIVE action posture: hard-block
    // only the unambiguous cases — a compromised password at signup (HaveIBeenPwned
    // k-anonymity; only the first 5 hash chars leave the worker) and credential
    // stuffing once a visitor crosses the block threshold — and issue a non-blocking
    // Proof-of-Work CHALLENGE (the web sentinelClient auto-solves it; see
    // web/src/lib/auth-client.ts) for bots, suspicious IPs, and the first
    // credential-stuffing threshold. Impossible travel and stale-account
    // reactivation are LOG-only: observe in the Security dashboard before enforcing,
    // per the plugin's own best practice. emailNormalization dedupes Gmail-dot/plus
    // aliases so one human can't silently fork into multiple accounts. This rides
    // ALONGSIDE — not instead of — Better Auth's D1-backed brute-force rate limiting
    // (rateLimit below). Tune actions up once real traffic is visible.
    ...(dashApiKey && sentinelIdentifyUrl
      ? [
          sentinel({
            apiKey: dashApiKey,
            kvUrl: sentinelIdentifyUrl,
            security: {
              credentialStuffing: {
                enabled: true,
                thresholds: { challenge: 3, block: 5 },
              },
              compromisedPassword: { enabled: true, action: "block" },
              botBlocking: { action: "challenge" },
              suspiciousIpBlocking: { action: "challenge" },
              impossibleTravel: { enabled: true, action: "log" },
              staleUsers: { enabled: true, staleDays: 90, action: "log", notifyUser: true },
              emailNormalization: { enabled: true },
            },
          }),
        ]
      : []),
    ...(socialProviders.google ? [oneTap({ clientId: socialProviders.google.clientId })] : []),
    magicLink({
      expiresIn: 60 * 15,
      storeToken: "hashed",
      sendMagicLink: async ({ email, url }) => {
        const msg: AuthEmailMessage = {
          to: email,
          ...magicLinkTemplate({ url, webOrigin: webOriginForEmail(env) }),
        };
        scheduleSend(() => sendEmail(msg));
      },
    }),
    // Passkeys (WebAuthn / FIDO2). Always registered — like magic link it needs no
    // credential pair, only the relying-party config. `rpID`/`origin` are pinned to
    // the WEB origin (where the browser runs the ceremony), NOT this API worker's
    // origin; see `derivePasskeyRp` for why the plugin's baseURL-derived defaults are
    // wrong here. The challenge cookie the plugin sets rides the cross-subdomain
    // `.releases.sh` cookie domain configured in `advanced` below, so the
    // register/authenticate round-trips (both to this worker) carry it. The `passkey`
    // table is wired into the drizzleAdapter schema map below.
    passkeyPlugin(derivePasskeyRp(env)),
    // OAuth 2.0 / OIDC authorization server ("Sign in with Releases"). Issues
    // JWT access tokens (the adjacent jwt() plugin signs them + exposes JWKS)
    // and serves discovery metadata. Consent UI, per-user scope entitlement, and
    // resource-server JWT verification have all shipped, and dynamic client
    // registration (RFC 7591) is now ON so agent-run MCP clients can self-register
    // without an admin pre-provisioning each one. No feature flag — every issued
    // token is role-clamped at issuance (customAccessTokenClaims below) and DCR
    // clients are untrusted (consent required) + PKCE-required, so turning it on
    // grants no scope a user's role doesn't already allow.
    // The jwt() plugin signs the OAuth provider's access tokens AND exposes
    // GET /api/auth/token — the first-party "session → JWT" path the web admin
    // actions use. Config here pins that /token JWT to what the resource-server
    // verifier (oauthJwtConfig / verifyOAuthJwt) checks, and role-clamps its scope:
    //  - issuer: `${origin}/api/auth` — REQUIRED (the /token default is the bare
    //    origin, which the verifier rejects). Equals the OAuth tokens' resolved
    //    `iss` already (baseURL + default basePath), so it does NOT change them.
    //  - audience: bare `${origin}` — matches the verifier; OAuth tokens set `aud`
    //    explicitly from the request `resource`, so this never reaches them.
    //  - definePayload: role-clamped scope (fail-closed) — the security boundary.
    //    Isolated to /token; OAuth tokens use customAccessTokenClaims (below).
    //  - disableSettingJwtHeader: mint server-side via /token only; never broadcast
    //    the scoped JWT to the browser in the set-auth-jwt header on get-session.
    jwt({
      disableSettingJwtHeader: true,
      jwt: {
        issuer: `${new URL(env.BETTER_AUTH_URL ?? DEFAULT_AUTH_ORIGIN).origin}/api/auth`,
        audience: new URL(env.BETTER_AUTH_URL ?? DEFAULT_AUTH_ORIGIN).origin,
        // `user` is the plugin's User type, which doesn't carry `role` statically
        // (the admin plugin adds it at runtime) — cast at the call, mirroring the
        // customAccessTokenClaims pattern below. Do NOT annotate the destructured
        // param, or it can diverge from the plugin's expected callback type.
        definePayload: ({ user }) => jwtSessionPayload(user as { role?: string | null }),
      },
    }),
    oauthProvider({
      // ABSOLUTE web-origin URLs (not relative): the plugin redirects the browser
      // to these verbatim, and a relative path resolves against the request origin
      // (api.releases.sh) — the wrong worker. The /login + /oauth/consent pages are
      // served by the Next.js frontend (releases.sh). Same rule as the device-auth
      // verificationUri. WEB_BASE_URL is releases.sh in prod/staging, the portless
      // web origin locally; the session cookie is .releases.sh-scoped so it rides
      // across the two subdomains.
      loginPage: `${env.WEB_BASE_URL ?? "https://releases.sh"}/login`,
      consentPage: `${env.WEB_BASE_URL ?? "https://releases.sh"}/oauth/consent`, // page built in sub-project 3; path provisional
      scopes: ["openid", "profile", "email", "offline_access", "read", "write", "admin"],
      validAudiences: oauthValidAudiences(env),
      // RFC 7591 dynamic client registration. ON so off-the-shelf MCP clients
      // (Claude Desktop, MCP Inspector, agent runtimes) self-register a client_id
      // via the public /oauth2/register endpoint instead of an admin minting one.
      // Safe because DCR clients are untrusted (always hit the consent page), PKCE
      // is required for them, and every token they obtain is role-clamped by
      // customAccessTokenClaims below. FOLLOW-UP: a reaper for stale/unused
      // oauth_application rows (each registration is a row on a public endpoint).
      allowDynamicClientRegistration: true,
      // Allow registration WITHOUT a prior session. Off-the-shelf MCP clients hit
      // /oauth2/register BEFORE any user login, so DCR is inert for them without
      // this — the endpoint would 401 every tokenless registration. This is what
      // makes registration truly public (unauthenticated + row-creating), hence the
      // explicit rate limit below and the stale-row reaper follow-up. The plugin
      // notes this flag will be deprecated once the MCP protocol settles on Client
      // ID Metadata Documents / `software_statement`; revisit the lane then.
      allowUnauthenticatedClientRegistration: true,
      // Explicit abuse ceiling on the unauthenticated /oauth2/register endpoint —
      // pinned in-repo rather than inheriting the plugin's library default so the
      // limit is auditable here and can't silently drift. Enforced only when Better
      // Auth's core limiter is on (deployed prod; see `rateLimit.enabled` below).
      // 5/min/IP: a legitimate client registers once; this caps spray registration.
      rateLimit: { register: { window: 60, max: 5 } },
      // Set-once before first deploy (changing later orphans live tokens). Extends
      // the existing relk_/relu_ credential family. Access tokens are JWTs (no prefix).
      prefix: { refreshToken: "relo_", clientSecret: CLIENT_SECRET_PREFIX },
      // Per-user entitlement backstop + role claim. Runs at every user-token
      // issuance (authorization_code, refresh re-issue) and introspection, so no
      // token can carry scopes beyond the user's live role — even via a
      // skip_consent client or refresh replay. M2M tokens (no user) are skipped.
      // Wrapped because the plugin's `info.user` is typed as
      // `(User & Record<string, unknown>) | null | undefined` — the base `User`
      // type doesn't carry `role` statically (that field is added by the admin
      // plugin at runtime). Extracting `role` via the index signature satisfies
      // both the plugin's expected callback type and `oauthAccessTokenClaims`.
      customAccessTokenClaims: (info) => {
        const u = info.user;
        return oauthAccessTokenClaims({
          user:
            u === undefined
              ? undefined
              : u === null
                ? null
                : { role: u.role as string | null | undefined },
          scopes: info.scopes as string[] | undefined, // optional on the introspection path; oauthAccessTokenClaims guards with ?? []
        });
      },
    }),
    // Better Auth admin plugin — adds the `role` column that drives OAuth scope
    // entitlement (auth/entitlement.ts). Reuses the built-in admin/user roles;
    // `curator` mirrors `user` for admin-plugin permissions (NO user-management
    // powers) — its only meaning is the OAuth scope ceiling. The first admin is
    // provisioned via `PATCH /v1/admin/users/role` (root-key gated; see
    // docs/architecture/remote-mode.md) — once a user's `role` column is `admin`,
    // `adminRoles` authorizes them for native `setRole` too. Always-on, no flag.
    admin({
      roles: { admin: adminAc, user: userAc, curator: userAc },
      adminRoles: ["admin"],
      defaultRole: "user",
    }),
    ...(userApiKeysOn
      ? [
          apiKey({
            // Public-facing user keys. Distinct prefix from the relk_ machine lane.
            defaultPrefix: USER_API_KEY_PREFIX,
            requireName: true,
            enableMetadata: true,
            // Default tier (single config). Per-key overrides land at creation time.
            rateLimit: {
              enabled: env.ENVIRONMENT === "production",
              timeWindow: 1000 * 60 * 60, // 1 hour
              maxRequests: 1000,
            },
            // New keys default to read-only unless the caller passes explicit
            // cumulative permissions (web create passes scopeToPermissions(scope)).
            permissions: { defaultPermissions: scopeToPermissions("read") },
            // Hand metering/rate-limit writes to waitUntil (already wired in
            // `advanced.backgroundTasks` below) so they run after the response.
            deferUpdates: true,
          }),
          // Cap + audit for the user-key lane — registered only with apiKey(), since
          // its hooks govern that plugin's `/api-key/*` endpoints.
          apiKeyGovernancePlugin({ db, audit }),
        ]
      : []),
    // Device-authorization (RFC 8628) for `releases login`. bearer() MUST ride
    // alongside it: the device token endpoint returns a session access token that
    // the CLI then presents as `Authorization: Bearer <token>` to the /v1/api-keys
    // create route — bearer() is what makes `auth.api.getSession` (and thus
    // `requireSession`) honor that header instead of only the cookie. verificationUri
    // MUST be an ABSOLUTE URL on the WEB origin: the /device approval page is served
    // by the Next.js frontend (releases.sh), not this API worker (api.releases.sh).
    // The plugin only prefixes baseURL when the value is relative — a bare "/device"
    // resolves against baseURL and yields https://api.releases.sh/device, which 404s.
    // WEB_BASE_URL is releases.sh in prod/staging and the portless web origin locally;
    // the session cookie is .releases.sh-scoped so it rides across the two subdomains.
    // validateClient is a fail-closed allow-list: only our known CLI client id may
    // start a device flow (an unknown id can never obtain a token even though approval
    // is interactive — defense in depth).
    ...(deviceAuthOn
      ? [
          bearer(),
          deviceAuthorization({
            verificationUri: `${env.WEB_BASE_URL ?? "https://releases.sh"}/device`,
            validateClient: (clientId) => clientId === DEVICE_AUTH_CLIENT_ID,
            // `schema: {}` is load-bearing, not a no-op. The plugin's own options
            // schema declares `schema: z.custom(() => true)` WITHOUT `.optional()`;
            // zod ^4.3.x tolerated a missing value but the root-resolved zod@4.4.3
            // rejects `undefined` here ("expected nonoptional"). An empty object
            // satisfies the required field and `mergeSchema(builtin, {})` is an
            // additive no-op (no extra deviceCode columns). Drop this only once
            // better-auth ships the upstream `.optional()` fix or the tree no longer
            // resolves zod ≥4.4. See [[reference_mcp_worker_zod_pinned_to_sdk_nested]].
            schema: {},
          }),
        ]
      : []),
    // Tracks the auth method each user last signed in with and writes it to a
    // non-httpOnly cookie (`better-auth.last_used_login_method`). The cookie
    // inherits the session cookie's attributes — including the `.releases.sh`
    // cross-subdomain domain set above — so the web sign-in form (releases.sh) can
    // read a cookie set by this worker (api.releases.sh) and badge the method the
    // returning user used last. Cookie-only: no `storeInDatabase`, so no schema
    // column and no migration. The plugin's default resolver already covers the
    // Google redirect callback, password sign-in, and magic-link verify; the
    // override adds Google One Tap (`/one-tap/callback`), which the default misses.
    lastLoginMethod({
      customResolveMethod: (ctx) => resolveLastLoginMethodOverride(ctx.path),
    }),
    // Stripe customer registration — mounts only when both Stripe secrets resolve
    // (see `buildStripePlugin`). Adds the `stripeCustomerId` user field + the
    // sign-up customer-creation hook and serves the webhook at
    // /api/auth/stripe/webhook (handled by the existing /api/auth/* catch-all).
    ...(stripeInstance ? [stripeInstance] : []),
  ];

  return betterAuth({
    // Display name Better Auth surfaces in OTP/passkey labels, the hosted
    // dashboard, and the verification/reset transactional emails. Resolves the
    // dashboard's "Missing Application Name" insight. See {@link APP_NAME}.
    appName: APP_NAME,
    secret,
    // Fallback keeps the oauth-provider plugin's issuer (`new URL(baseURL)`)
    // parseable when BETTER_AUTH_URL is unset; prod/staging always set it.
    baseURL: env.BETTER_AUTH_URL ?? DEFAULT_AUTH_ORIGIN,
    trustedOrigins: authTrustedOrigins(env),
    // Short-lived signed cookie cache — avoids a D1 read on every getSession within
    // a visit. https://better-auth.com/docs/guides/optimizing-for-performance
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
      },
    },
    database: drizzleAdapter(db, {
      provider: "sqlite",
      // Schema key `rateLimit` must match Better Auth's default rate-limit model name.
      schema: {
        user,
        session,
        account,
        verification,
        rateLimit,
        apikey,
        deviceCode,
        oauthClient,
        oauthAccessToken,
        oauthRefreshToken,
        oauthConsent,
        jwks,
        passkey,
      },
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
        const msg: AuthEmailMessage = {
          to: u.email,
          ...resetPasswordTemplate({ url, webOrigin: webOriginForEmail(env) }),
        };
        scheduleSend(() => sendEmail(msg));
      },
      // Audit: a completed password reset (the user id only; no token material).
      onPasswordReset: auditOnPasswordReset(audit),
    },
    emailVerification: {
      sendOnSignUp: true,
      // Re-send a fresh verification link on each unverified sign-in attempt
      // (the web form surfaces "we just sent a fresh link" on the 403).
      sendOnSignIn: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user: u, url }) => {
        const msg: AuthEmailMessage = {
          to: u.email,
          ...verifyEmailTemplate({ url, webOrigin: webOriginForEmail(env) }),
        };
        scheduleSend(() => sendEmail(msg));
      },
      // Audit: a successful email verification (the auto-sign-in that follows logs
      // its own `sign-in-success` via the session.create hook below).
      afterEmailVerification: auditAfterEmailVerification(audit),
    },
    user: {
      // Human-facing display email, preserving the original casing/dots that the
      // Sentinel `emailNormalization` pass strips off the canonical `email` column.
      // Declared so the drizzle adapter persists the paired `display_email` column
      // and Better Auth returns it on the session user. `input: false` keeps it
      // server-set only — it's populated from the OAuth profile via each provider's
      // `mapProfileToUser` (see `mapDisplayEmail`), never accepted from a client
      // sign-up/update body (which would let a caller spoof their own display
      // email). `returned: true` (the default) surfaces it to the web session.
      additionalFields: {
        displayEmail: { type: "string", required: false, input: false },
      },
      // Self-serve email change from the account page (`/api/auth/change-email`).
      // Default-off in Better Auth; opt in here. Every user reaches us verified
      // (requireEmailVerification above), so the flow that matters is the
      // verified-user path: `sendChangeEmailConfirmation` fires and a confirmation
      // link is emailed to the user's CURRENT address — the change only lands once
      // that link is clicked. `updateEmailWithoutVerification` is left default-off
      // so an email is NEVER switched without a confirming click. Routes through the
      // same `scheduleSend` → `waitUntil` seam as verify/reset so the send outlives
      // the response on Workers; the binding-absent case degrades to a logged
      // no-send (see sendAuthEmail), never a crash.
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user: u, newEmail, url }) => {
          const msg: AuthEmailMessage = {
            to: u.email,
            ...changeEmailTemplate({ url, newEmail, webOrigin: webOriginForEmail(env) }),
          };
          scheduleSend(() => sendEmail(msg));
        },
      },
    },
    socialProviders,
    plugins,
    // Audit hooks for sign-up / sign-in-success / sign-out / session-revoked. See
    // audit.ts; the failure stream is logged at the HTTP layer in index.ts. The
    // api-key cap + create/delete audit ride the `apiKeyGovernancePlugin` in
    // `plugins` above (matcher-scoped to the `/api-key/*` endpoints). Merged with a
    // `user.update.before` transform that keeps `displayEmail` fresh on an email
    // change (see `syncDisplayEmailOnUpdate`) — the audit hooks define only
    // `user.create.after`, so the two `user` sub-keys compose without collision.
    databaseHooks: (() => {
      const auditHooks = auditDatabaseHooks(audit);
      return {
        ...auditHooks,
        user: {
          ...auditHooks.user,
          update: {
            before: async (data: Record<string, unknown>) => syncDisplayEmailOnUpdate(data),
          },
        },
      };
    })(),
    // Per-user scope-entitlement gate on the OAuth consent submission. Rejects a
    // consent that grants scopes beyond the signed-in user's role BEFORE it is
    // persisted (the friendly, early half of the fail-closed pair; the token
    // backstop above is authoritative). Only matches /oauth2/consent; everything
    // else passes through. getSessionFromCtx reads the cookie/bearer session.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/oauth2/consent") return;
        const session = await getSessionFromCtx(ctx);
        const role = (session?.user as { role?: string } | undefined)?.role;
        if (consentScopeViolation(role, ctx.body as { accept?: unknown; scope?: unknown })) {
          throw new APIError("BAD_REQUEST", {
            error: "invalid_scope",
            error_description: "requested scopes exceed your entitlement",
          });
        }
      }),
      // Response `after` hook: backfill `display_email` for Google One Tap
      // sign-ins. One Tap verifies its own ID token at `/one-tap/callback` and
      // never routes through a provider's `mapProfileToUser`, so the standard-flow
      // capture (`mapDisplayEmail`) never fires for a One-Tap user — neither on
      // create nor on re-login — and they'd keep seeing the dot-stripped canonical
      // email. We run {@link backfillDisplayEmailOnSignIn} here instead, gated on a
      // SUCCESSFUL callback: `ctx.context.returned` carries a `user` only when the
      // plugin's `jwtVerify` passed (an invalid token surfaces an APIError with no
      // `user`), so we never act on an unverified token. The returned user's
      // `email` is the canonical lookup key; the original-cased value comes from
      // re-reading the (already-verified) token's `email` claim.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path !== "/one-tap/callback") return;
        const returned = ctx.context.returned as { user?: { email?: unknown } } | undefined;
        const email = returned?.user?.email;
        if (typeof email !== "string" || !email) return;
        const originalEmail = emailFromGoogleIdToken((ctx.body as { idToken?: unknown })?.idToken);
        if (!originalEmail) return;
        await backfillDisplayEmailOnSignIn(db, email, originalEmail);
      }),
    },
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
      backgroundTasks: { handler: runInBackground },
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

/**
 * Memoized per worker isolate when no test deps are injected; wrap /api/auth/*
 * handler calls in {@link runAuthWithWaitUntil} so background work gets the
 * request's executionCtx.waitUntil.
 */
export async function createAuth(
  env: Bindings,
  /** @deprecated Ignored — use {@link runAuthWithWaitUntil} on /api/auth/* instead. */
  _waitUntil?: WaitUntilFn,
  deps: CreateAuthDeps = {},
) {
  if (hasCustomAuthDeps(deps)) return buildAuthInstance(env, deps);
  const key = await authCacheKey(env);
  if (!authInstanceCache.has(key)) {
    authInstanceCache.set(key, buildAuthInstance(env, {}));
  }
  return authInstanceCache.get(key)!;
}

/** The resolved Better Auth instance type (used as a Hono context test seam). */
export type BetterAuthInstance = Awaited<ReturnType<typeof buildAuthInstance>>;
