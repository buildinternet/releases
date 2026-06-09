import { sqliteTable, text, integer, index } from "drizzle-orm/sqlite-core";

/**
 * Better Auth core schema — `user` / `session` / `account` / `verification`.
 *
 * This is a **worker-local** schema island, deliberately NOT added to the
 * published `@buildinternet/releases-core` schema map (the OSS CLI consumes that
 * package and has no business with auth tables). The Drizzle table objects are
 * handed directly to Better Auth's `drizzleAdapter({ schema })`, so they don't
 * need to live in `createDb`'s schema map to be queryable by the adapter.
 *
 * Column names are snake_case to match repo convention; the JS property keys are
 * the camelCase names Better Auth expects (the adapter resolves fields by key).
 * Timestamps use Drizzle's integer `timestamp` mode and booleans the integer
 * `boolean` mode — this is Better Auth's canonical Drizzle/SQLite shape, which
 * round-trips `Date`/`boolean` through the adapter cleanly (the repo's app tables
 * use ISO-text timestamps, but auth tables follow Better Auth's expectations).
 *
 * Paired migrations live in workers/api/migrations/ (20260604000000 initial tables,
 * 20260604010000 the dash lastActiveAt column, 20260604020000 the rate-limit store,
 * 20260604030000 the api-key store, 20260605000000 the device-code store,
 * 20260607010000 the admin-plugin role/ban columns, 20260609010000 the Stripe
 * customer id).
 * The schema↔migration pairing gate in ci.yml watches this file.
 */

/** A non-null integer `timestamp` column with a JS-side default (Better Auth sets these too). */
const timestampCol = (name: string) =>
  integer(name, { mode: "timestamp" })
    .notNull()
    .$defaultFn(() => new Date());

export const user = sqliteTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: integer("email_verified", { mode: "boolean" })
    .notNull()
    .$defaultFn(() => false),
  image: text("image"),
  createdAt: timestampCol("created_at"),
  updatedAt: timestampCol("updated_at"),
  // Better Auth Infrastructure ("dash") activity tracking stamps this on user
  // activity (throttled to the plugin's updateInterval, default 5 min) so the
  // hosted dashboard can show "last active". Nullable on purpose: existing rows
  // and users inactive since the column was added have no value until dash()
  // next records them. Paired migration: 20260604010000_add_user_last_active_at.sql.
  lastActiveAt: integer("last_active_at", { mode: "timestamp" }),
  // Better Auth `admin` plugin (better-auth/plugins). `role` drives the OAuth
  // scope-entitlement ceiling (see auth/entitlement.ts). No schema default — the
  // plugin stamps "user" on new sign-ups at runtime; existing rows stay NULL,
  // which entitledScopes() treats as read-only (fail-closed). Multi-role is a
  // comma-separated string. Paired migration: 20260607010000_add_admin_plugin.sql.
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" }),
  // Better Auth Stripe plugin (`@better-auth/stripe`). The id of the Stripe
  // Customer linked to this user — written on sign-up when the plugin is mounted
  // (`createCustomerOnSignUp`, gated on the Stripe secrets resolving in
  // auth/index.ts). Nullable: existing rows and users who signed up before the
  // plugin was provisioned have no Stripe customer until one is created. This is
  // billing groundwork (customer management only); subscriptions are not enabled
  // yet, so the plugin's `subscription` table is intentionally absent. Paired
  // migration: 20260609010000_add_stripe_customer_id.sql.
  stripeCustomerId: text("stripe_customer_id"),
});

export const session = sqliteTable(
  "session",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
    // Better Auth `admin` plugin — set when this session is an admin impersonating a user.
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("idx_session_user_id").on(t.userId)],
);

export const account = sqliteTable(
  "account",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    accessTokenExpiresAt: integer("access_token_expires_at", { mode: "timestamp" }),
    refreshTokenExpiresAt: integer("refresh_token_expires_at", { mode: "timestamp" }),
    scope: text("scope"),
    idToken: text("id_token"),
    // Credential (email/password) accounts store the hashed password here.
    password: text("password"),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_account_user_id").on(t.userId)],
);

export const verification = sqliteTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_verification_identifier").on(t.identifier)],
);

/**
 * Better Auth rate-limit store — used when `rateLimit.storage: "database"` (see
 * createAuth). Keeps rate-limit counters in D1 so they hold across Worker isolates;
 * Better Auth's in-memory default resets per isolate and is useless on serverless.
 * The column set is mandated by Better Auth (id / key / count / lastRequest, epoch
 * ms). Model name is the default "rateLimit", so the drizzle-adapter schema key must
 * stay `rateLimit`. Paired migration: 20260604020000_add_rate_limit.sql.
 */
export const rateLimit = sqliteTable("rate_limit", {
  id: text("id").primaryKey(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});

/**
 * Better Auth API key plugin (`@better-auth/api-key`) store — user-owned, metered
 * API keys. `referenceId` is the owning user id (config `references: "user"`).
 * `permissions` is a JSON string encoding the scope ladder as cumulative actions
 * on one `api` resource (see workers/api/src/auth/api-key-scope.ts). The hashed
 * key lives in `key`; `start`/`prefix` are non-secret display aids. `configId`
 * scopes the key to a named plugin configuration (default "default"); only
 * relevant with multiple `apiKey()` configs. Column set is mandated by the plugin
 * — reconcile with `@better-auth/cli generate`. Paired migration:
 * 20260604030000_add_api_key.sql.
 */
export const apikey = sqliteTable(
  "apikey",
  {
    id: text("id").primaryKey(),
    name: text("name"),
    start: text("start"),
    prefix: text("prefix"),
    key: text("key").notNull(),
    referenceId: text("reference_id").notNull(),
    configId: text("config_id"),
    refillInterval: integer("refill_interval"),
    refillAmount: integer("refill_amount"),
    lastRefillAt: integer("last_refill_at", { mode: "timestamp" }),
    // null = plugin treats as enabled; set false to disable the key
    enabled: integer("enabled", { mode: "boolean" }),
    rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count"),
    remaining: integer("remaining"),
    lastRequest: integer("last_request", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (t) => [index("idx_apikey_key").on(t.key), index("idx_apikey_reference_id").on(t.referenceId)],
);

/**
 * Better Auth device-authorization plugin (`deviceAuthorization`) store — the
 * OAuth 2.0 Device Authorization Grant (RFC 8628) pending-request table that
 * backs `releases login` from the CLI. One row per device-code request, moving
 * `pending` → `approved`/`denied` as the user acts in the browser; the plugin
 * reaps expired rows. `userId` is null until a session claims and approves the
 * code. The field set is mandated by the plugin (see its `schema.mjs`): it has
 * NO created/updated timestamps. Like `rate_limit`, the SQL name is snake_case
 * but the drizzle-adapter schema KEY must stay the camelCase model name
 * `deviceCode`. Paired migration: 20260605000000_add_device_code.sql.
 */
export const deviceCode = sqliteTable(
  "device_code",
  {
    id: text("id").primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    // null until a signed-in session approves the request.
    userId: text("user_id"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    // pending | approved | denied
    status: text("status").notNull(),
    lastPolledAt: integer("last_polled_at", { mode: "timestamp" }),
    pollingInterval: integer("polling_interval"),
    clientId: text("client_id"),
    scope: text("scope"),
  },
  (t) => [
    index("idx_device_code_device_code").on(t.deviceCode),
    index("idx_device_code_user_code").on(t.userCode),
  ],
);

/**
 * Better Auth OAuth Provider plugin (`@better-auth/oauth-provider`) store. The
 * AS lives in the API worker; these tables back client registration, issued
 * tokens, and per-user consent. JWT access tokens are self-contained (no row);
 * `oauthAccessToken` holds OPAQUE tokens only. The drizzle-adapter schema KEY
 * must equal the plugin's model name (camelCase), SQL names stay snake_case —
 * same split as `rateLimit`/`deviceCode`. Paired migration: 20260607000000_add_oauth_provider.sql.
 */
export const oauthClient = sqliteTable(
  "oauth_client",
  {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().unique(),
    clientSecret: text("client_secret"),
    name: text("name"),
    icon: text("icon"),
    uri: text("uri"),
    redirectUris: text("redirect_uris", { mode: "json" }).$type<string[]>().notNull(),
    postLogoutRedirectUris: text("post_logout_redirect_uris", { mode: "json" }).$type<string[]>(),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    grantTypes: text("grant_types", { mode: "json" }).$type<string[]>(),
    responseTypes: text("response_types", { mode: "json" }).$type<string[]>(),
    contacts: text("contacts", { mode: "json" }).$type<string[]>(),
    tokenEndpointAuthMethod: text("token_endpoint_auth_method"),
    type: text("type"),
    public: integer("public", { mode: "boolean" }),
    requirePKCE: integer("require_pkce", { mode: "boolean" }),
    disabled: integer("disabled", { mode: "boolean" }),
    skipConsent: integer("skip_consent", { mode: "boolean" }),
    enableEndSession: integer("enable_end_session", { mode: "boolean" }),
    subjectType: text("subject_type"),
    tos: text("tos"),
    policy: text("policy"),
    softwareId: text("software_id"),
    softwareVersion: text("software_version"),
    softwareStatement: text("software_statement"),
    userId: text("user_id"),
    referenceId: text("reference_id"),
    metadata: text("metadata", { mode: "json" }),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_oauth_client_client_id").on(t.clientId)],
);

export const oauthAccessToken = sqliteTable(
  "oauth_access_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id").notNull(),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    refreshId: text("refresh_id"),
    userId: text("user_id"),
    referenceId: text("reference_id"),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: timestampCol("created_at"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("idx_oauth_access_token_token").on(t.token)],
);

export const oauthRefreshToken = sqliteTable(
  "oauth_refresh_token",
  {
    id: text("id").primaryKey(),
    token: text("token").notNull().unique(),
    clientId: text("client_id").notNull(),
    sessionId: text("session_id").references(() => session.id, { onDelete: "set null" }),
    userId: text("user_id").notNull(),
    referenceId: text("reference_id"),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    // Revocation timestamp, not a boolean flag: a Date when revoked, NULL while active.
    revoked: integer("revoked", { mode: "timestamp" }),
    authTime: integer("auth_time", { mode: "timestamp" }),
    createdAt: timestampCol("created_at"),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [index("idx_oauth_refresh_token_token").on(t.token)],
);

export const oauthConsent = sqliteTable(
  "oauth_consent",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull(),
    clientId: text("client_id").notNull(),
    referenceId: text("reference_id"),
    scopes: text("scopes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: timestampCol("created_at"),
    updatedAt: timestampCol("updated_at"),
  },
  (t) => [index("idx_oauth_consent_user_client").on(t.userId, t.clientId)],
);

/**
 * Better Auth `jwt()` plugin keyset — the signing keypair for JWT access
 * tokens, encrypted at rest under BETTER_AUTH_SECRET. Model name `jwks`.
 * `expiresAt` is optional in the plugin schema (key rotation support).
 */
export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestampCol("created_at"),
  expiresAt: integer("expires_at", { mode: "timestamp" }),
});

export type AuthUser = typeof user.$inferSelect;
export type AuthSession = typeof session.$inferSelect;
export type AuthAccount = typeof account.$inferSelect;
export type AuthVerification = typeof verification.$inferSelect;
export type AuthRateLimit = typeof rateLimit.$inferSelect;
export type AuthApiKey = typeof apikey.$inferSelect;
export type AuthDeviceCode = typeof deviceCode.$inferSelect;
export type AuthOAuthClient = typeof oauthClient.$inferSelect;
export type AuthOAuthAccessToken = typeof oauthAccessToken.$inferSelect;
export type AuthOAuthRefreshToken = typeof oauthRefreshToken.$inferSelect;
export type AuthOAuthConsent = typeof oauthConsent.$inferSelect;
export type AuthJwks = typeof jwks.$inferSelect;
