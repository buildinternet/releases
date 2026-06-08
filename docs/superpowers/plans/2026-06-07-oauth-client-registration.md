# OAuth client registration + trusted clients Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a root-key-gated admin surface to provision/manage OAuth clients (incl. trusted `skip_consent` first-party clients) for the "Sign in with Releases" AS, and lock the plugin's user self-service client endpoints to admins — without enabling RFC 7591 dynamic registration.

**Architecture:** All `oauth_client` access goes through the Better Auth **context adapter** (`(await auth.$context).adapter`) — the same adapter the plugin reads through — so JSON-field encoding stays consistent and there is no session gate to satisfy (the plugin's `/admin/oauth2/create-client` endpoint throws `UNAUTHORIZED` without a user session, which our root-key route does not have). Secret generation/hashing replicates the plugin's exact primitives (`generateRandomString` + `base64Url(SHA-256(secret))`), so stored secrets verify against the plugin's own `verifyStoredClientSecret`. A thin Hono route (mirroring `admin-users.ts`) wraps a pure service module; a Hono pre-filter on the four write self-service paths 403s non-admins.

**Tech Stack:** TypeScript (strict), Cloudflare Worker + Hono, Better Auth (`@better-auth/oauth-provider@1.6.14`), Drizzle/D1, `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-07-oauth-client-registration-design.md`

---

## Background the implementer needs

- **Worktree first.** This plan runs in the worktree `worktree-oauth-client-registration`. A linked worktree has **no `node_modules`** — run `bun install` once before anything else (`reference_worktree_needs_bun_install`).
- **Run tests with bun** from the repo root: `bun test workers/api/test/<file>`.
- **The Better Auth context adapter API** (used by the plugin internally; we use the same surface):
  - `adapter.create({ model: "oauthClient", data })` → returns the created row (omit `id`; the adapter generates it).
  - `adapter.findOne({ model: "oauthClient", where: [{ field, value }] })` → row | null.
  - `adapter.findMany({ model: "oauthClient" })` → row[].
  - `adapter.update({ model: "oauthClient", where: [{ field, value }], update })`.
  - `adapter.delete({ model: "oauthClient", where: [{ field, value }] })`.
    Rows come back with **camelCase** field names (`clientId`, `clientSecret`, `redirectUris` as a real array, `skipConsent`, `disabled`, `public`, `type`, `tokenEndpointAuthMethod`, `createdAt`, `updatedAt`).
- **Secret format (verified against the plugin):** stored secret = `base64Url(SHA-256(rawSecret), { padding:false })`, **unprefixed**. The value returned to the operator is `"reloc_" + rawSecret`. Public clients (`token_endpoint_auth_method: "none"`) have **no** secret.
- **`c.get("auth")` is already taken** (it holds the API-token `AuthContext` set by `authMiddleware`). We add a new `betterAuth` context var as the test seam for the Better Auth instance — same convention as the existing `c.get("db")` injection.
- **Secret hashing imports the plugin's own utils** (`@better-auth/utils/hash` + `@better-auth/utils/base64`) — already in the dependency tree via `better-auth`/`@better-auth/oauth-provider`. This guarantees **byte-parity** with the plugin's `verifyStoredClientSecret`. Do NOT hand-roll base64url. If `@better-auth/utils/*` fails to resolve under `workers/api/tsconfig.json`, add `@better-auth/utils` to `workers/api/package.json` devDependencies and re-run `bun install` — still do not hand-roll.

## File structure

- **Create** `workers/api/src/auth/oauth-clients.ts` — pure service: secret helpers + create/list/get/disable/rotate/delete over an injected adapter. The `OAuthClientAdapter` structural interface + `PublicOAuthClient` projection live here.
- **Create** `workers/api/src/routes/admin-oauth.ts` — thin Hono route module (`adminOauthRoutes`) resolving the adapter and delegating to the service, with `admin-users.ts`-style validation + audited `logEvent`s.
- **Create** `workers/api/src/auth/oauth-self-service-guard.ts` — `oauthSelfServiceGuard()` Hono middleware: 403 unless the session user's role is `admin`.
- **Modify** `workers/api/src/auth/index.ts` — export `type BetterAuthInstance = Awaited<ReturnType<typeof createAuth>>`.
- **Modify** `workers/api/src/index.ts` — add `betterAuth?` to `Env.Variables`; register the guard on the four write paths before the `/api/auth/*` handler.
- **Modify** `workers/api/src/route-namespaces.ts` — add `"admin/oauth"` to `adminRoutes`.
- **Modify** `workers/api/src/v1-routes.ts` — import + mount `adminOauthRoutes`.
- **Create** `workers/api/test/oauth-clients.test.ts`, `workers/api/test/admin-oauth-route.test.ts`, `workers/api/test/oauth-self-service-guard.test.ts`.
- **Modify** `docs/architecture/remote-mode.md` + `AGENTS.md` — record the sanctioned admin/oauth exception.

---

## Task 1: Secret helpers + `createOAuthClient`

**Files:**

- Create: `workers/api/src/auth/oauth-clients.ts`
- Test: `workers/api/test/oauth-clients.test.ts`

- [ ] **Step 0: Install deps in the worktree (once)**

Run: `bun install`
Expected: completes; `node_modules` present.

- [ ] **Step 1: Write the failing test (hashing + create)**

Create `workers/api/test/oauth-clients.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { createTestDb } from "./setup";
import { createAuth } from "../src/auth/index.js";
import {
  CLIENT_SECRET_PREFIX,
  hashClientSecret,
  generateClientSecret,
  createOAuthClient,
  type OAuthClientAdapter,
} from "../src/auth/oauth-clients.js";

const baseEnv = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
} as never;

async function makeAdapter(): Promise<OAuthClientAdapter> {
  const auth = await createAuth(baseEnv, undefined, { db: createTestDb(), sendEmail: () => {} });
  return (await auth.$context).adapter as unknown as OAuthClientAdapter;
}

describe("oauth-clients secret helpers", () => {
  it("generateClientSecret yields a 32-char alnum string", () => {
    const s = generateClientSecret();
    expect(s).toMatch(/^[a-zA-Z]{32}$/);
  });

  it("hashClientSecret is base64url SHA-256, unprefixed and deterministic", async () => {
    const h1 = await hashClientSecret("hunter2");
    const h2 = await hashClientSecret("hunter2");
    expect(h1).toBe(h2);
    expect(h1).not.toContain("hunter2");
    expect(h1).not.toMatch(/[+/=]/); // base64url, no padding
  });
});

describe("createOAuthClient", () => {
  it("creates a confidential client: prefixed secret returned, hash stored, projection omits secret", async () => {
    const adapter = await makeAdapter();
    const { client, secret } = await createOAuthClient(adapter, {
      name: "Test App",
      redirectUris: ["https://app.example.com/cb"],
      scopes: ["read"],
    });
    expect(secret).toMatch(new RegExp(`^${CLIENT_SECRET_PREFIX}`));
    expect(client.public).toBe(false);
    expect(client.trusted).toBe(false);
    expect(client.redirectUris).toEqual(["https://app.example.com/cb"]);
    expect(client.scopes).toEqual(["read"]);
    expect(client).not.toHaveProperty("clientSecret");

    const raw = secret!.slice(CLIENT_SECRET_PREFIX.length);
    const row = await adapter.findOne({
      model: "oauthClient",
      where: [{ field: "clientId", value: client.clientId }],
    });
    expect(row?.clientSecret).toBe(await hashClientSecret(raw));
    expect(row?.clientSecret).not.toContain(raw);
  });

  it("creates a public client (token_endpoint_auth_method=none): no secret", async () => {
    const adapter = await makeAdapter();
    const { client, secret } = await createOAuthClient(adapter, {
      name: "MCP Client",
      redirectUris: ["https://host.example.com/cb"],
      scopes: ["read"],
      tokenEndpointAuthMethod: "none",
    });
    expect(secret).toBeUndefined();
    expect(client.public).toBe(true);
    expect(client.tokenEndpointAuthMethod).toBe("none");
  });

  it("creates a trusted client when trusted=true (skip_consent)", async () => {
    const adapter = await makeAdapter();
    const { client } = await createOAuthClient(adapter, {
      redirectUris: ["https://app.example.com/cb"],
      scopes: ["read", "write"],
      trusted: true,
    });
    expect(client.trusted).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test workers/api/test/oauth-clients.test.ts`
Expected: FAIL — `Cannot find module ".../auth/oauth-clients.js"`.

- [ ] **Step 3: Implement `oauth-clients.ts` (helpers + create + projection)**

Create `workers/api/src/auth/oauth-clients.ts`:

```ts
/**
 * Service layer for admin OAuth client management (#1482). Operates on the
 * Better Auth *context adapter* — the same adapter the oauth-provider plugin
 * reads through — so JSON-field encoding stays symmetric and there is no
 * session gate (the plugin's /admin/oauth2/create-client endpoint requires a
 * user session, which our root-key route does not have). Secret generation +
 * hashing replicate the plugin's own primitives so stored secrets verify
 * against its `verifyStoredClientSecret`.
 */
import { generateRandomString } from "better-auth/crypto";
import { createHash } from "@better-auth/utils/hash";
import { base64Url } from "@better-auth/utils/base64";

/** Extends the relk_/relu_/relo_ credential family; the operator-facing secret prefix. */
export const CLIENT_SECRET_PREFIX = "reloc_";

const OAUTH_CLIENT_MODEL = "oauthClient";

/** Minimal structural view of the Better Auth DB adapter we depend on. */
export interface AdapterWhere {
  field: string;
  value: unknown;
  operator?: string;
}
export interface OAuthClientAdapter {
  create(args: { model: string; data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  findOne(args: { model: string; where: AdapterWhere[] }): Promise<Record<string, unknown> | null>;
  findMany(args: { model: string; where?: AdapterWhere[] }): Promise<Record<string, unknown>[]>;
  update(args: {
    model: string;
    where: AdapterWhere[];
    update: Record<string, unknown>;
  }): Promise<unknown>;
  delete(args: { model: string; where: AdapterWhere[] }): Promise<unknown>;
}

export interface CreateClientInput {
  name?: string;
  redirectUris: string[];
  scopes: string[];
  /** Maps to skip_consent — only the admin path can set this. */
  trusted?: boolean;
  type?: "web" | "native" | "user-agent-based";
  tokenEndpointAuthMethod?: "none" | "client_secret_basic" | "client_secret_post";
  grantTypes?: string[];
  requirePKCE?: boolean;
  clientUri?: string;
  logoUri?: string;
}

/** Public, secret-free view returned by every read path. */
export interface PublicOAuthClient {
  clientId: string;
  name: string | null;
  redirectUris: string[];
  scopes: string[];
  trusted: boolean;
  disabled: boolean;
  public: boolean;
  type: string | null;
  tokenEndpointAuthMethod: string | null;
  createdAt: unknown;
  updatedAt: unknown;
}

export function generateClientSecret(): string {
  return generateRandomString(32, "a-z", "A-Z");
}

/** base64url(SHA-256(secret)), no padding — verbatim match for the plugin's defaultHasher. */
export async function hashClientSecret(secret: string): Promise<string> {
  const digest = await createHash("SHA-256").digest(new TextEncoder().encode(secret));
  return base64Url.encode(new Uint8Array(digest), { padding: false });
}

/** Project a raw adapter row to the secret-free public shape. */
export function toPublicClient(row: Record<string, unknown>): PublicOAuthClient {
  return {
    clientId: row.clientId as string,
    name: (row.name as string | null) ?? null,
    redirectUris: (row.redirectUris as string[]) ?? [],
    scopes: (row.scopes as string[]) ?? [],
    trusted: Boolean(row.skipConsent),
    disabled: Boolean(row.disabled),
    public: Boolean(row.public),
    type: (row.type as string | null) ?? null,
    tokenEndpointAuthMethod: (row.tokenEndpointAuthMethod as string | null) ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function createOAuthClient(
  adapter: OAuthClientAdapter,
  input: CreateClientInput,
): Promise<{ client: PublicOAuthClient; secret?: string }> {
  const isPublic = input.tokenEndpointAuthMethod === "none";
  const rawSecret = isPublic ? undefined : generateClientSecret();
  const now = new Date();
  const data: Record<string, unknown> = {
    clientId: generateRandomString(32, "a-z", "A-Z"),
    clientSecret: rawSecret ? await hashClientSecret(rawSecret) : undefined,
    name: input.name ?? null,
    redirectUris: input.redirectUris,
    scopes: input.scopes,
    grantTypes: input.grantTypes ?? ["authorization_code"],
    responseTypes: ["code"],
    tokenEndpointAuthMethod: isPublic
      ? "none"
      : (input.tokenEndpointAuthMethod ?? "client_secret_basic"),
    type: input.type ?? (isPublic ? "native" : "web"),
    public: isPublic,
    requirePKCE: input.requirePKCE ?? true,
    disabled: false,
    skipConsent: input.trusted ?? false,
    uri: input.clientUri ?? null,
    icon: input.logoUri ?? null,
    createdAt: now,
    updatedAt: now,
  };
  const created = await adapter.create({ model: OAUTH_CLIENT_MODEL, data });
  return {
    client: toPublicClient(created),
    secret: rawSecret ? CLIENT_SECRET_PREFIX + rawSecret : undefined,
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test workers/api/test/oauth-clients.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/auth/oauth-clients.ts workers/api/test/oauth-clients.test.ts
git commit -m "feat(oauth): client service — secret helpers + createOAuthClient (#1482)"
```

---

## Task 2: list / get / disable / rotate / delete

**Files:**

- Modify: `workers/api/src/auth/oauth-clients.ts`
- Test: `workers/api/test/oauth-clients.test.ts`

- [ ] **Step 1: Add the failing tests**

Append to `workers/api/test/oauth-clients.test.ts`:

```ts
import {
  listOAuthClients,
  getOAuthClient,
  setClientDisabled,
  setClientTrusted,
  rotateClientSecret,
  deleteOAuthClient,
} from "../src/auth/oauth-clients.js";

async function seed(adapter: OAuthClientAdapter, over: Partial<CreateClientInput> = {}) {
  return createOAuthClient(adapter, {
    redirectUris: ["https://app.example.com/cb"],
    scopes: ["read"],
    ...over,
  });
}

describe("oauth-clients read + mutate", () => {
  it("list and get omit the secret", async () => {
    const adapter = await makeAdapter();
    const { client } = await seed(adapter);
    const list = await listOAuthClients(adapter);
    expect(list).toHaveLength(1);
    expect(list[0]).not.toHaveProperty("clientSecret");
    const got = await getOAuthClient(adapter, client.clientId);
    expect(got?.clientId).toBe(client.clientId);
    expect(got).not.toHaveProperty("clientSecret");
    expect(await getOAuthClient(adapter, "missing")).toBeNull();
  });

  it("setClientDisabled flips the column and reports not-found", async () => {
    const adapter = await makeAdapter();
    const { client } = await seed(adapter);
    expect(await setClientDisabled(adapter, client.clientId, true)).toBe(true);
    const row = await adapter.findOne({
      model: "oauthClient",
      where: [{ field: "clientId", value: client.clientId }],
    });
    expect(Boolean(row?.disabled)).toBe(true);
    expect(await setClientDisabled(adapter, "missing", true)).toBe(false);
  });

  it("setClientTrusted toggles skip_consent", async () => {
    const adapter = await makeAdapter();
    const { client } = await seed(adapter);
    expect(await setClientTrusted(adapter, client.clientId, true)).toBe(true);
    const got = await getOAuthClient(adapter, client.clientId);
    expect(got?.trusted).toBe(true);
  });

  it("rotateClientSecret changes the stored hash; new secret verifies", async () => {
    const adapter = await makeAdapter();
    const { client, secret } = await seed(adapter);
    const before = (
      await adapter.findOne({
        model: "oauthClient",
        where: [{ field: "clientId", value: client.clientId }],
      })
    )?.clientSecret;
    const res = await rotateClientSecret(adapter, client.clientId);
    expect(res.status).toBe("ok");
    if (res.status !== "ok") throw new Error("unreachable");
    expect(res.secret).toMatch(new RegExp(`^${CLIENT_SECRET_PREFIX}`));
    expect(res.secret).not.toBe(secret);
    const after = (
      await adapter.findOne({
        model: "oauthClient",
        where: [{ field: "clientId", value: client.clientId }],
      })
    )?.clientSecret;
    expect(after).not.toBe(before);
    expect(after).toBe(await hashClientSecret(res.secret.slice(CLIENT_SECRET_PREFIX.length)));
  });

  it("rotateClientSecret refuses a public client and reports not-found", async () => {
    const adapter = await makeAdapter();
    const { client } = await seed(adapter, { tokenEndpointAuthMethod: "none" });
    expect((await rotateClientSecret(adapter, client.clientId)).status).toBe("public_no_secret");
    expect((await rotateClientSecret(adapter, "missing")).status).toBe("not_found");
  });

  it("deleteOAuthClient removes the row", async () => {
    const adapter = await makeAdapter();
    const { client } = await seed(adapter);
    expect(await deleteOAuthClient(adapter, client.clientId)).toBe(true);
    expect(await getOAuthClient(adapter, client.clientId)).toBeNull();
    expect(await deleteOAuthClient(adapter, client.clientId)).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests, verify they fail**

Run: `bun test workers/api/test/oauth-clients.test.ts`
Expected: FAIL — `listOAuthClients`/etc. are not exported.

- [ ] **Step 3: Implement the read + mutate functions**

Append to `workers/api/src/auth/oauth-clients.ts`:

```ts
const byClientId = (clientId: string): AdapterWhere[] => [{ field: "clientId", value: clientId }];

export async function listOAuthClients(adapter: OAuthClientAdapter): Promise<PublicOAuthClient[]> {
  const rows = await adapter.findMany({ model: OAUTH_CLIENT_MODEL });
  return rows.map(toPublicClient);
}

export async function getOAuthClient(
  adapter: OAuthClientAdapter,
  clientId: string,
): Promise<PublicOAuthClient | null> {
  const row = await adapter.findOne({ model: OAUTH_CLIENT_MODEL, where: byClientId(clientId) });
  return row ? toPublicClient(row) : null;
}

/** Returns false when the client does not exist. */
export async function setClientDisabled(
  adapter: OAuthClientAdapter,
  clientId: string,
  disabled: boolean,
): Promise<boolean> {
  const row = await adapter.findOne({ model: OAUTH_CLIENT_MODEL, where: byClientId(clientId) });
  if (!row) return false;
  await adapter.update({
    model: OAUTH_CLIENT_MODEL,
    where: byClientId(clientId),
    update: { disabled, updatedAt: new Date() },
  });
  return true;
}

/** Returns false when the client does not exist. */
export async function setClientTrusted(
  adapter: OAuthClientAdapter,
  clientId: string,
  trusted: boolean,
): Promise<boolean> {
  const row = await adapter.findOne({ model: OAUTH_CLIENT_MODEL, where: byClientId(clientId) });
  if (!row) return false;
  await adapter.update({
    model: OAUTH_CLIENT_MODEL,
    where: byClientId(clientId),
    update: { skipConsent: trusted, updatedAt: new Date() },
  });
  return true;
}

export type RotateResult =
  | { status: "ok"; secret: string }
  | { status: "not_found" }
  | { status: "public_no_secret" };

export async function rotateClientSecret(
  adapter: OAuthClientAdapter,
  clientId: string,
): Promise<RotateResult> {
  const row = await adapter.findOne({ model: OAUTH_CLIENT_MODEL, where: byClientId(clientId) });
  if (!row) return { status: "not_found" };
  if (row.public) return { status: "public_no_secret" };
  const rawSecret = generateClientSecret();
  await adapter.update({
    model: OAUTH_CLIENT_MODEL,
    where: byClientId(clientId),
    update: { clientSecret: await hashClientSecret(rawSecret), updatedAt: new Date() },
  });
  return { status: "ok", secret: CLIENT_SECRET_PREFIX + rawSecret };
}

/** Returns false when the client does not exist. */
export async function deleteOAuthClient(
  adapter: OAuthClientAdapter,
  clientId: string,
): Promise<boolean> {
  const row = await adapter.findOne({ model: OAUTH_CLIENT_MODEL, where: byClientId(clientId) });
  if (!row) return false;
  await adapter.delete({ model: OAUTH_CLIENT_MODEL, where: byClientId(clientId) });
  return true;
}
```

- [ ] **Step 4: Run the tests, verify they pass**

Run: `bun test workers/api/test/oauth-clients.test.ts`
Expected: PASS (all tests, ~11).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/auth/oauth-clients.ts workers/api/test/oauth-clients.test.ts
git commit -m "feat(oauth): client service — list/get/disable/trusted/rotate/delete (#1482)"
```

---

## Task 3: Admin REST route + wiring

**Files:**

- Modify: `workers/api/src/auth/index.ts` (export `BetterAuthInstance`)
- Modify: `workers/api/src/index.ts:329-332` (add `betterAuth?` to `Variables`)
- Create: `workers/api/src/routes/admin-oauth.ts`
- Modify: `workers/api/src/route-namespaces.ts:57` (add `"admin/oauth"`)
- Modify: `workers/api/src/v1-routes.ts` (import + mount)
- Test: `workers/api/test/admin-oauth-route.test.ts`

- [ ] **Step 1: Export the Better Auth instance type**

In `workers/api/src/auth/index.ts`, immediately after the `export async function createAuth(...)` signature block closes is not possible (it's one function); instead add this export right above the `createAuth` declaration (around line 480):

```ts
/** The resolved Better Auth instance type (used as a Hono context test seam). */
export type BetterAuthInstance = Awaited<ReturnType<typeof createAuth>>;
```

(If TypeScript complains that `createAuth` is used before declaration in a type position, move the export to the very end of the file instead — type-only forward refs are fine, but placement after the declaration is safest.)

- [ ] **Step 2: Add the `betterAuth` context var**

In `workers/api/src/index.ts`, add the type import near the other auth imports (line ~10):

```ts
import { createAuth, authCorsMiddleware, type BetterAuthInstance } from "./auth/index.js";
```

Then extend `Env.Variables` (lines 329-332) to:

```ts
  Variables: {
    auth?: AuthContext;
    session?: AuthSessionContext;
    /** Test seam: an injected Better Auth instance; real requests build one per call. */
    betterAuth?: BetterAuthInstance;
  };
```

- [ ] **Step 3: Write the failing route test**

Create `workers/api/test/admin-oauth-route.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { createTestDb } from "./setup";
import { createAuth } from "../src/auth/index.js";
import { adminOauthRoutes } from "../src/routes/admin-oauth.js";

const baseEnv = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
} as never;

async function makeApp() {
  const auth = await createAuth(baseEnv, undefined, { db: createTestDb(), sendEmail: () => {} });
  // Blank Hono + `(c as any).set` is the repo's known-good route-test pattern
  // (see tests/api/admin-search-queries.test.ts) — avoids strict-Variables
  // friction while still mounting the Hono<Env> route module.
  const app = new Hono();
  app.use("/admin/oauth/*", (c, next) => {
    (c as any).set("betterAuth", auth);
    return next();
  });
  app.route("/", adminOauthRoutes);
  return app;
}

const json = (body: unknown) => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

describe("admin oauth client routes", () => {
  it("POST creates a client and returns the secret once", async () => {
    const app = await makeApp();
    const res = await app.request(
      "/admin/oauth/clients",
      json({ name: "App", redirectUris: ["https://app.example.com/cb"], scopes: ["read"] }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { clientId: string; clientSecret: string; trusted: boolean };
    expect(body.clientId).toBeTruthy();
    expect(body.clientSecret).toMatch(/^reloc_/);
    expect(body.trusted).toBe(false);
  });

  it("POST --trusted creates a skip_consent client", async () => {
    const app = await makeApp();
    const res = await app.request(
      "/admin/oauth/clients",
      json({ redirectUris: ["https://a/cb"], scopes: ["read", "write"], trusted: true }),
    );
    const body = (await res.json()) as { trusted: boolean };
    expect(body.trusted).toBe(true);
  });

  it("POST rejects a missing redirectUris with 400", async () => {
    const app = await makeApp();
    const res = await app.request("/admin/oauth/clients", json({ scopes: ["read"] }));
    expect(res.status).toBe(400);
  });

  it("GET list never includes the secret", async () => {
    const app = await makeApp();
    await app.request(
      "/admin/oauth/clients",
      json({ redirectUris: ["https://a/cb"], scopes: ["read"] }),
    );
    const res = await app.request("/admin/oauth/clients");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clients: Array<Record<string, unknown>> };
    expect(body.clients.length).toBeGreaterThan(0);
    expect(body.clients[0]).not.toHaveProperty("clientSecret");
  });

  it("PATCH disables, rotate returns a new secret, DELETE removes", async () => {
    const app = await makeApp();
    const created = (await (
      await app.request(
        "/admin/oauth/clients",
        json({ redirectUris: ["https://a/cb"], scopes: ["read"] }),
      )
    ).json()) as { clientId: string; clientSecret: string };
    const id = created.clientId;

    const patch = await app.request(`/admin/oauth/clients/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ disabled: true }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { disabled: boolean }).disabled).toBe(true);

    const rot = await app.request(`/admin/oauth/clients/${id}/rotate-secret`, { method: "POST" });
    expect(rot.status).toBe(200);
    const rotBody = (await rot.json()) as { clientSecret: string };
    expect(rotBody.clientSecret).toMatch(/^reloc_/);
    expect(rotBody.clientSecret).not.toBe(created.clientSecret);

    const del = await app.request(`/admin/oauth/clients/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    const get = await app.request(`/admin/oauth/clients/${id}`);
    expect(get.status).toBe(404);
  });

  it("rotate on a missing client is 404", async () => {
    const app = await makeApp();
    const res = await app.request("/admin/oauth/clients/missing/rotate-secret", { method: "POST" });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 4: Run the test, verify it fails**

Run: `bun test workers/api/test/admin-oauth-route.test.ts`
Expected: FAIL — `Cannot find module ".../routes/admin-oauth.js"`.

- [ ] **Step 5: Implement the route module**

Create `workers/api/src/routes/admin-oauth.ts`:

```ts
/**
 * Admin-only OAuth client provisioning (#1482). Root-key gated via the
 * `admin/oauth` entry in route-namespaces.ts (authMiddleware). Mirrors
 * admin-users.ts: fail-closed input parsing + audited logEvents. All
 * oauth_client access goes through the Better Auth context adapter so JSON
 * encoding matches the plugin's read path; secret hashing lives in the
 * service layer. This is a sanctioned exception to the "no new /v1/admin/*
 * CRUD" rule (see docs/architecture/remote-mode.md).
 */
import { Hono } from "hono";
import type { Context } from "hono";
import { logEvent } from "@releases/lib/log-event";
import { createAuth } from "../auth/index.js";
import { execWaitUntil } from "../middleware/auth.js";
import {
  createOAuthClient,
  listOAuthClients,
  getOAuthClient,
  setClientDisabled,
  setClientTrusted,
  rotateClientSecret,
  deleteOAuthClient,
  type CreateClientInput,
  type OAuthClientAdapter,
} from "../auth/oauth-clients.js";
import type { Env } from "../index.js";

export const adminOauthRoutes = new Hono<Env>();

async function getAdapter(c: Context<Env>): Promise<OAuthClientAdapter> {
  const auth = c.get("betterAuth") ?? (await createAuth(c.env, execWaitUntil(c)));
  return (await auth.$context).adapter as unknown as OAuthClientAdapter;
}

function asStringArray(v: unknown): string[] | null {
  if (!Array.isArray(v) || v.length === 0) return null;
  if (!v.every((x) => typeof x === "string" && x.length > 0)) return null;
  return v as string[];
}

adminOauthRoutes.post("/admin/oauth/clients", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof raw !== "object" || raw === null) return c.json({ error: "invalid_json" }, 400);
  const b = raw as Record<string, unknown>;

  const redirectUris = asStringArray(b.redirectUris);
  if (!redirectUris) return c.json({ error: "redirectUris must be a non-empty string array" }, 400);
  const scopes = asStringArray(b.scopes);
  if (!scopes) return c.json({ error: "scopes must be a non-empty string array" }, 400);

  const tokenEndpointAuthMethod =
    b.tokenEndpointAuthMethod === "none" ||
    b.tokenEndpointAuthMethod === "client_secret_basic" ||
    b.tokenEndpointAuthMethod === "client_secret_post"
      ? b.tokenEndpointAuthMethod
      : undefined;
  const type =
    b.type === "web" || b.type === "native" || b.type === "user-agent-based" ? b.type : undefined;

  const input: CreateClientInput = {
    name: typeof b.name === "string" ? b.name : undefined,
    redirectUris,
    scopes,
    trusted: b.trusted === true,
    tokenEndpointAuthMethod,
    type,
    grantTypes: asStringArray(b.grantTypes) ?? undefined,
    requirePKCE: typeof b.requirePKCE === "boolean" ? b.requirePKCE : undefined,
    clientUri: typeof b.clientUri === "string" ? b.clientUri : undefined,
    logoUri: typeof b.logoUri === "string" ? b.logoUri : undefined,
  };

  const adapter = await getAdapter(c);
  const { client, secret } = await createOAuthClient(adapter, input);

  logEvent("info", {
    component: "auth",
    event: "oauth-client-created",
    clientId: client.clientId,
    trusted: client.trusted,
    public: client.public,
    actor: "root-key",
  });

  return c.json({ ...client, clientSecret: secret ?? null }, 201);
});

adminOauthRoutes.get("/admin/oauth/clients", async (c) => {
  const adapter = await getAdapter(c);
  return c.json({ clients: await listOAuthClients(adapter) });
});

adminOauthRoutes.get("/admin/oauth/clients/:clientId", async (c) => {
  const adapter = await getAdapter(c);
  const client = await getOAuthClient(adapter, c.req.param("clientId"));
  if (!client) return c.json({ error: "client_not_found" }, 404);
  return c.json(client);
});

adminOauthRoutes.patch("/admin/oauth/clients/:clientId", async (c) => {
  const clientId = c.req.param("clientId");
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }
  if (typeof raw !== "object" || raw === null) return c.json({ error: "invalid_json" }, 400);
  const b = raw as Record<string, unknown>;
  if (typeof b.disabled !== "boolean" && typeof b.trusted !== "boolean") {
    return c.json({ error: "nothing to update: provide disabled and/or trusted (boolean)" }, 400);
  }

  const adapter = await getAdapter(c);
  let found = true;
  if (typeof b.disabled === "boolean")
    found = await setClientDisabled(adapter, clientId, b.disabled);
  if (found && typeof b.trusted === "boolean")
    found = await setClientTrusted(adapter, clientId, b.trusted);
  if (!found) return c.json({ error: "client_not_found" }, 404);

  logEvent("info", {
    component: "auth",
    event: "oauth-client-updated",
    clientId,
    disabled: typeof b.disabled === "boolean" ? b.disabled : undefined,
    trusted: typeof b.trusted === "boolean" ? b.trusted : undefined,
    actor: "root-key",
  });

  return c.json((await getOAuthClient(adapter, clientId))!);
});

adminOauthRoutes.post("/admin/oauth/clients/:clientId/rotate-secret", async (c) => {
  const clientId = c.req.param("clientId");
  const adapter = await getAdapter(c);
  const res = await rotateClientSecret(adapter, clientId);
  if (res.status === "not_found") return c.json({ error: "client_not_found" }, 404);
  if (res.status === "public_no_secret") return c.json({ error: "public_client_no_secret" }, 400);

  logEvent("warn", {
    component: "auth",
    event: "oauth-client-secret-rotated",
    clientId,
    actor: "root-key",
  });

  return c.json({ clientId, clientSecret: res.secret });
});

adminOauthRoutes.delete("/admin/oauth/clients/:clientId", async (c) => {
  const clientId = c.req.param("clientId");
  const adapter = await getAdapter(c);
  if (!(await deleteOAuthClient(adapter, clientId)))
    return c.json({ error: "client_not_found" }, 404);

  logEvent("warn", {
    component: "auth",
    event: "oauth-client-deleted",
    clientId,
    actor: "root-key",
  });

  return c.json({ clientId, deleted: true });
});
```

- [ ] **Step 6: Wire the namespace + mount**

In `workers/api/src/route-namespaces.ts`, add `"admin/oauth"` to the `adminRoutes` array (next to `"admin/users"`, line 57):

```ts
  "admin/users",
  "admin/oauth",
```

In `workers/api/src/v1-routes.ts`, add the import next to the other admin route imports:

```ts
import { adminOauthRoutes } from "./routes/admin-oauth.js";
```

and mount it next to `adminUsersRoutes`:

```ts
v1.route("/", adminUsersRoutes);
v1.route("/", adminOauthRoutes);
```

- [ ] **Step 7: Run the route test, verify it passes**

Run: `bun test workers/api/test/admin-oauth-route.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 8: Commit**

```bash
git add workers/api/src/auth/index.ts workers/api/src/index.ts workers/api/src/routes/admin-oauth.ts workers/api/src/route-namespaces.ts workers/api/src/v1-routes.ts workers/api/test/admin-oauth-route.test.ts
git commit -m "feat(oauth): root-key admin client routes (create/list/get/patch/rotate/delete) (#1482)"
```

---

## Task 4: Self-service lockdown guard

**Files:**

- Create: `workers/api/src/auth/oauth-self-service-guard.ts`
- Modify: `workers/api/src/index.ts` (register the guard before the `/api/auth/*` handler)
- Test: `workers/api/test/oauth-self-service-guard.test.ts`

- [ ] **Step 1: Write the failing test**

Create `workers/api/test/oauth-self-service-guard.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { oauthSelfServiceGuard } from "../src/auth/oauth-self-service-guard.js";

function appFor(role: string | null) {
  // Minimal fake Better Auth instance: only api.getSession is exercised.
  const fakeAuth = {
    api: {
      getSession: async () => (role === null ? null : { user: { role } }),
    },
  };
  const app = new Hono();
  app.use("/api/auth/oauth2/create-client", (c, next) => {
    (c as any).set("betterAuth", fakeAuth); // test seam
    return next();
  });
  app.use("/api/auth/oauth2/create-client", oauthSelfServiceGuard());
  app.post("/api/auth/oauth2/create-client", (c) => c.json({ ok: true }));
  return app;
}

describe("oauthSelfServiceGuard", () => {
  it("allows an admin session through", async () => {
    const res = await appFor("admin").request("/api/auth/oauth2/create-client", { method: "POST" });
    expect(res.status).toBe(200);
  });

  it("403s a non-admin session", async () => {
    const res = await appFor("user").request("/api/auth/oauth2/create-client", { method: "POST" });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { error: string }).error).toBe("oauth_self_service_admin_only");
  });

  it("403s an anonymous (no-session) request — fail closed", async () => {
    const res = await appFor(null).request("/api/auth/oauth2/create-client", { method: "POST" });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `bun test workers/api/test/oauth-self-service-guard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the guard**

Create `workers/api/src/auth/oauth-self-service-guard.ts`:

```ts
/**
 * Locks the oauth-provider plugin's user self-service *write* client endpoints
 * to admins (#1482). The plugin auto-mounts these session-gated endpoints over
 * HTTP, letting any logged-in user mint OAuth clients; this keeps the AS
 * fail-closed / first-party-only by routing all provisioning through the
 * root-key admin route. Read/public endpoints (public-client(-prelogin),
 * get-client(s)) are intentionally NOT guarded — the consent flow reads them.
 * Register on the four write paths in index.ts BEFORE the /api/auth/* handler.
 */
import type { MiddlewareHandler } from "hono";
import { createAuth } from "./index.js";
import { execWaitUntil } from "../middleware/auth.js";
import type { Env } from "../index.js";

export function oauthSelfServiceGuard(): MiddlewareHandler<Env> {
  return async (c, next) => {
    const auth = c.get("betterAuth") ?? (await createAuth(c.env, execWaitUntil(c)));
    let role: string | null | undefined;
    try {
      const session = await auth.api.getSession({ headers: c.req.raw.headers });
      role = (session?.user as { role?: string | null } | undefined)?.role;
    } catch {
      role = undefined; // fail closed on any session-resolution error
    }
    if (role !== "admin") {
      return c.json({ error: "oauth_self_service_admin_only" }, 403);
    }
    return next();
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**

Run: `bun test workers/api/test/oauth-self-service-guard.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Register the guard in index.ts**

In `workers/api/src/index.ts`, add the import near the other auth imports (line ~10 region):

```ts
import { oauthSelfServiceGuard } from "./auth/oauth-self-service-guard.js";
```

Then, immediately **before** the `app.on(["POST", "GET"], "/api/auth/*", ...)` handler (currently line 439), insert:

```ts
// Lock the oauth-provider plugin's self-service *write* client endpoints to
// admins. The provisioning path is the root-key /v1/admin/oauth route; this
// removes the "any logged-in user can register a client" surface while leaving
// the consent-flow read endpoints (public-client*) untouched. See #1482.
const OAUTH_SELF_SERVICE_WRITE_PATHS = [
  "/api/auth/oauth2/create-client",
  "/api/auth/oauth2/update-client",
  "/api/auth/oauth2/delete-client",
  "/api/auth/oauth2/client/rotate-secret",
];
for (const p of OAUTH_SELF_SERVICE_WRITE_PATHS) {
  app.use(p, oauthSelfServiceGuard());
}
```

- [ ] **Step 6: Verify the full worker test suite + the existing oauth tests still pass**

Run: `bun test workers/api/test/`
Expected: PASS — including the pre-existing `oauth-provider.test.ts` and `oauth-entitlement.test.ts`.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/auth/oauth-self-service-guard.ts workers/api/src/index.ts workers/api/test/oauth-self-service-guard.test.ts
git commit -m "feat(oauth): lock self-service client write endpoints to admins (#1482)"
```

---

## Task 5: Docs + full verification

**Files:**

- Modify: `docs/architecture/remote-mode.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Document the sanctioned exception in remote-mode.md**

Find the OAuth "Role provisioning" section in `docs/architecture/remote-mode.md` (added by #1484) and add a sibling subsection after it:

```markdown
### OAuth client provisioning (admin/oauth)

OAuth clients for "Sign in with Releases" are provisioned via a root-key-gated
admin surface — RFC 7591 dynamic registration stays OFF (#1482). This is the
second sanctioned exception to the "no new `/v1/admin/*` CRUD" rule (alongside
role provisioning).

- `POST /v1/admin/oauth/clients` — create a client. Body: `redirectUris`
  (required, non-empty), `scopes` (required, non-empty), optional `name`,
  `trusted` (→ `skip_consent`, first-party only), `tokenEndpointAuthMethod`
  (`none` ⇒ a secretless **public/PKCE** client, e.g. the MCP client), `type`,
  `grantTypes`, `requirePKCE`, `clientUri`, `logoUri`. Returns the
  `reloc_`-prefixed `clientSecret` **once** (null for a public client).
- `GET /v1/admin/oauth/clients` · `GET /v1/admin/oauth/clients/:clientId` —
  list/get public, secret-free client fields.
- `PATCH /v1/admin/oauth/clients/:clientId { disabled?, trusted? }` — disable is
  a true kill switch (the AS rejects disabled clients at authorize/token/
  introspect); `trusted` toggles `skip_consent`.
- `POST /v1/admin/oauth/clients/:clientId/rotate-secret` — new `reloc_` secret,
  returned once; 400 for a public client.
- `DELETE /v1/admin/oauth/clients/:clientId`.

All mutations emit an audited `logEvent` (`actor: "root-key"`). The plugin's
session-gated self-service write endpoints (`/api/auth/oauth2/{create,update,
delete}-client`, `/oauth2/client/rotate-secret`) are restricted to `role=admin`.
The #1480 entitlement ceiling still applies regardless of client trust.
```

- [ ] **Step 2: Add a one-line conventions bullet in AGENTS.md**

In `AGENTS.md`, directly after the existing **OAuth role provisioning** bullet, add:

```markdown
- **OAuth client provisioning**: register/manage "Sign in with Releases" OAuth clients via the root-key-gated `admin/oauth` route family (`POST/GET/PATCH/DELETE /v1/admin/oauth/clients[...]`, `rotate-secret`); `reloc_` secrets shown once, `trusted` ⇒ `skip_consent`, `tokenEndpointAuthMethod:"none"` ⇒ public/PKCE client; RFC 7591 dynamic registration stays OFF and the plugin's self-service write endpoints are admin-only (#1482). See [remote-mode.md → OAuth client provisioning](docs/architecture/remote-mode.md).
```

- [ ] **Step 3: Type-check both tsconfigs**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit)`
Expected: no errors. (If `BetterAuthInstance` forward-ref errors, move its export to the end of `auth/index.ts` per Task 3 Step 1.)

- [ ] **Step 4: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean. If `format:check` flags the new files, run `bun run format` and re-stage.

- [ ] **Step 5: OpenAPI coverage gate (admin routes are exempt — confirm no regression)**

Run: `bun scripts/check-openapi-coverage.ts`
Expected: PASS — the gate only validates public-read namespaces, so `admin/oauth` needs no annotations.

- [ ] **Step 6: Full worker test suite**

Run: `bun test workers/api/test/`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docs/architecture/remote-mode.md AGENTS.md
git commit -m "docs(oauth): document admin/oauth client provisioning exception (#1482)"
```

---

## Final review checklist (run before opening the PR)

- [ ] `git log --oneline` shows the 6 commits (spec already committed earlier; Tasks 1–5).
- [ ] No `oauth_client` access bypasses the context adapter (no direct Drizzle reads/writes of `oauthClient` in the new code) — grep: `grep -rn "oauthClient" workers/api/src/routes/admin-oauth.ts workers/api/src/auth/oauth-clients.ts` should show only the `"oauthClient"` model string.
- [ ] `allowDynamicClientRegistration` is still `false` in `auth/index.ts` (untouched).
- [ ] No migration files added (`git diff --name-only main -- workers/api/migrations` is empty).
- [ ] Secret never appears in a list/get response (covered by tests).
- [ ] Open the PR with `gh pr create --body-file` (escaped backticks leak in HEREDOCs — `feedback_gh_issue_body`).

## Out of scope (follow-ups)

- **CLI verbs** (`releases admin oauth client ...`) in the `releases-cli` repo — separate PR, mirrors #288.
- **Staging smoke** — once merged, provision a client via the route and run an authorization_code + PKCE flow (operator step; needs `AUTH_UI_ENABLED` + the staging access key header).
- **#1483** — MCP + REST resource-server JWT verification; carry the "auth must be additive (unauthenticated MCP survives)" constraint.
