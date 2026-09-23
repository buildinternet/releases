import { AsyncLocalStorage } from "node:async_hooks";
import type { MiddlewareHandler } from "hono";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { getSecret } from "@releases/lib/secrets";
import { logEvent } from "@releases/lib/log-event";
import { FLAGS, flag } from "@releases/lib/flags";
import { audienceVariants, mcpResourceAndOrigin } from "@releases/lib/oauth-jwt";
import { releaseWebBase } from "@buildinternet/releases-core/release-slug";
import { clampDcrRegistrationResult, dcrClientRowPatch } from "./oauth-dcr.js";
import { preserveCustomAvatarOnUpdate } from "../lib/media/avatar-ingest.js";
import type { AnyDb } from "../db.js";
import { and, eq, isNull } from "drizzle-orm";
import { user, oauthClient } from "../db/schema-auth.js";
import type { Env } from "../index.js";
import type { buildAuthInstance } from "./instance.js";
import type { AuthEmailMessage } from "./email.js";
import type { AuthAuditEmitter } from "./audit.js";

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
export async function resolveSecret(value: SecretLike): Promise<string | null> {
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
   * so the avatar we surface stays current. Custom uploads mirrored to R2 are
   * preserved by `preserveCustomAvatarOnUpdate` in the `user.update.before` hook.
   * See `buildSocialProviders`.
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
export async function applyUserUpdateGuards(
  db: AnyDb,
  data: Record<string, unknown>,
  context: unknown,
  mediaOrigin: string,
): Promise<{ data: Record<string, unknown> } | undefined> {
  let merged = data;
  let changed = false;

  const emailPatch = syncDisplayEmailOnUpdate(data);
  if (emailPatch) {
    merged = emailPatch.data;
    changed = true;
  }

  const userId = (context as { context?: { session?: { user?: { id?: string } } } } | null)?.context
    ?.session?.user?.id;
  if (userId && "image" in merged) {
    const [row] = await db
      .select({ image: user.image })
      .from(user)
      .where(eq(user.id, userId))
      .limit(1);
    const preserved = preserveCustomAvatarOnUpdate(merged, row?.image, mediaOrigin);
    if (preserved) {
      merged = preserved.data;
      changed = true;
    }
  }

  return changed ? { data: merged } : undefined;
}

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
export async function backfillDisplayEmailOnSignIn(
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

/**
 * After a successful `/oauth2/register`, persist the DCR ceiling on the new
 * row and rewrite the 201 JSON so it cannot advertise `admin`/`write` or a
 * `client_secret`. Best-effort: a missing client_id or a thrown update must
 * not fail the registration response (the before-hook + plugin options are
 * the primary gate).
 */
export async function clampRegisteredDcrClient(db: AnyDb, returned: unknown): Promise<void> {
  const clientId = clampDcrRegistrationResult(returned);
  if (!clientId) return;
  const record = returned as { scope?: unknown; scopes?: unknown };
  const patch = dcrClientRowPatch(record.scope ?? record.scopes);
  try {
    await db.update(oauthClient).set(patch).where(eq(oauthClient.clientId, clientId));
  } catch (err) {
    logEvent("warn", {
      component: "auth",
      event: "dcr-row-clamp-failed",
      message: "DCR client row clamp failed after register",
      error: err instanceof Error ? err.message : String(err),
    });
  }
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
export const DEFAULT_AUTH_ORIGIN = "https://api.releases.sh";

/**
 * Product display name Better Auth surfaces in OTP/passkey prompts, the hosted
 * dashboard, and transactional emails. Single source so the betterAuth `appName`
 * and the passkey `rpName` ({@link derivePasskeyRp}) can't drift apart.
 */
export const APP_NAME = "Releases";

/**
 * Protected resources this AS issues access tokens for — fed to the 1.7
 * `resources` model (and `clientRegistrationAllowedResources`), which replaced
 * the 1.6 `validAudiences` list. Still the set of valid `aud` values: the origin
 * of this AS
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
    if (!trimmed) continue;
    // MCP identifiers only: origin AND /mcp so a client that copies either
    // RFC 9728 `resource` (origin) or the transport URL still authorizes.
    // Do not expand the API origin from BETTER_AUTH_URL the same way.
    for (const id of mcpResourceAndOrigin(trimmed)) auds.add(id);
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
  const base = releaseWebBase(env);
  try {
    const url = new URL(base);
    return { rpID: url.hostname, rpName: APP_NAME, origin: url.origin };
  } catch {
    return { rpID: "releases.sh", rpName: APP_NAME, origin: "https://releases.sh" };
  }
}

/** Web origin for links in user-facing auth email templates. */
export function webOriginForEmail(env: { WEB_BASE_URL?: string }): string {
  return derivePasskeyRp(env).origin;
}

/**
 * Baseline CORS preflight allow-list. The Sentinel client (#1544) stamps
 * `/api/auth/*` with `X-Visitor-Id` / `X-Request-Id` / `X-PoW-Solution` — these
 * must be listed or auth preflights fail. Drift-tested against the installed
 * `@better-auth/infra` client in auth.test.ts. Preflights may also request
 * extra headers; those are unioned in at request time.
 */
export const AUTH_CORS_ALLOWED_HEADERS = [
  "Content-Type",
  "Authorization",
  "Idempotency-Key",
  "X-Visitor-Id",
  "X-Request-Id",
  "X-PoW-Solution",
] as const;

/**
 * True when `origin` may receive credentialed CORS (reflected ACAO +
 * credentials). Same allow-list as Better Auth: releases family, operator
 * `BETTER_AUTH_TRUSTED_ORIGINS`, loopback off-prod.
 */
export function isTrustedCorsOrigin(
  origin: string,
  env: { ENVIRONMENT?: string; BETTER_AUTH_TRUSTED_ORIGINS?: string },
): boolean {
  if (!origin) return false;
  if (isReleasesFamilyOrigin(origin)) return true;
  if (matchesTrustedOrigin(origin, extraTrustedOrigins(env as Bindings))) return true;
  if (env.ENVIRONMENT !== "production" && isLoopbackOrigin(origin)) return true;
  return false;
}

/**
 * Apply credentialed / public CORS headers onto a finalized response.
 * Mutates `headers` in place so it works for both Hono-built responses and
 * raw `Response` objects (Better Auth's `auth.handler` returns the latter).
 */
function applyCorsHeaders(
  headers: Headers,
  origin: string,
  env: { ENVIRONMENT?: string; BETTER_AUTH_TRUSTED_ORIGINS?: string },
): void {
  if (isTrustedCorsOrigin(origin, env)) {
    headers.set("Access-Control-Allow-Origin", origin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.append("Vary", "Origin");
  } else {
    headers.set("Access-Control-Allow-Origin", "*");
  }
}

/**
 * Worker-wide CORS (#2205), keyed on origin not path:
 * trusted first-party → reflect + credentials; else → `*` (no credentials);
 * no Origin → no CORS headers. New session-cookie browser surfaces need no
 * registration — only the trusted-origin list shared with Better Auth.
 *
 * Headers for non-OPTIONS requests are applied AFTER `next()`. Setting them
 * before is lost when a handler returns a raw `Response` (Hono replaces
 * `c.res` and does not merge pre-set `c.header()` values) — which is exactly
 * what `/api/auth/*` does via Better Auth. That regression shipped in #2207
 * and broke production `get-session` (200 with no ACAO). OPTIONS still returns
 * early with headers on a Hono-built body, so it never hit the bug.
 */
export function apiCorsMiddleware(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const origin = c.req.header("Origin");
    const env = c.env as Bindings;

    if (c.req.method === "OPTIONS") {
      // Hono-built body — c.header() is fine (no raw Response replacement).
      if (origin) {
        if (isTrustedCorsOrigin(origin, env)) {
          c.header("Access-Control-Allow-Origin", origin);
          c.header("Access-Control-Allow-Credentials", "true");
          c.header("Vary", "Origin", { append: true });
        } else {
          c.header("Access-Control-Allow-Origin", "*");
        }
      }
      c.header("Access-Control-Allow-Methods", "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS");
      c.header("Access-Control-Max-Age", "600");
      const requested = c.req.header("Access-Control-Request-Headers");
      const headers = requested
        ? [
            ...new Set([
              ...AUTH_CORS_ALLOWED_HEADERS,
              ...requested.split(/\s*,\s*/).filter(Boolean),
            ]),
          ]
        : [...AUTH_CORS_ALLOWED_HEADERS];
      c.header("Access-Control-Allow-Headers", headers.join(", "));
      c.header("Vary", "Access-Control-Request-Headers", { append: true });
      return c.body(null, 204);
    }

    await next();

    // 101 (WebSocket upgrade) headers are immutable — same skip as cacheDefaultDeny.
    if (c.res.status === 101) return;
    // Must mutate the finalized response: raw Response returns (Better Auth)
    // replace c.res and drop any pre-next c.header() values.
    c.res.headers.set("Access-Control-Expose-Headers", "Idempotency-Replayed");
    if (origin) applyCorsHeaders(c.res.headers, origin, env);
  };
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

export function runInBackground(promise: Promise<unknown>): void {
  const waitUntil = waitUntilAls.getStore();
  if (waitUntil) waitUntil(promise);
}

function secretBindingCacheKey(binding: SecretLike | undefined): string {
  if (binding == null) return "";
  return typeof binding === "string" ? binding : "store";
}

const dbObjectIds = new WeakMap<object, number>();
let nextDbObjectId = 0;

/** Stable per binding object — prod D1 is one object per isolate; tests get a fresh drizzle per createTestDb(). */
function dbBindingCacheKey(db: unknown): string {
  if (db == null || typeof db !== "object") return "";
  let id = dbObjectIds.get(db);
  if (id === undefined) {
    id = ++nextDbObjectId;
    dbObjectIds.set(db, id);
  }
  return String(id);
}

async function authCacheKey(env: Bindings): Promise<string> {
  const userApiKeysOn = await flag(env.FLAGS, env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled);
  return JSON.stringify({
    DB: dbBindingCacheKey(env.DB),
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

// Better Auth, its plugins, and Stripe live in ./instance.ts and load on the
// first createAuth() call, memoized per isolate. Importing them here statically
// put their module evaluation in the worker's script startup, which Cloudflare
// caps (error 10021).
let authInstanceModule: Promise<typeof import("./instance.js")> | undefined;
function loadAuthInstanceModule(): Promise<typeof import("./instance.js")> {
  authInstanceModule ??= import("./instance.js");
  return authInstanceModule;
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
 * Name of the non-httpOnly "is there a session" hint cookie. The web client gates
 * its `getSession` probe on this cookie's presence (see apps/web/src/lib/auth-client.ts):
 * absent → skip the network call entirely and treat the visitor as anonymous.
 */
export const LOGGED_IN_HINT_COOKIE = "releases.logged_in";

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
  const { buildAuthInstance } = await loadAuthInstanceModule();
  if (hasCustomAuthDeps(deps)) return buildAuthInstance(env, deps);
  const key = await authCacheKey(env);
  if (!authInstanceCache.has(key)) {
    authInstanceCache.set(key, buildAuthInstance(env, {}));
  }
  return authInstanceCache.get(key)!;
}

/** The resolved Better Auth instance type (used as a Hono context test seam). */
export type BetterAuthInstance = Awaited<ReturnType<typeof buildAuthInstance>>;
