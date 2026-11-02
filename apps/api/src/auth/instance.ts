/**
 * The Better Auth instance and the plugins that need Better Auth / Stripe at
 * runtime. Split from `index.ts` so those packages load on the first
 * `createAuth()` call instead of at isolate startup: their module evaluation
 * was a large share of the API worker's script-startup CPU, which Cloudflare
 * caps. `index.ts` keeps the light helpers and imports this module lazily.
 */
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
  organization,
} from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
import { oauthProvider } from "@better-auth/oauth-provider";
import { cimd } from "@better-auth/cimd";
import { passkey as passkeyPlugin } from "@better-auth/passkey";
import { dash, sentinel } from "@better-auth/infra";
import { apiKey } from "@better-auth/api-key";
import { stripe as stripePlugin } from "@better-auth/stripe";
import Stripe from "stripe";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, getSessionFromCtx } from "better-auth/api";
import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";
import { logEvent } from "@releases/lib/log-event";
import { FLAGS, flag } from "@releases/lib/flags";
import {
  USER_API_KEY_PREFIX,
  DEVICE_AUTH_CLIENT_ID,
  isDeviceAuthPurpose,
} from "@buildinternet/releases-core/api-token";
import { releaseWebBase } from "@buildinternet/releases-core/release-slug";
import {
  oauthAccessTokenClaims,
  consentScopeViolation,
  jwtSessionPayload,
  DCR_SCOPES,
  OAUTH_SCOPES,
} from "./entitlement.js";
import { applyOAuthClientInterop } from "./oauth-client-interop.js";
import { cimdClientRowPatch, createWorkersClientMetadataFetch } from "./oauth-cimd.js";
import { annotatePublicClientOfficial, PUBLIC_CLIENT_PATHS } from "./oauth-public-client.js";
import {
  oauthClientIdFromAuthorizationCode,
  oauthUserIdFromAuthorizationCode,
  restrictAuthorizationCodeValue,
} from "./oauth-grant-scopes.js";
import { ensureActiveWorkspace, isOrgOwnerOrAdmin } from "./workspace.js";
import { kvRateLimitStorage } from "./rate-limit-kv.js";
import {
  alignAuthEmail,
  blockDuplicateMailboxCreate,
  resolveStoredMailbox,
} from "./mailbox-link.js";
import { scopeToPermissions } from "./api-key-scope.js";
import { CLIENT_SECRET_PREFIX } from "./oauth-clients.js";
import {
  USER_API_KEY_MAX_ACTIVE,
  API_KEY_LIMIT_CODE,
  API_KEY_LIMIT_MESSAGE,
  countActiveUserKeys,
} from "./api-key-limit.js";
import { createDb, type AnyDb } from "../db.js";
import { eq } from "drizzle-orm";
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
  oauthResource,
  oauthClientResource,
  oauthClientAssertion,
  jwks,
  passkey,
  authOrganization,
  authMember,
  authInvitation,
  subscription,
} from "../db/schema-auth.js";
import type { Env } from "../index.js";
import {
  APP_NAME,
  DEFAULT_AUTH_ORIGIN,
  LOGGED_IN_HINT_COOKIE,
  applyUserUpdateGuards,
  authTrustedOrigins,
  backfillDisplayEmailOnSignIn,
  buildSocialProviders,
  clampRegisteredDcrClient,
  deriveCookieDomain,
  derivePasskeyRp,
  emailFromGoogleIdToken,
  oauthValidAudiences,
  resolveLastLoginMethodOverride,
  resolveSecret,
  resolveSigningSecret,
  runInBackground,
  webOriginForEmail,
  type AuthEmailSender,
  type CreateAuthDeps,
} from "./index.js";

type Bindings = Env["Bindings"];
import {
  sendAuthEmail,
  verifyEmailTemplate,
  resetPasswordTemplate,
  magicLinkTemplate,
  changeEmailTemplate,
  invitationEmailTemplate,
  type AuthEmailMessage,
} from "./email.js";
import {
  makeAuthAudit,
  auditDatabaseHooks,
  auditAfterEmailVerification,
  auditOnPasswordReset,
  type AuthAuditEmitter,
} from "./audit.js";
import { classifyAuthApiError } from "./auth-error.js";

/**
 * Build the Better Auth Stripe plugin (`@better-auth/stripe`), gated on BOTH the
 * secret API key and the webhook signing secret resolving. Absent either →
 * `null` and the plugin is omitted, so billing is inert until the secrets are
 * provisioned. Present both → a Stripe Customer is created per user on sign-up
 * and linked via `stripeCustomerId`.
 *
 * Subscriptions are wired but inert (`plans: []`): keyed to the workspace
 * (`referenceId` = organization id) and gated to its owner/admin, so adding
 * plans later needs no further plumbing.
 *
 * Worker-compat: the Stripe SDK's default HTTP transport isn't available on
 * Workers, so the client uses the Fetch HTTP client. `apiVersion` is left at the
 * SDK default so it always matches the installed SDK's types.
 */
export function buildStripePlugin(
  creds: {
    secretKey?: string | null;
    webhookSecret?: string | null;
  },
  db: AnyDb,
): BetterAuthPlugin | null {
  if (!creds.secretKey || !creds.webhookSecret) return null;
  const stripeClient = new Stripe(creds.secretKey, {
    httpClient: Stripe.createFetchHttpClient(),
  });
  return stripePlugin({
    stripeClient,
    stripeWebhookSecret: creds.webhookSecret,
    createCustomerOnSignUp: true,
    // `authorizeReference` checks org `member.role`, NOT `user.role`.
    subscription: {
      enabled: true,
      plans: [],
      authorizeReference: async ({
        user: u,
        referenceId,
      }: {
        user: { id: string };
        referenceId: string;
      }) => isOrgOwnerOrAdmin(db, u.id, referenceId),
    },
  }) as BetterAuthPlugin;
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
  const authed = await getSessionFromCtx(ctx).catch(() => null);
  if (authed?.user?.id) return authed.user.id;
  const body = ctx.body as { userId?: unknown } | undefined;
  return typeof body?.userId === "string" ? body.userId : undefined;
}

const API_KEY_NAME_MAX_BYTES = 200;
const utf8Encoder = new TextEncoder();

/**
 * Point OAuth `getUserInfo` at an existing user's stored email when the
 * provider address is the same mailbox under a different spelling (Gmail dots,
 * `+tag`). Better Auth then links the provider account instead of inserting a
 * second user. A new mailbox is left unchanged, so sign-up still stores the
 * address the provider sent.
 *
 * Listed after `sentinel` so this wrapper stays outside Sentinel's. With
 * `emailNormalization` off, Sentinel does not wrap `getUserInfo` at all.
 */
function mailboxLinkPlugin(db: AnyDb): BetterAuthPlugin {
  return {
    id: "mailbox-link",
    init(ctx) {
      for (const provider of ctx.socialProviders) {
        const original = provider.getUserInfo.bind(provider);
        provider.getUserInfo = async (token) => {
          const result = await original(token);
          const email = result?.user?.email;
          if (typeof email !== "string" || !email) return result;
          const stored = await resolveStoredMailbox(db, email);
          if (stored.toLowerCase() === email.trim().toLowerCase()) return result;
          return { ...result, user: { ...result.user, email: stored } };
        };
      }
    },
  };
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
      // BEFORE create/update: enforce a byte-length cap. On create, also enforce
      // the active-key cap. The count check fails open because it is anti-sprawl,
      // not a security control, and must never break key creation on a transient
      // DB hiccup.
      before: [
        {
          matcher: (ctx) => ctx.path === "/api-key/create" || ctx.path === "/api-key/update",
          handler: createAuthMiddleware(async (ctx) => {
            const name = (ctx.body as { name?: unknown } | undefined)?.name;
            if (
              typeof name === "string" &&
              utf8Encoder.encode(name).byteLength > API_KEY_NAME_MAX_BYTES
            ) {
              throw new APIError("BAD_REQUEST", {
                code: "INVALID_NAME_LENGTH",
                message: `API key name must be at most ${API_KEY_NAME_MAX_BYTES} bytes`,
              });
            }

            if (ctx.path === "/api-key/update") return;

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

/**
 * Mirror the httpOnly session-token cookie into a readable `releases.logged_in`
 * hint cookie so the browser can cheaply tell "signed in at least once" from
 * "definitely anonymous" WITHOUT calling `/api/auth/get-session`.
 *
 * Why this exists: every web page runs `useSession()` (global header + follows
 * provider), which fires a cross-origin `get-session` on mount — unconditionally,
 * even for signed-out visitors and JS-executing crawlers (Applebot/Googlebot).
 * That made `get-session` the single most-requested API path. Gating the client
 * probe on this hint eliminates the call for anyone who has never authenticated.
 *
 * The hint is set/cleared in lockstep with the ACTUAL session-token cookie (its
 * own Max-Age is copied), so it can never diverge from the real session lifetime —
 * the trap with reusing `better-auth.last_used_login_method` (fixed 30-day maxAge,
 * only refreshed on an explicit sign-in, so it can outlive or under-live a sliding
 * session). It inherits the session cookie's domain/path/secure/sameSite (including
 * the cross-subdomain `.releases.sh` domain) and differs only in `httpOnly: false`
 * and its value. It carries NO identity — just presence — so it's safe to expose.
 */
function loggedInHintPlugin(): BetterAuthPlugin {
  return {
    id: "logged-in-hint",
    hooks: {
      after: [
        {
          matcher: () => true,
          handler: createAuthMiddleware(async (ctx) => {
            const setCookies = ctx.context.responseHeaders?.getSetCookie?.() ?? [];
            const sessionName = ctx.context.authCookies.sessionToken.name;
            const sessionCookie = setCookies.find((c) => c.startsWith(`${sessionName}=`));
            // Only act when THIS response touches the session-token cookie (sign-in,
            // sign-out, or a sliding refresh). Other responses leave the hint as-is.
            if (!sessionCookie) return;

            const attributes = {
              ...ctx.context.authCookies.sessionToken.attributes,
              httpOnly: false,
            };
            const value = sessionCookie.slice(sessionName.length + 1).split(";")[0];
            const maxAgeMatch = /max-age=(-?\d+)/i.exec(sessionCookie);
            const maxAge = maxAgeMatch ? Number(maxAgeMatch[1]) : undefined;
            // Cleared session cookie (sign-out) → empty value or a non-positive Max-Age.
            const cleared = value === "" || (maxAge != null && maxAge <= 0);
            if (cleared) {
              ctx.setCookie(LOGGED_IN_HINT_COOKIE, "", { ...attributes, maxAge: 0 });
            } else {
              ctx.setCookie(LOGGED_IN_HINT_COOKIE, "1", {
                ...attributes,
                ...(maxAge != null ? { maxAge } : {}),
              });
            }
          }),
        },
      ],
    },
  };
}

/**
 * Build the Better Auth instance for this worker's environment. Email/password is
 * always on (the dependency-free path). Google + GitHub are registered only when
 * their secrets resolve (see `buildSocialProviders`).
 */
export async function buildAuthInstance(env: Bindings, deps: CreateAuthDeps = {}) {
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
  const db: AnyDb = deps.db ?? createDb(env.DB);
  const sendEmail: AuthEmailSender = deps.sendEmail ?? ((msg) => sendAuthEmail(env, msg));
  // Audit-event sink for human-auth business actions (sign-up, sign-in-success,
  // sign-out / session-revoked, email-verified, password-reset-completed). Tests
  // inject a capturing sink; production routes through logEvent. Sign-in FAILURES
  // are logged separately at the HTTP layer (see index.ts) — a 429 rate-limit
  // never reaches these hooks. See audit.ts and #1427.
  const audit: AuthAuditEmitter = deps.audit ?? makeAuthAudit(env);

  /**
   * Registered `oauth_client.scopes`. Missing / empty row → {@link DCR_SCOPES}
   * (not the advertised AS list) so a rewrite cannot elevate to write/admin.
   */
  async function registeredScopesForClientId(
    clientId: string | undefined,
  ): Promise<readonly string[]> {
    if (!clientId) return DCR_SCOPES;
    const [row] = await db
      .select({ scopes: oauthClient.scopes })
      .from(oauthClient)
      .where(eq(oauthClient.clientId, clientId))
      .limit(1);
    return row?.scopes && row.scopes.length > 0 ? row.scopes : DCR_SCOPES;
  }

  /**
   * Re-assert the DCR ceiling on a newly created CIMD row, and log the event.
   * Best-effort: the plugin logs and ignores a thrown callback, so a failed
   * clamp never fails the authorize.
   */
  async function clampCimdClient(
    client: Parameters<typeof cimdClientRowPatch>[0] & { clientId: string },
  ): Promise<void> {
    const patch = cimdClientRowPatch(client);
    if (patch) {
      await db.update(oauthClient).set(patch).where(eq(oauthClient.clientId, client.clientId));
    }
    logEvent("info", {
      component: "auth",
      event: "oauth-cimd-client-created",
      clientId: client.clientId,
      clamped: patch !== undefined,
    });
  }

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

  // Better Auth Infrastructure ("dash"): the hosted dashboard reads from this
  // backend through dash(). Mounts only when the API key resolves, so keyless
  // local dev makes no outbound calls. Activity tracking stamps
  // `user.lastActiveAt` without awaiting the write, so it's approximate on Workers.
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

  // When off, apiKey() and its self-serve endpoints aren't registered. Mirrors
  // the middleware/auth.ts gate.
  const userApiKeysOn = await flag(env.FLAGS, env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled);
  // Device authorization (RFC 8628) backs `releases login`. It mints relu_ keys
  // via /v1/api-keys, so it is only useful with userApiKeysOn too.
  const deviceAuthOn = true;

  const stripeInstance = buildStripePlugin(
    {
      secretKey: await resolveSecret(env.STRIPE_SECRET_KEY),
      webhookSecret: await resolveSecret(env.STRIPE_WEBHOOK_SECRET),
    },
    db,
  );

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
    // apps/web/src/lib/auth-client.ts) for bots, suspicious IPs, and the first
    // credential-stuffing threshold. Impossible travel and stale-account
    // reactivation are LOG-only: observe in the Security dashboard before enforcing,
    // per the plugin's own best practice. This rides ALONGSIDE — not instead of —
    // Better Auth's D1-backed brute-force rate limiting (rateLimit below). Tune
    // actions up once real traffic is visible.
    //
    // emailNormalization is explicitly OFF. Omitting the key does not do that:
    // Sentinel treats an absent flag as on (`emailValidation.enabled !== false`).
    // The pass rewrote Gmail dots / plus-tags on email sign-up but, until infra
    // 0.4.22, not on the OAuth lookup, so one mailbox became two users. Linking
    // those spellings to the existing row is `mailboxLinkPlugin`, which does not
    // rewrite `user.email`.
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
              emailNormalization: { enabled: false },
            },
          }),
        ]
      : []),
    // After sentinel so the wrapper sees the provider email Sentinel would have
    // rewritten, and replaces it with the stored address instead.
    mailboxLinkPlugin(db),
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
        definePayload: ({ user: jwtUser }) =>
          jwtSessionPayload(jwtUser as { role?: string | null }),
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
      loginPage: `${releaseWebBase(env)}/login`,
      consentPage: `${releaseWebBase(env)}/oauth/consent`,
      scopes: [...OAUTH_SCOPES],
      // DCR capability ceiling. Discovery still lists the full `scopes` list
      // (admin included) for first-party clients; these two options are the
      // plugin-native operator policy so a DCR/CIMD document cannot persist
      // write/admin or inherit `scopes_supported`. Both lists are the same
      // tight allowlist — the effective set is their union, and omitting
      // `Allowed` would fall back to `scopes` (the bug this patch closes).
      clientRegistrationDefaultScopes: [...DCR_SCOPES],
      clientRegistrationAllowedScopes: [...DCR_SCOPES],
      // Public DCR clients always require PKCE; keep the confidential-DCR
      // default on too so a plugin regression cannot opt a DCR row out.
      clientRegistrationRequirePKCE: true,
      // Each identifier becomes an `oauth_resource` row (seeded at boot,
      // insert-only) and is an RFC 8707 `resource` a client may request; the
      // minted token's `aud` is bound to it.
      resources: oauthValidAudiences(env),
      // 1.7 rejects a DCR request carrying `resources` unless they're
      // whitelisted. Mark ours *allowed* (client selects) rather than *default*
      // (force-attached to every client), preserving the 1.6 behavior where any
      // registered client could target these audiences.
      clientRegistrationAllowedResources: oauthValidAudiences(env),
      // Defaults to true in 1.7, which requires an `oauth_client_resource` link
      // for every requested `resource` and otherwise fails with
      // `invalid_target`. Standard MCP clients send `resource` as an
      // authorize/token parameter, never at DCR, so they are never linked and
      // there is no admin flow to link them. `false` lets any enabled resource be
      // requested; the token stays `aud`-bound to it. Matches buildinternet/uploads.
      enforcePerClientResources: false,
      // A refresh token replayed within 60s of rotation returns the original
      // response instead of revoking the family. Concurrent refreshers and
      // retries are routine in MCP clients and would otherwise force a full
      // re-authorization. Same default as Better Auth's mcp() plugin.
      refreshTokenReuseInterval: 60,
      // RFC 7591 DCR so off-the-shelf MCP clients self-register. Safety is the
      // DCR_SCOPES ceiling + forced public/PKCE + consent. FOLLOW-UP: a reaper
      // for stale oauth_client rows (each registration is a row on a public endpoint).
      allowDynamicClientRegistration: true,
      // MCP clients register BEFORE any user login, so DCR is inert without
      // this. It makes registration public and row-creating, hence the rate limit
      // below. The plugin plans to deprecate this flag once MCP settles on CIMD /
      // `software_statement`; revisit then.
      allowUnauthenticatedClientRegistration: true,
      // Pinned here rather than inheriting the library default so it can't drift.
      // Enforced only when the core limiter is on (prod; see `rateLimit` below).
      rateLimit: { register: { window: 60, max: 5 } },
      // Set-once before first deploy (changing later orphans live tokens). Extends
      // the existing relk_/relu_ credential family. Access tokens are JWTs (no prefix).
      prefix: { refreshToken: "relo_", clientSecret: CLIENT_SECRET_PREFIX },
      // Per-user entitlement backstop + role claim. Runs at every user-token
      // issuance and introspection, so no token can carry scopes beyond the
      // user's live role, even via a skip_consent client or refresh replay.
      // `role` is read via the index signature because the admin plugin adds it
      // at runtime; the base `User` type doesn't carry it.
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
    // Client ID Metadata Documents (#2409): a client may send an HTTPS URL as its
    // `client_id` instead of registering; the plugin fetches that document and
    // persists a discovery-owned row (DCR_SCOPES ceiling, consent required, no
    // shared secret, PKCE). Also advertises `client_id_metadata_document_supported`
    // in AS metadata. DCR above stays on for clients without CIMD. The fetch cache
    // and rate limits are per isolate (the auth instance is memoized). See
    // oauth-cimd.ts and docs/architecture/mcp-cimd-interop.md.
    cimd({
      fetchClientMetadataResource:
        deps.fetchClientMetadataResource ?? createWorkersClientMetadataFetch(),
      metadataProfile: "mcp-2026-07-28",
      // Created only: a refresh re-derives scopes from DCR_SCOPES and keeps the
      // operator-set flags, so an admin `trusted` PATCH must not be reverted.
      onClientCreated: ({ client }) => clampCimdClient(client),
    }),
    // Adds the `role` column that drives OAuth scope entitlement
    // (auth/entitlement.ts). `curator` mirrors `user` for admin-plugin
    // permissions; its only meaning is the OAuth scope ceiling.
    admin({
      roles: { admin: adminAc, user: userAc, curator: userAc },
      adminRoles: ["admin"],
      defaultRole: "user",
    }),
    // User-tenancy "Workspaces", DISTINCT from the registry `organizations`
    // (indexed vendors). Personal workspaces are provisioned lazily by the
    // session.create.before hook below. Roles here are org `member.role`, NOT
    // `user.role`. `sendInvitationEmail` exists so the UI-less but reachable
    // invitation endpoint isn't silently broken.
    organization({
      membershipLimit: 100,
      sendInvitationEmail: async (data) => {
        const url = `${releaseWebBase(env)}/accept-invitation/${data.id}`;
        const msg: AuthEmailMessage = {
          to: data.email,
          ...invitationEmailTemplate({
            url,
            orgName: data.organization.name,
            webOrigin: webOriginForEmail(env),
          }),
        };
        scheduleSend(() => sendEmail(msg));
      },
    }),
    ...(userApiKeysOn
      ? [
          apiKey({
            // Public-facing user keys. Distinct prefix from the relk_ machine lane.
            defaultPrefix: USER_API_KEY_PREFIX,
            maximumNameLength: 200,
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
    // bearer() MUST ride alongside deviceAuthorization(): the CLI presents the
    // device session token as a Bearer to /v1/api-keys, and bearer() is what makes
    // getSession honor it. verificationUri MUST be absolute on the web origin; a
    // bare "/device" resolves against baseURL (api.releases.sh) and 404s.
    // validateClient is a fail-closed allow-list of our CLI client id.
    ...(deviceAuthOn
      ? [
          bearer(),
          deviceAuthorization({
            verificationUri: `${releaseWebBase(env)}/device`,
            validateClient: (clientId) => clientId === DEVICE_AUTH_CLIENT_ID,
            // The CLI names why it's asking (`login`, `keys`, `publish-tokens`) so
            // the approval page can say so. Absent is allowed for CLIs that predate
            // it; anything else is refused rather than shown as an unknown request.
            onDeviceAuthRequest: (_clientId, scope) => {
              if (!scope || isDeviceAuthPurpose(scope)) return;
              throw new APIError("BAD_REQUEST", {
                error: "invalid_scope",
                error_description: "Unknown device authorization purpose",
              });
            },
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
    // Writes the last-used sign-in method to a non-httpOnly cookie on the
    // `.releases.sh` domain so the web sign-in form can badge it. Cookie-only, no
    // schema column. The override adds Google One Tap, which the default misses.
    lastLoginMethod({
      customResolveMethod: (ctx) => resolveLastLoginMethodOverride(ctx.path),
    }),
    loggedInHintPlugin(),
    // Webhook served at /api/auth/stripe/webhook via the /api/auth/* catch-all.
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
    // Browser auth failures redirect here instead of Better Auth's default
    // error page (`${baseURL}/error`, the API origin) or a raw HTML dump.
    // Absolute on the web origin: a root-relative path resolves against
    // baseURL and would strand the user on api.releases.sh.
    // `onError` sees thrown API errors only — a `ctx.redirect` is status
    // FOUND and returns before the hook. Those redirects are logged from the
    // `/api/auth/*` handler. The hook records the code, never the message.
    onAPIError: {
      errorURL: `${releaseWebBase(env)}/auth/error`,
      onError: (error) => {
        const fields = classifyAuthApiError(error);
        if (!fields) return;
        audit("warn", fields);
      },
    },
    // Short-lived cookie cache avoids a D1 read on every getSession within a
    // visit. `jwe` encrypts the `session_data` cookie; `session_token` stays the
    // credential.
    // https://better-auth.com/docs/concepts/session-management#cookie-cache-strategies
    session: {
      cookieCache: {
        enabled: true,
        maxAge: 5 * 60,
        strategy: "jwe",
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
        // Better Auth 1.7 oauth-provider tables: the persisted resource model
        // (seeded from `resources` above), the per-client resource binding, and
        // the private_key_jwt assertion jti store.
        oauthResource,
        oauthClientResource,
        oauthClientAssertion,
        jwks,
        passkey,
        // Organization plugin ("Workspaces") + the @better-auth/stripe subscription
        // store. Keys MUST be Better Auth's model names; the `auth*`-prefixed Drizzle
        // tables map onto them. SQL names are `organization`/`member`/`invitation` —
        // singular, no collision with the registry `organizations` (plural).
        organization: authOrganization,
        member: authMember,
        invitation: authInvitation,
        subscription,
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
      // Original casing and Gmail dots from the provider profile. `input: false`
      // keeps it server-set (via `mapDisplayEmail`) so a client can't spoof it.
      // The stored `email` is not rewritten from a social sign-in.
      additionalFields: {
        displayEmail: { type: "string", required: false, input: false },
      },
      // The confirmation link goes to the user's CURRENT address and the change
      // lands only once it's clicked. `updateEmailWithoutVerification` stays off
      // so an email is never switched without that click.
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
    // Audit hooks (see audit.ts; sign-in failures are logged in index.ts) merged
    // with the user guards. `user.create.after` is the audit sign-up hook and is
    // referenced explicitly so a change in audit.ts can't be dropped by this
    // override. `user.create.before` refuses a second row for a mailbox that
    // already exists under another spelling. `user.update.before` keeps a social
    // profile refresh from writing `email`.
    databaseHooks: (() => {
      const auditHooks = auditDatabaseHooks(audit);
      return {
        ...auditHooks,
        user: {
          ...auditHooks.user,
          create: {
            before: async (data: { email?: unknown }) => blockDuplicateMailboxCreate(db, data),
            after: auditHooks.user.create.after,
          },
          update: {
            before: async (data: Record<string, unknown>, context) =>
              applyUserUpdateGuards(
                db,
                data,
                context,
                env.MEDIA_ORIGIN ?? "https://media.releases.sh",
              ),
          },
        },
        // Composed at the leaf level (explicit references, not `...auditHooks.session`)
        // so a change to audit.ts's session hooks surfaces as a TYPE ERROR here rather
        // than silently dropping an audit hook the spread would have carried.
        session: {
          create: {
            after: auditHooks.session.create.after,
            // ensureActiveWorkspace creates a personal workspace on first sign-in
            // and never throws, so a hiccup can't block sign-in.
            before: async (s: { userId: string; activeOrganizationId?: string | null }) => {
              const orgId = await ensureActiveWorkspace(db, s.userId);
              return orgId ? { data: { ...s, activeOrganizationId: orgId } } : undefined;
            },
          },
          // Persist the user's last active workspace so the selection is sticky across
          // sessions (multi-workspace users). Best-effort; never blocks.
          update: {
            after: async (s: { userId?: string; activeOrganizationId?: string | null }) => {
              const activeOrgId = s.activeOrganizationId;
              if (s.userId && activeOrgId) {
                await db
                  .update(user)
                  .set({ lastActiveOrganizationId: activeOrgId })
                  .where(eq(user.id, s.userId))
                  .catch(() => {});
              }
            },
          },
          delete: auditHooks.session.delete,
        },
        // Generic MCP clients copy extras into authorize `scope=`. Rewrite the
        // authorization-code blob at persist so token exchange cannot issue a
        // scope the client (or the user) is not allowed. `hooks.before` on
        // `/oauth2/token` does not see this value.
        verification: {
          create: {
            before: async (data: { value?: unknown }) => {
              const value = typeof data.value === "string" ? data.value : undefined;
              if (!value || !value.includes("authorization_code")) return;
              const allowedScopes = await registeredScopesForClientId(
                oauthClientIdFromAuthorizationCode(value),
              );
              const userId = oauthUserIdFromAuthorizationCode(value);
              let role: string | null | undefined;
              if (userId) {
                const [row] = await db
                  .select({ role: user.role })
                  .from(user)
                  .where(eq(user.id, userId))
                  .limit(1);
                role = row?.role;
              }
              const next = restrictAuthorizationCodeValue(value, allowedScopes, role);
              if (!next) return;
              return { data: { ...data, value: next } };
            },
          },
        },
      };
    })(),
    // Generic MCP client interop (DCR extra grant_types, kitchen-sink
    // authorize/consent scope) then the per-user scope-entitlement gate on
    // consent. Better Auth takes a single `hooks.before` middleware.
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // Same mailbox, different spelling (jane.doe@ vs janedoe@) signs into the
        // existing user. Runs before the OAuth interop rewrite; those paths don't
        // overlap. `/change-email` is not rewritten.
        const linkedEmail = await alignAuthEmail(db, ctx.path, ctx.body);
        const requestCtx = linkedEmail
          ? { ...ctx, body: { ...(ctx.body as Record<string, unknown>), email: linkedEmail } }
          : ctx;
        const authed = ctx.path === "/oauth2/consent" ? await getSessionFromCtx(ctx) : null;
        const role = (authed?.user as { role?: string } | undefined)?.role;
        const oauthOverride = await applyOAuthClientInterop(
          requestCtx,
          registeredScopesForClientId,
          role,
        );
        const consentBody = (oauthOverride?.context.body ?? requestCtx.body) as
          | { accept?: unknown; scope?: unknown }
          | undefined;
        if (ctx.path === "/oauth2/consent" && consentScopeViolation(role, consentBody)) {
          throw new APIError("BAD_REQUEST", {
            error: "invalid_scope",
            error_description: "requested scopes exceed your entitlement",
          });
        }
        if (oauthOverride) return oauthOverride;
        if (linkedEmail) return { context: { body: requestCtx.body } };
      }),
      // One Tap never routes through `mapProfileToUser`, so `display_email` is
      // backfilled here instead. `returned.user` is present only when the
      // plugin's `jwtVerify` passed, so we never act on an unverified token.
      after: createAuthMiddleware(async (ctx) => {
        if (ctx.path === "/oauth2/register") {
          await clampRegisteredDcrClient(db, ctx.context.returned);
          return;
        }
        // Consent page trust tier: add the operator-set `official` flag to the
        // public client info (see oauth-public-client.ts).
        if (PUBLIC_CLIENT_PATHS.has(ctx.path)) {
          await annotatePublicClientOfficial(db, ctx.context.returned);
          return;
        }
        if (ctx.path !== "/one-tap/callback") return;
        const returned = ctx.context.returned as { user?: { email?: unknown } } | undefined;
        const email = returned?.user?.email;
        if (typeof email !== "string" || !email) return;
        const originalEmail = emailFromGoogleIdToken((ctx.body as { idToken?: unknown })?.idToken);
        if (!originalEmail) return;
        await backfillDisplayEmailOnSignIn(db, email, originalEmail);
      }),
    },
    // Persistent storage so counters survive across isolates (the in-memory
    // default resets per isolate). Better Auth's prod auto-enable keys off
    // NODE_ENV, which Workers don't set, so it's gated explicitly.
    //
    // FAIL-CLOSED: on in any deployed prod env, deliberately NOT coupled to the
    // signing secret resolving, so a transiently unresolved secret can't drop
    // brute-force protection. `AUTH_RATE_LIMIT_DISABLED` is the explicit opt-out
    // for local `.dev.vars`.
    //
    // STORAGE (#1728): KV when `AUTH_RATE_LIMIT_KV` is bound (prod) so floods
    // don't write-amplify into D1; otherwise D1. See ./rate-limit-kv.ts.
    rateLimit: {
      enabled: env.ENVIRONMENT === "production" && env.AUTH_RATE_LIMIT_DISABLED !== "true",
      ...(env.AUTH_RATE_LIMIT_KV
        ? { customStorage: kvRateLimitStorage(env.AUTH_RATE_LIMIT_KV) }
        : { storage: "database" as const }),
    },
    advanced: {
      backgroundTasks: { handler: runInBackground },
      // True client IP behind Cloudflare; `x-forwarded-for` covers local
      // `wrangler dev`. Drives rate-limit keying and dash's IP analytics.
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
      // Per-environment cookie names. Only staging sets one: its cookie domain
      // (`.releasenotesindex.dev`) is a parent of the local dev hosts
      // (`*.local.releasenotesindex.dev`), so with the default names a staging
      // session would ride along to the local API. Prod keeps the default so
      // existing sessions survive.
      ...(env.BETTER_AUTH_COOKIE_PREFIX ? { cookiePrefix: env.BETTER_AUTH_COOKIE_PREFIX } : {}),
    },
  });
}
