# OAuth Provider — AS Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the API worker's Better Auth instance an OAuth 2.0 / OIDC authorization server that can mint JWT access tokens and serve discovery metadata, inert until an admin provisions a client.

**Architecture:** Add `@better-auth/oauth-provider` + its required `jwt()` companion to `createAuth` in `workers/api`, always-on (no feature flag). Five new Drizzle/D1 tables back the plugin; apex `.well-known/*` routes proxy Better Auth's discovery metadata for OAuth clients. Public client registration, consent UI, per-user scope entitlement, and resource-server verification are out of scope (later sub-projects).

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Workers + Hono, Drizzle ORM over D1, Better Auth (`better-auth` ^1.6.14, `@better-auth/oauth-provider` ^1.6.14), bun:test.

**Reference spec:** `docs/superpowers/specs/2026-06-07-oauth-provider-foundation-design.md`

---

## File Structure

| File                                                           | Responsibility                                                                         | Action |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------ |
| `workers/api/package.json`                                     | Declare `@better-auth/oauth-provider` dep                                              | Modify |
| `workers/api/src/db/schema-auth.ts`                            | Drizzle table objects for the 5 new auth tables                                        | Modify |
| `workers/api/migrations/20260607000000_add_oauth_provider.sql` | Paired DDL for the 5 tables                                                            | Create |
| `workers/api/src/auth/index.ts`                                | Register `jwt()` + `oauthProvider()`, adapter schema map, `oauthValidAudiences` helper | Modify |
| `workers/api/src/index.ts`                                     | Mount apex `.well-known/*` discovery alias routes, `OAUTH_RESOURCE_AUDIENCES` binding  | Modify |
| `workers/api/src/oauth-discovery.ts`                           | `forwardWellKnown` helper (apex → Better Auth discovery proxy + CORS)                  | Create |
| `workers/api/wrangler.jsonc`                                   | `OAUTH_RESOURCE_AUDIENCES` var (prod + staging)                                        | Modify |
| `workers/api/test/oauth-provider.test.ts`                      | All tests for this sub-project                                                         | Create |

---

## Task 1: Add the `@better-auth/oauth-provider` dependency

**Files:**

- Modify: `workers/api/package.json`

- [ ] **Step 1: Add the dependency**

In `workers/api/package.json`, add to `dependencies` (alphabetically near the other `@better-auth/*` entries), pinned to match `better-auth`:

```jsonc
"@better-auth/oauth-provider": "^1.6.14",
```

- [ ] **Step 2: Install**

Run (from repo root): `bun install`
Expected: lockfile updates, `node_modules/@better-auth/oauth-provider` exists.

- [ ] **Step 3: Verify the import + the jwt companion resolve**

Run: `cd workers/api && bun -e "import('@better-auth/oauth-provider').then(m=>console.log('oauth-provider:',Object.keys(m).filter(k=>/oauth|mcp|metadata/i.test(k)))); import('better-auth/plugins').then(m=>console.log('jwt:', typeof m.jwt))"`
Expected: prints the oauth-provider exports (look for `oauthProvider`, and metadata helpers) and `jwt: function`. **Record the exact exported names** — they are used in Tasks 3–4.

- [ ] **Step 4: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS (no new errors).

- [ ] **Step 5: Commit**

```bash
git add workers/api/package.json bun.lock
git commit -m "build(api): add @better-auth/oauth-provider dependency"
```

---

## Task 2: Add the five OAuth/JWT tables + migration

**Files:**

- Modify: `workers/api/src/db/schema-auth.ts`
- Create: `workers/api/migrations/20260607000000_add_oauth_provider.sql`
- Create (started here): `workers/api/test/oauth-provider.test.ts`

> **Source of truth for column/model names:** Before writing the Drizzle objects, read the installed plugin schema to confirm the exact Better Auth **model names** (adapter map keys) and **field names** (the camelCase property keys). Run:
> `cd workers/api && grep -rsn "oauthClient\|oauthApplication\|oauthAccessToken\|oauthRefreshToken\|oauthConsent\|jwks\|fieldName\|modelName" node_modules/@better-auth/oauth-provider/dist node_modules/better-auth/dist/plugins/jwt | head -80`
> The SQL column names below are ours (snake_case, repo convention); the **JS property keys MUST equal Better Auth's field names** or the Drizzle adapter cannot resolve them. Adjust the drafts below to match what you find.

- [ ] **Step 1: Write the failing schema round-trip test**

Create `workers/api/test/oauth-provider.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { createTestDb } from "./setup";
import {
  oauthClient,
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
  jwks,
} from "../src/db/schema-auth.js";

// ── Schema: the migrated test DB has the 5 new tables and they round-trip ──
// createTestDb() applies every migration, so a missing table or column throws here.
describe("oauth provider schema", () => {
  it("oauth_client round-trips through drizzle", async () => {
    const db = createTestDb();
    await db.insert(oauthClient).values({
      id: "oc_1",
      clientId: "client-abc",
      clientSecret: "secret-xyz",
      name: "Test Client",
      redirectUris: ["https://app.example.com/callback"],
      scopes: ["openid", "read"],
      public: false,
      requirePKCE: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const rows = await db.select().from(oauthClient);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.clientId).toBe("client-abc");
    expect(rows[0]?.redirectUris).toEqual(["https://app.example.com/callback"]);
    expect(rows[0]?.scopes).toEqual(["openid", "read"]);
  });

  it("jwks round-trips through drizzle", async () => {
    const db = createTestDb();
    await db.insert(jwks).values({
      id: "jwk_1",
      publicKey: "PUB",
      privateKey: "PRIV",
      createdAt: new Date(),
    });
    const rows = await db.select().from(jwks);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.publicKey).toBe("PUB");
  });

  it("oauth_access_token / oauth_refresh_token / oauth_consent tables exist", async () => {
    const db = createTestDb();
    expect(await db.select().from(oauthAccessToken)).toEqual([]);
    expect(await db.select().from(oauthRefreshToken)).toEqual([]);
    expect(await db.select().from(oauthConsent)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd workers/api && bun test test/oauth-provider.test.ts`
Expected: FAIL — `oauthClient` (and siblings) are not exported from `schema-auth.ts` / tables don't exist.

- [ ] **Step 3: Add the Drizzle tables to `schema-auth.ts`**

Append to `workers/api/src/db/schema-auth.ts` (before the `export type` block). The `text(..., { mode: "json" })` columns store `string[]`; `$type<string[]>()` gives them the right TS type. **Reconcile field/property keys against the installed schema first (see the note above).**

```ts
/**
 * Better Auth OAuth Provider plugin (`@better-auth/oauth-provider`) store. The
 * AS lives in the API worker; these tables back client registration, issued
 * tokens, and per-user consent. JWT access tokens are self-contained (no row);
 * `oauthAccessToken` holds OPAQUE tokens only. The drizzle-adapter schema KEY
 * must equal the plugin's model name (camelCase), SQL names stay snake_case —
 * same split as `rateLimit`/`deviceCode`. Reconcile columns with the installed
 * plugin schema. Paired migration: 20260607000000_add_oauth_provider.sql.
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
 */
export const jwks = sqliteTable("jwks", {
  id: text("id").primaryKey(),
  publicKey: text("public_key").notNull(),
  privateKey: text("private_key").notNull(),
  createdAt: timestampCol("created_at"),
});
```

Then add the inferred-type exports to the `export type` block at the end:

```ts
export type AuthOAuthClient = typeof oauthClient.$inferSelect;
export type AuthOAuthAccessToken = typeof oauthAccessToken.$inferSelect;
export type AuthOAuthRefreshToken = typeof oauthRefreshToken.$inferSelect;
export type AuthOAuthConsent = typeof oauthConsent.$inferSelect;
export type AuthJwks = typeof jwks.$inferSelect;
```

- [ ] **Step 4: Write the paired migration**

Create `workers/api/migrations/20260607000000_add_oauth_provider.sql`:

```sql
-- Better Auth OAuth Provider plugin (@better-auth/oauth-provider) + jwt() keyset.
-- Paired with the oauth_client/oauth_access_token/oauth_refresh_token/
-- oauth_consent/jwks tables in workers/api/src/db/schema-auth.ts (the
-- schema↔migration pairing gate in ci.yml watches that file). string[] columns
-- are JSON text; timestamps are integer epoch ms (Better Auth Drizzle shape).
CREATE TABLE oauth_client (
  id text PRIMARY KEY NOT NULL,
  client_id text NOT NULL UNIQUE,
  client_secret text,
  name text,
  icon text,
  uri text,
  redirect_uris text NOT NULL,
  post_logout_redirect_uris text,
  scopes text NOT NULL,
  grant_types text,
  response_types text,
  contacts text,
  token_endpoint_auth_method text,
  type text,
  public integer,
  require_pkce integer,
  disabled integer,
  skip_consent integer,
  enable_end_session integer,
  subject_type text,
  tos text,
  policy text,
  software_id text,
  software_version text,
  software_statement text,
  user_id text,
  reference_id text,
  metadata text,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX idx_oauth_client_client_id ON oauth_client (client_id);

CREATE TABLE oauth_access_token (
  id text PRIMARY KEY NOT NULL,
  token text NOT NULL UNIQUE,
  client_id text NOT NULL,
  session_id text REFERENCES session(id) ON DELETE SET NULL,
  refresh_id text,
  user_id text,
  reference_id text,
  scopes text NOT NULL,
  created_at integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX idx_oauth_access_token_token ON oauth_access_token (token);

CREATE TABLE oauth_refresh_token (
  id text PRIMARY KEY NOT NULL,
  token text NOT NULL UNIQUE,
  client_id text NOT NULL,
  session_id text REFERENCES session(id) ON DELETE SET NULL,
  user_id text NOT NULL,
  reference_id text,
  scopes text NOT NULL,
  revoked integer,
  auth_time integer,
  created_at integer NOT NULL,
  expires_at integer NOT NULL
);
CREATE INDEX idx_oauth_refresh_token_token ON oauth_refresh_token (token);

CREATE TABLE oauth_consent (
  id text PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  client_id text NOT NULL,
  reference_id text,
  scopes text NOT NULL,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX idx_oauth_consent_user_client ON oauth_consent (user_id, client_id);

CREATE TABLE jwks (
  id text PRIMARY KEY NOT NULL,
  public_key text NOT NULL,
  private_key text NOT NULL,
  created_at integer NOT NULL
);
```

- [ ] **Step 5: Run the schema test to verify it passes**

Run: `cd workers/api && bun test test/oauth-provider.test.ts`
Expected: PASS (3 tests). If the test DB snapshot is cached stale, the migration is picked up on a fresh process — re-run once.

- [ ] **Step 6: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/db/schema-auth.ts workers/api/migrations/20260607000000_add_oauth_provider.sql workers/api/test/oauth-provider.test.ts
git commit -m "feat(api): add OAuth provider + jwks tables and migration"
```

---

## Task 3: Wire `jwt()` + `oauthProvider()` into `createAuth`

**Files:**

- Modify: `workers/api/src/auth/index.ts`
- Modify: `workers/api/src/index.ts` (add `OAUTH_RESOURCE_AUDIENCES` to the `Bindings` interface)
- Test: `workers/api/test/oauth-provider.test.ts`

- [ ] **Step 1: Write the failing `oauthValidAudiences` unit test**

Append to `workers/api/test/oauth-provider.test.ts`:

```ts
import { oauthValidAudiences } from "../src/auth/index.js";

describe("oauthValidAudiences", () => {
  it("unions the BETTER_AUTH_URL origin with OAUTH_RESOURCE_AUDIENCES entries", () => {
    const auds = oauthValidAudiences({
      BETTER_AUTH_URL: "https://api.releases.sh",
      OAUTH_RESOURCE_AUDIENCES: "https://mcp.releases.sh, https://api.releases.sh",
    } as never);
    expect(auds).toEqual(["https://api.releases.sh", "https://mcp.releases.sh"]);
  });

  it("falls back to the api origin when nothing is configured", () => {
    expect(oauthValidAudiences({} as never)).toEqual(["https://api.releases.sh"]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd workers/api && bun test test/oauth-provider.test.ts`
Expected: FAIL — `oauthValidAudiences` is not exported.

- [ ] **Step 3: Add the `oauthValidAudiences` helper**

In `workers/api/src/auth/index.ts`, add near `authTrustedOrigins` (it is pure + exported for testing):

```ts
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
  if (auds.size === 0) auds.add("https://api.releases.sh");
  return [...auds];
}
```

- [ ] **Step 4: Add the `OAUTH_RESOURCE_AUDIENCES` binding type**

In `workers/api/src/index.ts`, inside the `Bindings` interface (near `BETTER_AUTH_URL`), add:

```ts
    // Comma-separated extra `aud` values for issued OAuth access tokens (the
    // resource servers, e.g. the MCP worker). Unioned with the BETTER_AUTH_URL
    // origin by oauthValidAudiences(). Plain config, not a feature flag.
    OAUTH_RESOURCE_AUDIENCES?: string;
```

- [ ] **Step 5: Register the plugins + tables in `createAuth`**

In `workers/api/src/auth/index.ts`:

(a) Extend the plugin import and add the oauth-provider import (use the exact export name recorded in Task 1 Step 3):

```ts
import { oneTap, magicLink, deviceAuthorization, bearer, jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
```

(b) Extend the schema-auth import to include the new tables:

```ts
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
} from "../db/schema-auth.js";
```

(c) Add the two plugins to the `plugins` array (always-on). Place them after `magicLink({...})` and before the `userApiKeysOn` block:

```ts
    // OAuth 2.0 / OIDC authorization server ("Sign in with Releases"). Issues
    // JWT access tokens (the jwt() companion below signs them + exposes JWKS)
    // and serves discovery metadata. INERT until an admin provisions a client:
    // dynamic client registration is OFF and there is no consent page yet, so
    // only an admin-created skip_consent client can complete a flow. Consent UI,
    // public registration, per-user scope entitlement, and resource-server
    // verification are later sub-projects. No feature flag — see the AS-foundation
    // spec (a kill switch guards nothing a not-yet-provisioned client wouldn't).
    jwt(),
    oauthProvider({
      loginPage: "/login", // existing web sign-in route (web/src/app/login)
      consentPage: "/oauth/consent", // page built in sub-project 3; path provisional
      scopes: ["openid", "profile", "email", "offline_access", "read", "write", "admin"],
      validAudiences: oauthValidAudiences(env),
      allowDynamicClientRegistration: false, // sub-project 4 enables this
      // Set-once before first deploy (changing later orphans live tokens). Extends
      // the existing relk_/relu_ credential family. Access tokens are JWTs (no prefix).
      prefix: { refreshToken: "relo_", clientSecret: "reloc_" },
    }),
```

(d) Register the five tables in the `drizzleAdapter({ schema })` map:

```ts
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
      },
```

- [ ] **Step 6: Write the failing plugin-presence + discovery + adapter-mapping tests**

Append to `workers/api/test/oauth-provider.test.ts`:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import { user, session, account, verification } from "../src/db/schema-auth.js";
import { createAuth } from "../src/auth/index.js";

const baseEnv = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
} as never;

const pluginIds = (auth: { options: { plugins?: Array<{ id: string }> } }) =>
  (auth.options.plugins ?? []).map((p) => p.id);

describe("oauth provider wiring", () => {
  it("registers the jwt + oauth-provider plugins", async () => {
    const auth = await createAuth(baseEnv, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    const ids = pluginIds(auth);
    expect(ids.some((id) => /jwt/i.test(id))).toBe(true);
    expect(ids.some((id) => /oauth/i.test(id))).toBe(true);
  });

  it("serves authorization-server discovery metadata advertising the API scopes", async () => {
    const auth = await createAuth(baseEnv, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    const res = await auth.handler(
      new Request("https://api.releases.localhost/api/auth/.well-known/oauth-authorization-server"),
    );
    expect(res.status).toBe(200);
    const meta = (await res.json()) as {
      token_endpoint?: string;
      authorization_endpoint?: string;
      jwks_uri?: string;
      scopes_supported?: string[];
    };
    expect(meta.token_endpoint).toContain("/oauth2/token");
    expect(meta.authorization_endpoint).toContain("/oauth2/authorize");
    expect(meta.jwks_uri).toContain("/jwks");
    expect(meta.scopes_supported).toEqual(expect.arrayContaining(["read", "write", "admin"]));
  });

  // Strongest adapter-mapping check: a real Better Auth write to oauth_client via
  // the dynamic-registration endpoint (enabled ONLY in this test instance; prod
  // keeps it OFF). Proves the plugin model name + field keys map to our columns.
  it("writes a registered client to oauth_client through the adapter", async () => {
    const db = createTestDb();
    const auth = betterAuth({
      baseURL: "https://api.releases.localhost",
      secret: "test-secret-do-not-use-in-prod-0123456789",
      database: drizzleAdapter(db, {
        provider: "sqlite",
        schema: {
          user,
          session,
          account,
          verification,
          jwks,
          oauthClient,
          oauthAccessToken,
          oauthRefreshToken,
          oauthConsent,
        },
      }),
      plugins: [
        jwt(),
        oauthProvider({
          loginPage: "/login",
          consentPage: "/oauth/consent",
          scopes: ["openid", "profile", "email", "read"],
          allowDynamicClientRegistration: true,
          allowUnauthenticatedClientRegistration: true,
        }),
      ],
    });
    const res = await auth.handler(
      new Request("https://api.releases.localhost/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test Client",
          redirect_uris: ["https://app.example.com/callback"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    expect(res.ok).toBe(true);
    const clients = await db.select().from(oauthClient);
    expect(clients).toHaveLength(1);
    expect(clients[0]?.redirectUris).toEqual(["https://app.example.com/callback"]);
  });
});
```

- [ ] **Step 7: Run the full test file**

Run: `cd workers/api && bun test test/oauth-provider.test.ts`
Expected: PASS (all tests). If the discovery path 404s, confirm the well-known path Better Auth actually serves (it may be `/api/auth/.well-known/oauth-authorization-server`); if the register call fails, re-check the model name + field keys against the installed schema (Task 2 note) and adjust the Drizzle property keys + adapter map.

- [ ] **Step 8: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS. (If a `/token` route collision surfaces from the `jwt()` plugin, add `disabledPaths` per the spec's risk note — only if an error actually appears.)

- [ ] **Step 9: Commit**

```bash
git add workers/api/src/auth/index.ts workers/api/src/index.ts workers/api/test/oauth-provider.test.ts
git commit -m "feat(api): register jwt + oauthProvider in createAuth"
```

---

## Task 4: Apex `.well-known/*` discovery alias routes

**Files:**

- Create: `workers/api/src/oauth-discovery.ts`
- Modify: `workers/api/src/index.ts`
- Test: `workers/api/test/oauth-provider.test.ts`

OAuth clients fetch discovery at the apex (`/.well-known/...`), but Better Auth serves it under `/api/auth/...`. The forwarding logic lives in a small, dependency-light module so it's unit-testable with a stub `auth` (no D1 in the test). The two apex routes are mounted in `index.ts` **before** the auth/session middleware so they stay unauthenticated.

- [ ] **Step 1: Write the failing forward-helper test**

Append to `workers/api/test/oauth-provider.test.ts`:

```ts
import { forwardWellKnown } from "../src/oauth-discovery.js";

describe("forwardWellKnown discovery alias", () => {
  it("rewrites apex → /api/auth/.well-known path and stamps wildcard CORS", async () => {
    let seenPath: string | undefined;
    const fakeAuth = {
      handler: async (req: Request) => {
        seenPath = new URL(req.url).pathname;
        return new Response(JSON.stringify({ token_endpoint: "https://x/oauth2/token" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    };
    const res = await forwardWellKnown(
      fakeAuth,
      "oauth-authorization-server",
      "https://api.releases.localhost/.well-known/oauth-authorization-server",
      new Headers(),
    );
    expect(seenPath).toBe("/api/auth/.well-known/oauth-authorization-server");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const meta = (await res.json()) as { token_endpoint?: string };
    expect(meta.token_endpoint).toContain("/oauth2/token");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd workers/api && bun test test/oauth-provider.test.ts`
Expected: FAIL — `forwardWellKnown` / `../src/oauth-discovery.js` does not exist.

- [ ] **Step 3: Create the forward helper**

Create `workers/api/src/oauth-discovery.ts`:

```ts
/** Minimal shape this helper needs from a Better Auth instance. */
interface AuthHandler {
  handler: (req: Request) => Promise<Response>;
}

/**
 * Forward an apex OAuth/OIDC discovery request to the Better Auth handler, which
 * serves the metadata under `/api/auth/.well-known/...`. OAuth clients (Claude,
 * ChatGPT, MCP Inspector, …) fetch the ORIGIN path; this rewrites to the Better
 * Auth path and stamps wildcard GET CORS (cross-origin fetch, no credentials).
 */
export async function forwardWellKnown(
  auth: AuthHandler,
  wellKnown: "oauth-authorization-server" | "openid-configuration",
  reqUrl: string,
  headers: Headers,
): Promise<Response> {
  const url = new URL(reqUrl);
  url.pathname = `/api/auth/.well-known/${wellKnown}`;
  const upstream = await auth.handler(new Request(url, { headers }));
  const res = new Response(upstream.body, upstream);
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET");
  return res;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd workers/api && bun test test/oauth-provider.test.ts`
Expected: PASS.

- [ ] **Step 5: Mount the apex routes in `index.ts`**

In `workers/api/src/index.ts`, import the helper near the other auth imports:

```ts
import { forwardWellKnown } from "./oauth-discovery.js";
```

Then, **before** the first auth/session middleware registration (above the `app.use("/api/auth/*", ...)` block), add:

```ts
// Apex OAuth/OIDC discovery aliases — registered before any auth gate so
// discovery stays public. Protected-resource metadata is NOT here; that belongs
// to the resource servers (later sub-project). See oauth-discovery.ts.
for (const wellKnown of ["oauth-authorization-server", "openid-configuration"] as const) {
  app.get(`/.well-known/${wellKnown}`, async (c) =>
    forwardWellKnown(await createAuth(c.env), wellKnown, c.req.url, c.req.raw.headers),
  );
}
```

- [ ] **Step 6: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/oauth-discovery.ts workers/api/src/index.ts workers/api/test/oauth-provider.test.ts
git commit -m "feat(api): apex .well-known OAuth discovery aliases"
```

---

## Task 5: Config plumbing, full verification, and staging smoke

**Files:**

- Modify: `workers/api/wrangler.jsonc`
- Modify: `docs/superpowers/specs/2026-06-07-oauth-provider-foundation-design.md` (status)

- [ ] **Step 1: Add the `OAUTH_RESOURCE_AUDIENCES` var (prod + staging)**

In `workers/api/wrangler.jsonc`, add to the top-level `vars` block:

```jsonc
"OAUTH_RESOURCE_AUDIENCES": "https://mcp.releases.sh"
```

And in the `[env.staging]` `vars` block (the staging MCP host):

```jsonc
"OAUTH_RESOURCE_AUDIENCES": "https://mcp-staging.releases.sh"
```

(No `.env` / `.dev.vars` edits — local dev falls back to the api origin via `oauthValidAudiences`. The user applies any deployed-env secret/var changes themselves; none are required here beyond this non-secret var.)

- [ ] **Step 2: Full type-check (root + worker)**

Run: `npx tsc --noEmit && cd workers/api && npx tsc --noEmit`
Expected: PASS both.

- [ ] **Step 3: Full test suite**

Run (repo root): `bun test`
Expected: PASS, including the new `workers/api/test/oauth-provider.test.ts` and the existing `workers/api/test/auth.test.ts` (regression check — wiring did not break the existing auth instance).

- [ ] **Step 4: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: PASS. (Run `bun run format` if `format:check` flags the new files.)

- [ ] **Step 5: Update the spec status**

In `docs/superpowers/specs/2026-06-07-oauth-provider-foundation-design.md`, change the status line to:

```markdown
- **Status:** Implemented (AS foundation); pending staging smoke
```

- [ ] **Step 6: Commit**

```bash
git add workers/api/wrangler.jsonc docs/superpowers/specs/2026-06-07-oauth-provider-foundation-design.md
git commit -m "chore(api): OAUTH_RESOURCE_AUDIENCES var + mark AS foundation implemented"
```

- [ ] **Step 7: Staging smoke (manual, after deploy to staging)**

> Deploys are automatic on merge to main; for a pre-merge check, deploy the branch to staging per AGENTS.md:
> `bunx wrangler deploy --env staging --config workers/api/wrangler.jsonc`

Then verify. The staging access gate (`stagingAccessGate()`) runs on `*`, so it shadows the apex `.well-known` aliases on `api-staging` — discovery requires the `X-Releases-Staging-Key` header there (in prod the gate no-ops and discovery is public). Set `STAGING_ACCESS_KEY` to the staging access key first:

```bash
curl -s -H "X-Releases-Staging-Key: $STAGING_ACCESS_KEY" https://api-staging.releases.sh/.well-known/oauth-authorization-server | jq '{token_endpoint, authorization_endpoint, jwks_uri, scopes_supported}'
```

Expected: JSON with `/oauth2/token`, `/oauth2/authorize`, a `/jwks` URI, and `scopes_supported` including `read`/`write`/`admin`.

Optional full-flow proof (records the inert→provisioned transition): admin-create a `skip_consent` client (server-side `auth.api.adminCreateOAuthClient` or a one-off script), run an `authorization_code` + PKCE exchange, and verify the issued JWT against `https://api-staging.releases.sh/api/auth/jwks` (check `iss`, `aud`, scopes). Capture the result in the PR description.

---

## Notes for the executor

- **Reconcile model/field names from the installed package** (Task 2 note) before trusting the draft Drizzle columns — the adapter resolves models by the camelCase **key** matching Better Auth's model name, and fields by property key. The `oauth2/register` adapter-mapping test (Task 3) is the gate that proves alignment.
- **No feature flag** is intentional (spec decision): the AS is inert until an admin provisions a client. Do not add a Flagship flag.
- **Do not** edit `.env` / `.dev.vars`; do not touch `workers/mcp` (its resource-server role is a later sub-project, kept free of `better-auth` to avoid a zod split).
- **Scope discipline:** if a step tempts you toward consent UI, public registration, scope-entitlement filtering, or resource-server verification — stop; those are sub-projects 2–5.
