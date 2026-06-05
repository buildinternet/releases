# Better Auth API Keys Phase 3 (web self-serve) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let signed-in users mint, list, and revoke their own `relu_` API keys from the web app, with the `admin` scope ceiling enforced server-side, while exempting public reads from metering and folding in two Phase-2 loose ends.

**Architecture:** A new session-cookie-authed `/v1/api-keys` resource in the API worker (create wraps the Better Auth `@better-auth/api-key` plugin; list/delete are direct Drizzle on the `apikey` table filtered by `referenceId = session.user.id`). A `meterUserKeys` flag threaded through `middleware/auth.ts` moves `relu_` verification/metering to the authenticated authorization point so public reads no longer burn budget. A web `/account` panel talks to the resource over `fetch(..., {credentials:"include"})`. Both changes ship behind existing/new flags (inert by default).

**Tech Stack:** Cloudflare Workers + Hono + Drizzle (D1), Better Auth (`@better-auth/api-key`), Next.js (App Router) + React, Bun test, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-06-05-better-auth-api-keys-phase3-web-design.md`

**Conventions to respect (from the tree):**
- Test harness: `tests/db-helper.ts` `createTestDb()` applies every migration (so `apikey` exists); `createDb(c.env.DB)` short-circuits when handed a drizzle handle, so route handlers run unchanged under tests that pass `DB: h.db`.
- `createAuth(env, waitUntil?, deps?)` builds a per-request Better Auth instance; the flag-gated `apiKey()` plugin means `auth.api.createApiKey` / `verifyApiKey` are not on the inferred type — use a precise structural cast (see existing `middleware/auth.ts` and `tests/api/user-api-key-auth.test.ts`).
- Timestamps on the `apikey` table are Drizzle `mode:"timestamp"` → JS `Date`; `TokenIdentity` and our wire shapes use ISO strings → convert with `.toISOString()`.
- No emojis / arrow glyphs in the web UI; stone palette; no `window.confirm`.

---

## File Structure

**API worker (`workers/api/`)**
- Modify `src/middleware/auth.ts` — thread `meterUserKeys` through resolution; add `requireSession`; add the `AuthSessionContext` type.
- Modify `src/index.ts` — extend `Env["Variables"]` with `session`; register credentialed CORS + carve-out for `/v1/api-keys`.
- Create `src/routes/user-api-keys.ts` — `userApiKeyHandlers` (no auth) + `userApiKeyRoutes` (requireSession + handlers).
- Modify `src/v1-routes.ts` — mount `userApiKeyRoutes`.
- Modify `src/routes/api-tokens.ts` — enrich the `relu_` branch of `GET /tokens/me`.

**MCP worker (`workers/mcp/`)**
- Create `src/scope-error.ts` — `scopeErrorText(required)` naming both lanes.
- Modify `src/mcp-agent.ts` — use `scopeErrorText`.

**Web (`web/`)**
- Modify `src/lib/auth-ui.ts` — add `USER_API_KEYS_ENABLED`.
- Create `src/lib/api-keys.ts` — `listApiKeys` / `createApiKey` / `revokeApiKey` client + types.
- Create `src/components/api-keys-panel.tsx` — the panel.
- Create `src/app/account/page.tsx` — the account page (gated).
- Modify `src/components/account-nav.tsx` — add the "API keys" link.

**Docs / config**
- Modify `docs/architecture/routing.md` — document the session-authed bucket.
- Modify `.env.example` — document `NEXT_PUBLIC_USER_API_KEYS`.

**Tests**
- Create `tests/api/user-api-keys-route.test.ts` — create/list/delete behavior + scope cap + ownership.
- Create `tests/api/require-session.test.ts` — gate (401/404/happy).
- Modify `tests/api/user-api-key-auth.test.ts` — metering-exemption + `resolveAuthIdentity` returns null for `relu_`.
- Create `tests/api/tokens-me-relu-enrichment.test.ts` — `/tokens/me` enrichment.
- Create `tests/unit/mcp-scope-error.test.ts` — message names both lanes.
- Create `web/src/lib/api-keys.test.ts` — client transport.

---

## Task 1: Metering refactor — exempt public reads (`meterUserKeys`)

**Files:**
- Modify: `workers/api/src/middleware/auth.ts`
- Test: `tests/api/user-api-key-auth.test.ts`

- [ ] **Step 1: Add failing tests for the metering exemption + limiter behavior**

Append to `tests/api/user-api-key-auth.test.ts`. First add imports at the top of the file (after the existing imports):

```ts
import { eq } from "drizzle-orm";
import { apikey } from "../../workers/api/src/db/schema-auth.js";
import { resolveAuthIdentity } from "../../workers/api/src/middleware/auth.js";
```

Change the existing `mintKey` helper to also return the row id (replace the `return created.key;` and its type cast):

```ts
async function mintKey(scope: "read" | "write") {
  insertUser();
  const auth = await createAuth(env(), undefined, { db: h!.db });
  const api = auth.api as typeof auth.api & {
    createApiKey: (a: {
      body: { name: string; userId: string; permissions: Record<string, string[]> };
    }) => Promise<{ key: string; id: string }>;
  };
  const created = await api.createApiKey({
    body: { name: "k", userId: "user_1", permissions: scopeToPermissions(scope) },
  });
  return { key: created.key, id: created.id };
}
```

Update the three existing tests in the first `describe` to destructure `{ key }` from `mintKey(...)` (e.g. `const { key } = await mintKey("write");`). The bogus-key test is unchanged.

Then append a new describe block:

```ts
// A GET route guarded by the public-read middleware (safe method → public).
function readApp() {
  const a = new Hono<Env>();
  a.use("/thing", publicReadAuthMiddleware);
  a.get("/thing", (c) => c.json({ ok: true }));
  return a;
}

describe("relu_ public-read metering exemption", () => {
  // The write path's metering is already proven by the existing "relu_ key rate
  // limiting" describe below (a 2nd POST → 429 once the per-key budget is spent).
  // This test proves the NEW behavior: a public GET never invokes verifyApiKey, so
  // the key row is never touched (lastRequest stays exactly null from minting).
  it("a public GET does NOT meter the key (lastRequest stays null)", async () => {
    h = createTestDb();
    const { key, id } = await mintKey("write");
    const res = await readApp().request(
      "/thing",
      { headers: { Authorization: `Bearer ${key}` } },
      env(),
    );
    expect(res.status).toBe(200); // public read succeeds regardless of the key
    await new Promise((r) => setTimeout(r, 0)); // flush any deferred writes (there are none)
    const row = h.db.select().from(apikey).where(eq(apikey.id, id)).get();
    expect(row?.lastRequest ?? null).toBeNull(); // never verified → never metered
  });

  it("resolveAuthIdentity returns null for a relu_ key (limiter never meters user keys)", async () => {
    h = createTestDb();
    const { key } = await mintKey("write");
    const a = new Hono<Env>();
    a.get("/p", async (c) => c.json({ id: await resolveAuthIdentity(c) }));
    const res = await a.request("/p", { headers: { Authorization: `Bearer ${key}` } }, env());
    const body = (await res.json()) as { id: unknown };
    expect(body.id).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/api/user-api-key-auth.test.ts`
Expected: the two new tests FAIL — today a public GET meters via the public-read resolve (so `lastRequest` is set, not null), and `resolveAuthIdentity` returns a token identity for `relu_` instead of null.

- [ ] **Step 3: Thread `meterUserKeys` through resolution**

In `workers/api/src/middleware/auth.ts`, replace the memo + `resolveAuth` + `resolveAuthUncached` block (the current `RESOLVE_MEMO` WeakMap through the end of `resolveAuthUncached`) with:

```ts
const RESOLVE_MEMO_METERED = new WeakMap<Request, Promise<ResolvedAuth>>();
const RESOLVE_MEMO_UNMETERED = new WeakMap<Request, Promise<ResolvedAuth>>();

/**
 * Memoize resolution per request AND per metering mode. `resolveAuth` runs
 * several times per request (rate limiter, auth middleware, isValidBearerAuth);
 * Better Auth's verifyApiKey meters on every call, so memoization keeps a relu_
 * key metered at most once. The mode split lets the limiter / public-read attach
 * resolve a relu_ key WITHOUT metering (they pass `meterUserKeys=false`) while
 * the authenticated authorization point meters once (`true`). Keyed on the
 * underlying Request (stable per request, WeakMap auto-GCs).
 */
function resolveAuth(
  c: Context<Env>,
  presented: string,
  meterUserKeys: boolean,
): Promise<ResolvedAuth> {
  const memo = meterUserKeys ? RESOLVE_MEMO_METERED : RESOLVE_MEMO_UNMETERED;
  const key = c.req.raw;
  const cached = memo.get(key);
  if (cached) return cached;
  const p = resolveAuthUncached(c, presented, meterUserKeys);
  memo.set(key, p);
  return p;
}

/**
 * Resolve a presented credential to an identity. `relu_…` user keys are verified
 * + metered by Better Auth's verifyApiKey ONLY when `meterUserKeys` is true (the
 * authenticated authorization point); otherwise they resolve to anonymous so a
 * public read never burns the key's budget. `relk_…` tokens go to the DB path;
 * everything else compares to the static RELEASES_API_KEY (root).
 */
async function resolveAuthUncached(
  c: Context<Env>,
  presented: string,
  meterUserKeys: boolean,
): Promise<ResolvedAuth> {
  if (isUserApiKeyShaped(presented)) {
    // Exempt path (limiter, public reads): do not verify/meter — read as anonymous.
    if (!meterUserKeys) return { kind: "none", skip: false };
    if (await flag(c.env.FLAGS, c.env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled))
      return { kind: "none", skip: false };
    if (!(await flag(c.env.FLAGS, c.env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled)))
      return { kind: "none", skip: false };
    const v = await verifyUserKey(c, presented);
    if (v.ok) return { kind: "token", tokenId: USER_API_KEY_PREFIX + v.keyId, scopes: v.scopes };
    return v.rateLimited ? { kind: "rate_limited" } : { kind: "none", skip: false };
  }

  if (isApiTokenShaped(presented)) {
    if (await flag(c.env.FLAGS, c.env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled))
      return { kind: "none", skip: false };
    const result = await verifyApiToken(createDb(c.env.DB), presented);
    if (result.ok) return { kind: "token", tokenId: result.tokenId, scopes: result.scopes };
    return { kind: "none", skip: false };
  }

  const secret = await getSecretWithFallback(c.env.RELEASES_API_KEY, c.env.RELEASED_API_KEY);
  if (!secret) return { kind: "none", skip: true }; // local dev — no secret configured
  if (presented && presented === secret) return { kind: "root", scopes: [ROOT_SCOPE] };
  return { kind: "none", skip: false };
}
```

- [ ] **Step 4: Update the four `resolveAuth` call sites with the mode**

In the same file:

`resolveAuthIdentity` — the limiter never meters:
```ts
export async function resolveAuthIdentity(c: Context<Env>): Promise<AuthContext | null> {
  const presented = bearer(c);
  if (!presented) return null;
  const auth = await resolveAuth(c, presented, false);
  return auth.kind === "root" || auth.kind === "token" ? auth : null;
}
```

`isValidBearerAuth` — a relu_ key can never be admin, so don't meter to learn that:
```ts
export async function isValidBearerAuth(c: Context<Env>): Promise<boolean> {
  const presented = bearer(c);
  if (!presented) return false;
  const auth = await resolveAuth(c, presented, false);
  if (auth.kind === "root") return true;
  if (auth.kind === "token") return scopeSatisfies(auth.scopes, "admin");
  return false;
}
```

In `createAuthMiddleware`, the public-read attach branch (inside `if (opts.allowPublicReads && SAFE_METHODS.has(c.req.method))`) passes `false`:
```ts
      const presented = bearer(c);
      if (presented) {
        const auth = await resolveAuth(c, presented, false);
        if (auth.kind === "root" || auth.kind === "token") recordAuth(c, auth);
      }
```

In `createAuthMiddleware`, the auth-required block (after the early return) passes `true`:
```ts
    const presented = bearer(c);
    const auth = await resolveAuth(c, presented, true);
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test tests/api/user-api-key-auth.test.ts tests/api/resolve-auth-identity.test.ts tests/api/tokens-me-middleware.test.ts`
Expected: PASS (new metering tests green; existing relk_/root/`/tokens/me` tests unaffected).

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/middleware/auth.ts tests/api/user-api-key-auth.test.ts
git commit -m "feat(auth): exempt public reads from relu_ metering (meterUserKeys)"
```

---

## Task 2: `requireSession` middleware + `session` context var

**Files:**
- Modify: `workers/api/src/middleware/auth.ts`
- Modify: `workers/api/src/index.ts` (extend `Env["Variables"]`)
- Test: `tests/api/require-session.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/require-session.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { createAuth } from "../../workers/api/src/auth/index.js";
import { requireSession } from "../../workers/api/src/middleware/auth.js";
import { user } from "../../workers/api/src/db/schema-auth.js";
import type { Env } from "../../workers/api/src/index.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

const SECRET = "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

function env(extra: Record<string, unknown> = {}) {
  return {
    ENVIRONMENT: "test",
    BETTER_AUTH_SECRET: SECRET,
    BETTER_AUTH_URL: "https://api.releases.localhost",
    USER_API_KEYS_ENABLED: "true",
    DB: h!.db,
    ...extra, // spread last so callers can override (e.g. flip the flag off)
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

function app() {
  const a = new Hono<Env>();
  a.use("/probe", requireSession);
  a.get("/probe", (c) => c.json({ userId: c.get("session")?.user.id ?? null }));
  return a;
}

/** Sign up + verify + sign in; return the session cookie header value. */
async function authedCookie(): Promise<string> {
  const auth = await createAuth(env(), undefined, { db: h!.db });
  await auth.api.signUpEmail({
    body: { email: "ann@example.com", password: "correct-horse-battery", name: "Ann" },
  });
  h!.db.update(user).set({ emailVerified: true }).where(eq(user.email, "ann@example.com")).run();
  const res = await auth.api.signInEmail({
    body: { email: "ann@example.com", password: "correct-horse-battery" },
    asResponse: true,
  });
  const cookies = res.headers.getSetCookie();
  return cookies.map((c) => c.split(";")[0]).join("; ");
}

describe("requireSession", () => {
  it("404 when the user-api-keys flag is off", async () => {
    h = createTestDb();
    const res = await app().request("/probe", {}, env({ USER_API_KEYS_ENABLED: "false" }));
    expect(res.status).toBe(404);
  });

  it("401 when there is no session cookie", async () => {
    h = createTestDb();
    const res = await app().request("/probe", {}, env());
    expect(res.status).toBe(401);
  });

  it("passes and exposes the session user id with a valid cookie", async () => {
    h = createTestDb();
    const cookie = await authedCookie();
    const res = await app().request("/probe", { headers: { Cookie: cookie } }, env());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { userId: string | null };
    expect(typeof body.userId).toBe("string");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/require-session.test.ts`
Expected: FAIL — `requireSession` is not exported / `c.get("session")` not typed.

- [ ] **Step 3: Add `AuthSessionContext` + `requireSession` to `middleware/auth.ts`**

At the top of `workers/api/src/middleware/auth.ts`, after the existing `AuthContext` type, add:

```ts
/** Minimal session shape attached to the Hono context by `requireSession`. */
export type AuthSessionContext = { user: { id: string; email: string; name: string } };
```

At the end of the file (after `createAuthMiddleware`), add:

```ts
/**
 * Gate the session-authed self-serve surface (`/v1/api-keys`). When the
 * `user-api-keys-enabled` flag is off, the feature is dark → 404. Otherwise
 * resolve the Better Auth session from the request cookie; no session → 401.
 * On success, attach a minimal `{ user }` to the context for the handlers.
 */
export const requireSession: MiddlewareHandler<Env> = async (c, next) => {
  if (!(await flag(c.env.FLAGS, c.env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled))) {
    return c.json({ error: "not_found", message: "Not found" }, 404);
  }
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }
  const auth = await createAuth(c.env, waitUntil);
  const session = await auth.api.getSession({ headers: c.req.raw.headers });
  if (!session?.user?.id) {
    c.header("WWW-Authenticate", 'Cookie realm="releases-account"');
    return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  }
  c.set("session", {
    user: { id: session.user.id, email: session.user.email, name: session.user.name },
  });
  await next();
};
```

(`createAuth`, `flag`, `FLAGS`, `MiddlewareHandler` are already imported in this file.)

- [ ] **Step 4: Extend `Env["Variables"]` in `index.ts`**

In `workers/api/src/index.ts`, update the `Variables` block (currently `auth?: AuthContext;`) to:

```ts
  Variables: {
    auth?: AuthContext;
    session?: AuthSessionContext;
  };
```

And add `AuthSessionContext` to the existing import from `./middleware/auth.js` (find the import that brings in `AuthContext` and add `type AuthSessionContext`).

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/api/require-session.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/middleware/auth.ts workers/api/src/index.ts tests/api/require-session.test.ts
git commit -m "feat(auth): requireSession middleware for the session-authed self-serve surface"
```

---

## Task 3: `POST /v1/api-keys` — create with server-side scope cap

**Files:**
- Create: `workers/api/src/routes/user-api-keys.ts`
- Test: `tests/api/user-api-keys-route.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/user-api-keys-route.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { user } from "../../workers/api/src/db/schema-auth.js";
import { userApiKeyHandlers } from "../../workers/api/src/routes/user-api-keys.js";
import type { Env } from "../../workers/api/src/index.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

function env() {
  return {
    ENVIRONMENT: "test",
    BETTER_AUTH_SECRET: "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    BETTER_AUTH_URL: "https://api.releases.localhost",
    USER_API_KEYS_ENABLED: "true",
    DB: h!.db,
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

function seedUser(id: string, email: string) {
  h!.db
    .insert(user)
    .values({ id, name: "U", email, emailVerified: true, createdAt: new Date(), updatedAt: new Date() })
    .run();
}

/** Mount the handlers behind a middleware that injects a fixed session. */
function appAs(userId: string) {
  const a = new Hono<Env>();
  a.use("*", (c, next) => {
    c.set("session", { user: { id: userId, email: `${userId}@e.com`, name: "U" } });
    return next();
  });
  a.route("/", userApiKeyHandlers);
  return a;
}

async function post(userId: string, body: unknown) {
  return appAs(userId).request(
    "/api-keys",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    env(),
  );
}

describe("POST /v1/api-keys (create)", () => {
  it("rejects scope 'admin' with 400 (server-side cap)", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const res = await post("user_1", { name: "k", scope: "admin" });
    expect(res.status).toBe(400);
  });

  it("rejects a missing/garbage scope with 400", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect((await post("user_1", { name: "k" })).status).toBe(400);
    expect((await post("user_1", { name: "k", scope: "owner" })).status).toBe(400);
  });

  it("rejects an empty name with 400", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect((await post("user_1", { name: "  ", scope: "read" })).status).toBe(400);
  });

  it("creates a read key and reveals it exactly once", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const res = await post("user_1", { name: "ci", scope: "read" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { key: string; id: string; scope: string; start: string | null };
    expect(body.key.startsWith("relu_")).toBe(true);
    expect(body.scope).toBe("read");
    expect(body.id).toBeTruthy();
  });

  it("creates a write key whose stored scope is write", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const res = await post("user_1", { name: "ci", scope: "write" });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { scope: string };
    expect(body.scope).toBe("write");
  });

  it("rejects an out-of-range expiry with 400", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect((await post("user_1", { name: "k", scope: "read", expiresInDays: 0 })).status).toBe(400);
    expect((await post("user_1", { name: "k", scope: "read", expiresInDays: 999 })).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/user-api-keys-route.test.ts`
Expected: FAIL — module `user-api-keys.js` does not exist.

- [ ] **Step 3: Create the route module (create handler)**

Create `workers/api/src/routes/user-api-keys.ts`:

```ts
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { createDb } from "../db.js";
import { apikey } from "../db/schema-auth.js";
import { createAuth } from "../auth/index.js";
import { scopeToPermissions, apiScopesFromPermissions } from "../auth/api-key-scope.js";
import { type ApiScope } from "@buildinternet/releases-core/api-token";
import { requireSession } from "../middleware/auth.js";
import { logEvent } from "@releases/lib/log-event";
import type { Env } from "../index.js";

const SELF_SERVE_SCOPES = ["read", "write"] as const;
function isSelfServeScope(s: unknown): s is "read" | "write" {
  return typeof s === "string" && (SELF_SERVE_SCOPES as readonly string[]).includes(s);
}

/** Parse a JSON body, or null if it isn't valid JSON. */
async function parseJsonBody(c: Context<Env>): Promise<Record<string, unknown> | null> {
  try {
    return (await c.req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Parse a stored permissions JSON string into a permission map (null on failure). */
function parsePermissions(raw: string | null): Record<string, string[]> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    return null;
  }
}

/** Top ladder label from a permissions map (cumulative actions on `api`). */
function scopeLabel(permissions: Record<string, string[]> | null): ApiScope | null {
  const scopes = apiScopesFromPermissions(permissions);
  if (scopes.includes("admin")) return "admin";
  if (scopes.includes("write")) return "write";
  if (scopes.includes("read")) return "read";
  return null;
}

function execWaitUntil(c: Context<Env>): ((p: Promise<unknown>) => void) | undefined {
  try {
    return c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    return undefined;
  }
}

/**
 * Self-serve user API key handlers — defined WITHOUT auth so unit tests can mount
 * them behind an injected session. Production composes them under `requireSession`
 * via `userApiKeyRoutes` below. Owner is always `session.user.id`.
 */
export const userApiKeyHandlers = new Hono<Env>();

userApiKeyHandlers.post("/api-keys", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);

  const body = await parseJsonBody(c);
  if (!body) return c.json({ error: "bad_request", message: "Invalid JSON body" }, 400);

  const name = typeof body.name === "string" ? body.name.trim() : "";
  if (!name) return c.json({ error: "bad_request", message: "name is required" }, 400);

  // The server-side scope ceiling: self-serve mints read/write only, never admin.
  if (!isSelfServeScope(body.scope)) {
    return c.json({ error: "bad_request", message: "scope must be 'read' or 'write'" }, 400);
  }

  let expiresIn: number | undefined;
  if (body.expiresInDays !== undefined) {
    const d = body.expiresInDays;
    if (typeof d !== "number" || !Number.isInteger(d) || d < 1 || d > 365) {
      return c.json(
        { error: "bad_request", message: "expiresInDays must be an integer between 1 and 365" },
        400,
      );
    }
    expiresIn = d * 24 * 60 * 60;
  }

  const auth = await createAuth(c.env, execWaitUntil(c));
  // apiKey() is flag-gated, so betterAuth's inferred api type omits createApiKey;
  // assert its shape with a precise (non-any) structural cast.
  const api = auth.api as typeof auth.api & {
    createApiKey: (a: {
      body: {
        name: string;
        userId: string;
        permissions: Record<string, string[]>;
        metadata?: Record<string, unknown>;
        expiresIn?: number;
      };
    }) => Promise<{
      id: string;
      key: string;
      name: string | null;
      start: string | null;
      remaining: number | null;
      // Better Auth may return these as Date, epoch ms, or ISO string depending
      // on version — coerce via `new Date(...)` below rather than assuming Date.
      expiresAt: Date | number | string | null;
      createdAt: Date | number | string;
    }>;
  };

  const created = await api.createApiKey({
    body: {
      name,
      userId: session.user.id,
      permissions: scopeToPermissions(body.scope),
      metadata: { plan: "default" },
      ...(expiresIn ? { expiresIn } : {}),
    },
  });

  logEvent("info", {
    component: "user-api-keys",
    event: "created",
    keyId: created.id,
    scope: body.scope,
  });

  // The full key is returned exactly once and is never retrievable again.
  return c.json(
    {
      key: created.key,
      id: created.id,
      name: created.name,
      start: created.start,
      scope: scopeLabel(scopeToPermissions(body.scope)),
      remaining: created.remaining,
      expiresAt: created.expiresAt ? new Date(created.expiresAt).toISOString() : null,
      createdAt: new Date(created.createdAt).toISOString(),
    },
    201,
  );
});

/** Production composition: requireSession then the handlers. */
export const userApiKeyRoutes = new Hono<Env>();
userApiKeyRoutes.use("/api-keys", requireSession);
userApiKeyRoutes.use("/api-keys/*", requireSession);
userApiKeyRoutes.route("/", userApiKeyHandlers);

// Re-export the pure helpers for the list/delete handlers added in later tasks.
export { parseJsonBody, parsePermissions, scopeLabel, execWaitUntil };
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/api/user-api-keys-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/user-api-keys.ts tests/api/user-api-keys-route.test.ts
git commit -m "feat(api): POST /v1/api-keys self-serve create with server-side scope cap"
```

---

## Task 4: `GET /v1/api-keys` — list (own keys only)

**Files:**
- Modify: `workers/api/src/routes/user-api-keys.ts`
- Test: `tests/api/user-api-keys-route.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/api/user-api-keys-route.test.ts`:

```ts
async function list(userId: string) {
  const res = await appAs(userId).request("/api-keys", {}, env());
  return { status: res.status, body: (await res.json()) as { apiKeys: Array<Record<string, unknown>> } };
}

describe("GET /v1/api-keys (list)", () => {
  it("returns only the caller's keys, never the secret", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    seedUser("user_2", "u2@e.com");
    await post("user_1", { name: "mine", scope: "read" });
    await post("user_2", { name: "theirs", scope: "write" });

    const { status, body } = await list("user_1");
    expect(status).toBe(200);
    expect(body.apiKeys).toHaveLength(1);
    const k = body.apiKeys[0]!;
    expect(k.name).toBe("mine");
    expect(k.scope).toBe("read");
    expect("key" in k).toBe(false); // the hashed/secret key is never projected
    expect(typeof k.id).toBe("string");
  });

  it("returns an empty list for a user with no keys", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const { status, body } = await list("user_1");
    expect(status).toBe(200);
    expect(body.apiKeys).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/user-api-keys-route.test.ts`
Expected: FAIL — `GET /api-keys` is not registered (404).

- [ ] **Step 3: Add the list handler**

In `workers/api/src/routes/user-api-keys.ts`, add (after the `post` handler, before the `userApiKeyRoutes` export):

```ts
userApiKeyHandlers.get("/api-keys", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const db = createDb(c.env.DB);
  const rows = await db.select().from(apikey).where(eq(apikey.referenceId, session.user.id)).all();
  return c.json({
    apiKeys: rows.map((r) => ({
      id: r.id,
      name: r.name,
      start: r.start,
      scope: scopeLabel(parsePermissions(r.permissions)),
      enabled: r.enabled,
      remaining: r.remaining,
      lastRequest: r.lastRequest ? r.lastRequest.toISOString() : null,
      createdAt: r.createdAt.toISOString(),
      expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    })),
  });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/api/user-api-keys-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/user-api-keys.ts tests/api/user-api-keys-route.test.ts
git commit -m "feat(api): GET /v1/api-keys lists the caller's own keys"
```

---

## Task 5: `DELETE /v1/api-keys/:id` — revoke (ownership-checked)

**Files:**
- Modify: `workers/api/src/routes/user-api-keys.ts`
- Test: `tests/api/user-api-keys-route.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `tests/api/user-api-keys-route.test.ts`:

```ts
async function del(userId: string, id: string) {
  return appAs(userId).request(`/api-keys/${id}`, { method: "DELETE" }, env());
}

describe("DELETE /v1/api-keys/:id (revoke)", () => {
  it("deletes the caller's own key", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    const created = (await (await post("user_1", { name: "k", scope: "read" })).json()) as { id: string };
    const res = await del("user_1", created.id);
    expect(res.status).toBe(200);
    expect((await list("user_1")).body.apiKeys).toHaveLength(0);
  });

  it("cannot delete another user's key (404, indistinct from absent)", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    seedUser("user_2", "u2@e.com");
    const created = (await (await post("user_2", { name: "k", scope: "read" })).json()) as { id: string };
    const res = await del("user_1", created.id);
    expect(res.status).toBe(404);
    // and user_2's key still exists
    expect((await list("user_2")).body.apiKeys).toHaveLength(1);
  });

  it("404 for an absent id", async () => {
    h = createTestDb();
    seedUser("user_1", "u1@e.com");
    expect((await del("user_1", "ak_nope")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/user-api-keys-route.test.ts`
Expected: FAIL — `DELETE /api-keys/:id` not registered.

- [ ] **Step 3: Add the delete handler**

In `workers/api/src/routes/user-api-keys.ts`, add (after the `get` handler):

```ts
userApiKeyHandlers.delete("/api-keys/:id", async (c) => {
  const session = c.get("session");
  if (!session) return c.json({ error: "unauthorized", message: "Sign in required" }, 401);
  const id = c.req.param("id");
  const db = createDb(c.env.DB);
  // The referenceId clause IS the ownership check — a non-owned/absent id deletes
  // zero rows and returns one indistinct 404 (no cross-user existence oracle).
  const deleted = await db
    .delete(apikey)
    .where(and(eq(apikey.id, id), eq(apikey.referenceId, session.user.id)))
    .returning();
  if (deleted.length === 0) return c.json({ error: "not_found", message: "API key not found" }, 404);
  logEvent("info", { component: "user-api-keys", event: "revoked", keyId: id });
  return c.json({ success: true });
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/api/user-api-keys-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/user-api-keys.ts tests/api/user-api-keys-route.test.ts
git commit -m "feat(api): DELETE /v1/api-keys/:id revokes an owned key"
```

---

## Task 6: Mount `/v1/api-keys` + credentialed CORS carve-out

**Files:**
- Modify: `workers/api/src/v1-routes.ts`
- Modify: `workers/api/src/index.ts`
- Test: `tests/api/user-api-keys-cors.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/user-api-keys-cors.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { authCorsMiddleware } from "../../workers/api/src/auth/index.js";

// Mirrors the index.ts CORS wiring: authCorsMiddleware owns credentialed CORS on
// /api/auth/* AND /v1/api-keys/*, and the wildcard public cors() runs on every
// OTHER path. Without the carve-out the wildcard cors overwrites the credentialed
// Access-Control-Allow-Origin on the actual /v1/api-keys response.
function makeApp() {
  const app = new Hono();
  app.use("/api/auth/*", authCorsMiddleware());
  app.use("/v1/api-keys", authCorsMiddleware());
  app.use("/v1/api-keys/*", authCorsMiddleware());
  const publicReadCors = cors();
  app.use("*", (c, next) =>
    c.req.path.startsWith("/api/auth/") || c.req.path.startsWith("/v1/api-keys")
      ? next()
      : publicReadCors(c, next),
  );
  app.get("/v1/api-keys", (c) => c.json({ apiKeys: [] }));
  app.get("/v1/orgs", (c) => c.json({ ok: true }));
  return app;
}

describe("/v1/api-keys credentialed CORS", () => {
  it("reflects the origin (not '*') with credentials on /v1/api-keys", async () => {
    const res = await makeApp().request(
      "/v1/api-keys",
      { headers: { Origin: "https://releases.sh" } },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("https://releases.sh");
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  it("keeps wildcard CORS on other public routes", async () => {
    const res = await makeApp().request(
      "/v1/orgs",
      { headers: { Origin: "https://anything.example" } },
      { ENVIRONMENT: "production" } as never,
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/user-api-keys-cors.test.ts`
Expected: PASS immediately — `makeApp()` builds the intended wiring inline, so this is a regression lock on the CORS shape rather than a red-first test. Its purpose is to encode the exact carve-out you replicate in `index.ts` in steps 3–4 (a future edit that breaks the shape turns this red).

- [ ] **Step 3: Mount the routes in `v1-routes.ts`**

In `workers/api/src/v1-routes.ts`, add the import near the other route imports:

```ts
import { userApiKeyRoutes } from "./routes/user-api-keys.js";
```

And add the mount inside `mountV1Routes`, next to `apiTokenRoutes`:

```ts
  v1.route("/", userApiKeyRoutes);
```

- [ ] **Step 4: Wire the credentialed CORS carve-out in `index.ts`**

In `workers/api/src/index.ts`, find the line `app.use("/api/auth/*", authCorsMiddleware());` and add immediately after it:

```ts
// Session-authed self-serve surface needs the same credentialed, origin-reflecting
// CORS as /api/auth/* so the browser sends the cross-subdomain session cookie.
app.use("/v1/api-keys", authCorsMiddleware());
app.use("/v1/api-keys/*", authCorsMiddleware());
```

Then update the wildcard `publicReadCors` guard (currently
`app.use("*", (c, next) => (c.req.path.startsWith("/api/auth/") ? next() : publicReadCors(c, next)));`) to:

```ts
app.use("*", (c, next) =>
  c.req.path.startsWith("/api/auth/") || c.req.path.startsWith("/v1/api-keys")
    ? next()
    : publicReadCors(c, next),
);
```

- [ ] **Step 5: Add the per-IP limiter on the read path (parity)**

In `workers/api/src/index.ts`, after the `adminRoutes` CORS loop and near the other `v1.use(...)` cache-control lines, add:

```ts
// Self-serve API keys: per-IP limiter on the read (GET list) path for parity
// with public reads. It no-ops on POST/DELETE (non-safe methods); those are
// session-gated. (See routing.md — the session-authed self-serve bucket.)
v1.use("/api-keys", publicRateLimitMiddleware);
v1.use("/api-keys/*", publicRateLimitMiddleware);
```

(`publicRateLimitMiddleware` is already imported in `index.ts`.)

- [ ] **Step 6: Run the CORS test + typecheck the worker**

Run: `bun test tests/api/user-api-keys-cors.test.ts`
Expected: PASS.

Run: `cd workers/api && npx tsc --noEmit && cd ../..`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/v1-routes.ts workers/api/src/index.ts tests/api/user-api-keys-cors.test.ts
git commit -m "feat(api): mount /v1/api-keys with credentialed CORS carve-out"
```

---

## Task 7: `/tokens/me` enrichment for `relu_` keys

**Files:**
- Modify: `workers/api/src/routes/api-tokens.ts`
- Test: `tests/api/tokens-me-relu-enrichment.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/tokens-me-relu-enrichment.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apikey } from "../../workers/api/src/db/schema-auth.js";
import { scopeToPermissions } from "../../workers/api/src/auth/api-key-scope.js";
import { apiTokenRoutes } from "../../workers/api/src/routes/api-tokens.js";
import type { Env } from "../../workers/api/src/index.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

/** Mount /tokens with an injected relu_ token identity (skips the verify path). */
function appWithReluAuth(tokenId: string, scopes: string[]) {
  const a = new Hono<Env>();
  a.use("*", (c, next) => {
    c.set("auth", { kind: "token", tokenId, scopes });
    return next();
  });
  a.route("/", apiTokenRoutes);
  return a;
}

describe("GET /tokens/me enrichment for relu_ keys", () => {
  it("returns the real key name + Better Auth userId", async () => {
    h = createTestDb();
    h.db
      .insert(apikey)
      .values({
        id: "ak_1",
        key: "hash",
        referenceId: "user_9",
        name: "My CI Key",
        permissions: JSON.stringify(scopeToPermissions("read")),
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const res = await appWithReluAuth("relu_ak_1", ["read"]).request("/tokens/me", {}, { DB: h.db });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("My CI Key");
    expect(body.principalType).toBe("user");
    expect(body.principalId).toBe("user_9");
    expect(body.scopes).toEqual(["read"]);
  });

  it("falls back gracefully when the apikey row is gone", async () => {
    h = createTestDb();
    const res = await appWithReluAuth("relu_ak_missing", ["read"]).request(
      "/tokens/me",
      {},
      { DB: h.db },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("user-api-key");
    expect(body.principalId).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/tokens-me-relu-enrichment.test.ts`
Expected: FAIL — current handler returns `name: "user-api-key"` / `principalId: null` even when the row exists.

- [ ] **Step 3: Enrich the `relu_` branch**

In `workers/api/src/routes/api-tokens.ts`:

Add imports — extend the core import to include `USER_API_KEY_PREFIX`, and add the schema import:

```ts
import { apikey } from "../db/schema-auth.js";
```

(In the existing `@buildinternet/releases-core/api-token` import list, add `USER_API_KEY_PREFIX`.)

Replace the current `relu_` branch inside `apiTokenRoutes.get("/tokens/me", ...)`:

```ts
  // User API keys (relu_) live in Better Auth's `apikey` table. The middleware
  // already verified + metered the key; enrich with the row's name + owning
  // userId. Timestamps are Date columns → ISO. A missing row (revoked between
  // verify and this read) falls back to the minimal identity rather than 500ing.
  if (auth.kind === "token" && isUserApiKeyShaped(auth.tokenId)) {
    const keyId = auth.tokenId.slice(USER_API_KEY_PREFIX.length);
    const db = createDb(c.env.DB);
    const row = await db.select().from(apikey).where(eq(apikey.id, keyId)).get();
    return c.json({
      kind: "token",
      name: row?.name ?? "user-api-key",
      scopes: auth.scopes,
      principalType: "user",
      principalId: row?.referenceId ?? null,
      expiresAt: row?.expiresAt ? row.expiresAt.toISOString() : null,
      lastUsedAt: row?.lastRequest ? row.lastRequest.toISOString() : null,
    } satisfies TokenIdentity);
  }
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/api/tokens-me-relu-enrichment.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/api-tokens.ts tests/api/tokens-me-relu-enrichment.test.ts
git commit -m "feat(api): enrich /tokens/me with relu_ key name + Better Auth userId"
```

---

## Task 8: MCP `scopeError` names both lanes

**Files:**
- Create: `workers/mcp/src/scope-error.ts`
- Modify: `workers/mcp/src/mcp-agent.ts`
- Test: `tests/unit/mcp-scope-error.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mcp-scope-error.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { scopeErrorText } from "../../workers/mcp/src/scope-error.js";

describe("scopeErrorText", () => {
  it("names both the relk_ machine lane and the relu_ user lane", () => {
    const msg = scopeErrorText("write");
    expect(msg).toContain("insufficient_scope");
    expect(msg).toContain("write");
    expect(msg).toContain("relk_");
    expect(msg).toContain("relu_");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/mcp-scope-error.test.ts`
Expected: FAIL — `scope-error.js` does not exist.

- [ ] **Step 3: Create the helper**

Create `workers/mcp/src/scope-error.ts`:

```ts
import { type ApiScope } from "@buildinternet/releases-core/api-token";

/**
 * Tool-level insufficient-scope message surfaced to the model. Names BOTH token
 * lanes so a live relu_ user-key holder gets accurate guidance, not just relk_
 * machine-token callers.
 */
export function scopeErrorText(required: ApiScope): string {
  return (
    `insufficient_scope: this MCP tool requires a '${required}'-scoped API key. ` +
    `Present a ${required}-capable key via Authorization: Bearer ` +
    `(relk_… machine token or relu_… user key).`
  );
}
```

- [ ] **Step 4: Use it in `mcp-agent.ts`**

In `workers/mcp/src/mcp-agent.ts`, add the import near the top (with the other local imports):

```ts
import { scopeErrorText } from "./scope-error.js";
```

Replace the body of `scopeError`:

```ts
function scopeError(required: ApiScope): ToolResult {
  return {
    content: [{ type: "text", text: scopeErrorText(required) }],
    isError: true,
  };
}
```

- [ ] **Step 5: Run the test + typecheck the MCP worker**

Run: `bun test tests/unit/mcp-scope-error.test.ts`
Expected: PASS.

Run: `cd workers/mcp && npx tsc --noEmit && cd ../..`
Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add workers/mcp/src/scope-error.ts workers/mcp/src/mcp-agent.ts tests/unit/mcp-scope-error.test.ts
git commit -m "feat(mcp): scopeError names both the relk_ and relu_ lanes"
```

---

## Task 9: Docs + `.env.example`

**Files:**
- Modify: `docs/architecture/routing.md`
- Modify: `.env.example`

- [ ] **Step 1: Document the session-authed bucket in `routing.md`**

In `docs/architecture/routing.md`, under the "Route naming buckets (#494)" section, after the three bucket bullets and the "Do not add new `/v1/admin/*`…" line, add:

```markdown
A fourth, narrower bucket exists for **self-serve, session-authed** resources:
`/v1/api-keys` (user-owned `relu_` API key management) is gated by `requireSession`
(Better Auth session cookie), not by the Bearer-token middleware. It is intentionally
absent from both `publicReadRoutes` and `adminRoutes` in
`workers/api/src/route-namespaces.ts` (so neither the public-read nor admin auth loop
touches it) and from the public-read OpenAPI coverage gate. Its credentialed CORS is
carved out alongside `/api/auth/*` in `index.ts`. This bucket is for first-party,
current-user browser operations; it is not a general extension point.
```

- [ ] **Step 2: Document the web flag in `.env.example`**

In `.env.example`, near the other `NEXT_PUBLIC_*` web flags (e.g. `NEXT_PUBLIC_AUTH_UI_ENABLED`), add:

```bash
# Reveal the self-serve API Keys panel at /account (web). Keep off until the
# server-side `user-api-keys-enabled` Flagship flag is on. Default: off.
NEXT_PUBLIC_USER_API_KEYS=false
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/routing.md .env.example
git commit -m "docs(auth): document the /v1/api-keys session bucket + NEXT_PUBLIC_USER_API_KEYS"
```

---

## Task 10: Web reveal flag

**Files:**
- Modify: `web/src/lib/auth-ui.ts`

- [ ] **Step 1: Add the flag**

In `web/src/lib/auth-ui.ts`, append:

```ts
/**
 * Reveal the self-serve API Keys panel (`/account`). **Off unless
 * `NEXT_PUBLIC_USER_API_KEYS` is exactly `"true"`.** Mirrors the server-side
 * `user-api-keys-enabled` Flagship flag so the panel stays dark until the backend
 * accepts `relu_` keys. `NEXT_PUBLIC_*` is inlined at build time.
 */
export const USER_API_KEYS_ENABLED = process.env.NEXT_PUBLIC_USER_API_KEYS === "true";
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/auth-ui.ts
git commit -m "feat(web): NEXT_PUBLIC_USER_API_KEYS reveal flag"
```

---

## Task 11: Web API-keys client (`web/src/lib/api-keys.ts`)

**Files:**
- Create: `web/src/lib/api-keys.ts`
- Test: `web/src/lib/api-keys.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/api-keys.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";

const ORIG = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
process.env.NEXT_PUBLIC_BETTER_AUTH_URL = "https://api.test";

const { listApiKeys, createApiKey, revokeApiKey } = await import("./api-keys.js");

type Call = { url: string; init?: RequestInit };
let calls: Call[] = [];
function mockFetch(response: unknown, ok = true, status = 200) {
  calls = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return {
      ok,
      status,
      json: async () => response,
    } as Response;
  }) as typeof fetch;
}

afterEach(() => {
  if (ORIG === undefined) delete process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  else process.env.NEXT_PUBLIC_BETTER_AUTH_URL = ORIG;
});

describe("api-keys client", () => {
  it("lists with credentials and returns the array", async () => {
    mockFetch({ apiKeys: [{ id: "ak_1", name: "k" }] });
    const keys = await listApiKeys();
    expect(keys).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://api.test/v1/api-keys");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("creates via POST with a JSON body and credentials", async () => {
    mockFetch({ id: "ak_2", key: "relu_secret", name: "ci", scope: "write" }, true, 201);
    const created = await createApiKey({ name: "ci", scope: "write" });
    expect(created.key).toBe("relu_secret");
    expect(calls[0]!.url).toBe("https://api.test/v1/api-keys");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(calls[0]!.init?.credentials).toBe("include");
  });

  it("surfaces the server message on a failed create", async () => {
    mockFetch({ error: "bad_request", message: "scope must be 'read' or 'write'" }, false, 400);
    await expect(createApiKey({ name: "x", scope: "write" })).rejects.toThrow(/scope must be/);
  });

  it("revokes via DELETE with credentials", async () => {
    mockFetch({ success: true });
    await revokeApiKey("ak_3");
    expect(calls[0]!.url).toBe("https://api.test/v1/api-keys/ak_3");
    expect(calls[0]!.init?.method).toBe("DELETE");
    expect(calls[0]!.init?.credentials).toBe("include");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test web/src/lib/api-keys.test.ts`
Expected: FAIL — module `api-keys.js` does not exist.

- [ ] **Step 3: Create the client**

Create `web/src/lib/api-keys.ts`:

```ts
/**
 * Browser client for the self-serve user API key surface (`/v1/api-keys` on the
 * API worker). Uses `credentials: "include"` so the cross-subdomain
 * (`.releases.sh`) Better Auth session cookie rides along. NOT the Better Auth
 * apiKeyClient() — the server wraps create to set permissions/userId, so we talk
 * to our own endpoints for one consistent surface.
 */

export type UserApiKeyScope = "read" | "write" | "admin";

export interface UserApiKey {
  id: string;
  name: string | null;
  start: string | null;
  scope: UserApiKeyScope | null;
  enabled: boolean | null;
  remaining: number | null;
  lastRequest: string | null;
  createdAt: string;
  expiresAt: string | null;
}

/** Create response — includes the full key exactly once. */
export interface CreatedUserApiKey extends Omit<UserApiKey, "enabled" | "lastRequest"> {
  key: string;
}

function apiBase(): string {
  const url = process.env.NEXT_PUBLIC_BETTER_AUTH_URL;
  if (!url) throw new Error("NEXT_PUBLIC_BETTER_AUTH_URL is not set");
  return url.replace(/\/$/, "");
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}

export async function listApiKeys(): Promise<UserApiKey[]> {
  const res = await fetch(`${apiBase()}/v1/api-keys`, { credentials: "include" });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to load API keys (${res.status})`));
  const data = (await res.json()) as { apiKeys: UserApiKey[] };
  return data.apiKeys;
}

export async function createApiKey(input: {
  name: string;
  scope: "read" | "write";
  expiresInDays?: number;
}): Promise<CreatedUserApiKey> {
  const res = await fetch(`${apiBase()}/v1/api-keys`, {
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to create API key (${res.status})`));
  return (await res.json()) as CreatedUserApiKey;
}

export async function revokeApiKey(id: string): Promise<void> {
  const res = await fetch(`${apiBase()}/v1/api-keys/${encodeURIComponent(id)}`, {
    method: "DELETE",
    credentials: "include",
  });
  if (!res.ok) throw new Error(await errorMessage(res, `Failed to revoke API key (${res.status})`));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test web/src/lib/api-keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api-keys.ts web/src/lib/api-keys.test.ts
git commit -m "feat(web): api-keys client (list/create/revoke) over the session cookie"
```

---

## Task 12: Web `ApiKeysPanel` component

**Files:**
- Create: `web/src/components/api-keys-panel.tsx`

- [ ] **Step 1: Create the component**

Create `web/src/components/api-keys-panel.tsx`:

```tsx
"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSession } from "@/lib/auth-client";
import {
  listApiKeys,
  createApiKey,
  revokeApiKey,
  type UserApiKey,
  type CreatedUserApiKey,
} from "@/lib/api-keys";

const labelClass = "block text-sm font-medium text-stone-700 dark:text-stone-200";
const inputClass =
  "mt-1 w-full border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none focus:border-stone-500 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100";
const buttonClass =
  "inline-flex h-10 items-center justify-center border border-stone-300 bg-white px-4 text-sm font-medium text-stone-800 transition hover:bg-stone-50 disabled:cursor-not-allowed disabled:opacity-60 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-100 dark:hover:bg-stone-900";

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString();
}

export function ApiKeysPanel() {
  const { data: sessionData, isPending } = useSession();
  const user = sessionData?.user;

  const [keys, setKeys] = useState<UserApiKey[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [name, setName] = useState("");
  const [scope, setScope] = useState<"read" | "write">("read");
  const [creating, setCreating] = useState(false);
  const [revealed, setRevealed] = useState<CreatedUserApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setKeys(await listApiKeys());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load API keys");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (user) void refresh();
  }, [user, refresh]);

  async function onCreate(e: React.FormEvent) {
    e.preventDefault();
    if (creating || !name.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const created = await createApiKey({ name: name.trim(), scope });
      setRevealed(created);
      setCopied(false);
      setName("");
      setScope("read");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create API key");
    } finally {
      setCreating(false);
    }
  }

  async function onRevoke(id: string) {
    setError(null);
    try {
      await revokeApiKey(id);
      setConfirmId(null);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to revoke API key");
    }
  }

  async function onCopy() {
    if (!revealed) return;
    try {
      await navigator.clipboard.writeText(revealed.key);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  if (isPending) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }

  if (!user) {
    return (
      <p className="text-sm leading-6 text-stone-600 dark:text-stone-300">
        Please{" "}
        <Link href="/login?redirect=/account" className="underline">
          sign in
        </Link>{" "}
        to manage your API keys.
      </p>
    );
  }

  return (
    <div className="space-y-8">
      <header>
        <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
          Account
        </p>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          API keys
        </h1>
        <p className="mt-3 max-w-prose text-sm leading-6 text-stone-500 dark:text-stone-400">
          Personal{" "}
          <code className="font-mono text-[0.85em] text-stone-600 dark:text-stone-300">relu_</code>{" "}
          keys for the Releases API and MCP server. A key is shown once at creation — store it
          somewhere safe.
        </p>
      </header>

      {error && (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {error}
        </p>
      )}

      {revealed && (
        <div className="border border-green-600/30 bg-green-50 p-4 dark:border-green-500/30 dark:bg-green-950/40">
          <p className="text-sm font-medium text-green-800 dark:text-green-300">
            Key created. Copy it now — it won't be shown again.
          </p>
          <code className="mt-3 block overflow-x-auto whitespace-nowrap border border-green-600/30 bg-white px-3 py-2 font-mono text-xs text-stone-900 dark:bg-stone-950 dark:text-stone-100">
            {revealed.key}
          </code>
          <div className="mt-3 flex gap-2">
            <button type="button" onClick={onCopy} className={buttonClass}>
              {copied ? "Copied" : "Copy"}
            </button>
            <button type="button" onClick={() => setRevealed(null)} className={buttonClass}>
              I've saved it
            </button>
          </div>
        </div>
      )}

      <form onSubmit={onCreate} className="space-y-4 border border-stone-200 p-5 dark:border-stone-800">
        <div>
          <label htmlFor="key-name" className={labelClass}>
            Name
          </label>
          <input
            id="key-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. CI pipeline"
            className={inputClass}
            required
          />
        </div>
        <fieldset>
          <legend className={labelClass}>Scope</legend>
          <div className="mt-2 flex gap-4 text-sm text-stone-700 dark:text-stone-200">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                value="read"
                checked={scope === "read"}
                onChange={() => setScope("read")}
              />
              Read
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="scope"
                value="write"
                checked={scope === "write"}
                onChange={() => setScope("write")}
              />
              Write
            </label>
          </div>
        </fieldset>
        <button type="submit" disabled={creating || !name.trim()} className={buttonClass}>
          {creating ? "Creating…" : "Create key"}
        </button>
      </form>

      <section>
        <h2 className="text-sm font-semibold text-stone-900 dark:text-stone-100">Your keys</h2>
        {loading ? (
          <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">Loading…</p>
        ) : keys.length === 0 ? (
          <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">No keys yet.</p>
        ) : (
          <ul className="mt-3 divide-y divide-stone-200 border border-stone-200 dark:divide-stone-800 dark:border-stone-800">
            {keys.map((k) => (
              <li key={k.id} className="flex items-center justify-between gap-4 px-4 py-3">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-stone-900 dark:text-stone-100">
                    {k.name || "(unnamed)"}
                  </p>
                  <p className="mt-0.5 font-mono text-xs text-stone-500 dark:text-stone-400">
                    {k.start ? `${k.start}…` : "relu_…"} · {k.scope ?? "read"} · created{" "}
                    {formatDate(k.createdAt)}
                    {k.expiresAt ? ` · expires ${formatDate(k.expiresAt)}` : ""}
                  </p>
                </div>
                {confirmId === k.id ? (
                  <div className="flex shrink-0 gap-2">
                    <button
                      type="button"
                      onClick={() => onRevoke(k.id)}
                      className="inline-flex h-9 items-center justify-center border border-red-300 bg-white px-3 text-sm font-medium text-red-700 transition hover:bg-red-50 dark:border-red-500/40 dark:bg-stone-950 dark:text-red-400 dark:hover:bg-red-950/30"
                    >
                      Confirm revoke
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmId(null)}
                      className={buttonClass}
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => setConfirmId(k.id)}
                    className="shrink-0 text-sm text-stone-500 underline hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
                  >
                    Revoke
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/api-keys-panel.tsx
git commit -m "feat(web): ApiKeysPanel — list/create (reveal-once)/revoke UI"
```

---

## Task 13: Web `/account` page

**Files:**
- Create: `web/src/app/account/page.tsx`

- [ ] **Step 1: Create the page**

Create `web/src/app/account/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Header } from "@/components/header";
import { ApiKeysPanel } from "@/components/api-keys-panel";
import { AUTH_UI_ENABLED, USER_API_KEYS_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Account",
  description: "Manage your releases.sh account and API keys.",
  alternates: { canonical: "/account" },
  robots: { index: false, follow: false },
};

export default function AccountPage() {
  // Dark unless the auth UI master switch AND the API-keys reveal flag are on,
  // and the Better Auth client base URL is configured (else useSession 404s).
  if (!AUTH_UI_ENABLED || !USER_API_KEYS_ENABLED || !process.env.NEXT_PUBLIC_BETTER_AUTH_URL) {
    notFound();
  }
  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto w-full max-w-3xl px-6 py-12">
        <ApiKeysPanel />
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/account/page.tsx
git commit -m "feat(web): /account page hosting the API Keys panel (gated)"
```

---

## Task 14: AccountNav "API keys" link

**Files:**
- Modify: `web/src/components/account-nav.tsx`

- [ ] **Step 1: Add the link to both menu variants**

In `web/src/components/account-nav.tsx`:

Add the import at the top (next to the existing `AUTH_UI_ENABLED` import):

```ts
import { AUTH_UI_ENABLED, USER_API_KEYS_ENABLED } from "@/lib/auth-ui";
```

In the **mobile** signed-in branch, add an "API keys" link before the "Sign out" button (only when the flag is on):

```tsx
        {USER_API_KEYS_ENABLED && (
          <Link
            href="/account"
            className="mt-2 block py-1 text-left text-stone-500 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100"
          >
            API keys
          </Link>
        )}
```

In the **desktop** dropdown menu, add an "API keys" link inside the `role="menu"` container, before the "Sign out" button:

```tsx
            {USER_API_KEYS_ENABLED && (
              <Link
                href="/account"
                role="menuitem"
                onClick={() => setOpen(false)}
                className="mt-3 block w-full border border-stone-300 px-3 py-1.5 text-center text-sm text-stone-700 transition hover:bg-stone-50 dark:border-stone-700 dark:text-stone-200 dark:hover:bg-stone-900"
              >
                API keys
              </Link>
            )}
```

(`Link` is already imported in this file.)

- [ ] **Step 2: Typecheck**

Run: `cd web && npx tsc --noEmit && cd ..`
Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/components/account-nav.tsx
git commit -m "feat(web): link to /account from the account menu (flag-gated)"
```

---

## Task 15: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck root + all workers + web**

Run:
```bash
npx tsc --noEmit
cd workers/api && npx tsc --noEmit && cd ../..
cd workers/mcp && npx tsc --noEmit && cd ../..
cd web && npx tsc --noEmit && cd ..
```
Expected: no errors anywhere.

- [ ] **Step 2: Run the full test suite**

Run: `bun test`
Expected: all green, including the new files:
`tests/api/user-api-keys-route.test.ts`, `tests/api/require-session.test.ts`,
`tests/api/user-api-key-auth.test.ts`, `tests/api/user-api-keys-cors.test.ts`,
`tests/api/tokens-me-relu-enrichment.test.ts`, `tests/unit/mcp-scope-error.test.ts`,
`web/src/lib/api-keys.test.ts`.

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean (run `bun run format` if format:check flags files).

- [ ] **Step 4: Web build smoke (catches App Router / "use client" issues tsc misses)**

Run: `cd web && bun run build && cd ..`
Expected: build succeeds; `/account` compiles as a route.

- [ ] **Step 5: Manual smoke (local), documented for the reviewer**

With local dev running (`bun run dev:web`, `bun run dev:api`), `NEXT_PUBLIC_AUTH_UI_ENABLED=true`, `NEXT_PUBLIC_USER_API_KEYS=true`, `USER_API_KEYS_ENABLED=true` (api `.dev.vars`), and a signed-in verified user:
  1. Visit `/account` → panel renders.
  2. Create a `write` key → full `relu_…` key revealed once; copy works; "I've saved it" dismisses.
  3. List shows the new key (start, scope, created).
  4. Revoke → inline confirm → key disappears.
  5. `curl -s https://api.releases.localhost/v1/tokens/me -H "Authorization: Bearer <key>"` → returns the real key name + your userId as `principalId`.
  6. A public GET with the key (e.g. `/v1/orgs`) succeeds and does NOT decrement the key (read exemption).

- [ ] **Step 6: Final commit (if lint/format changed anything)**

```bash
git add -A
git commit -m "chore(auth): Phase 3 lint/format pass" || echo "nothing to commit"
```

---

## Self-Review notes (coverage map)

- Spec §1 create + scope cap → Task 3. List → Task 4. Delete + ownership → Task 5. `requireSession` + 401/404 → Task 2. CORS carve-out + mount → Task 6.
- Spec §2 public-read metering exemption (`meterUserKeys`) → Task 1.
- Spec §3 `/tokens/me` enrichment → Task 7.
- Spec §4 MCP `scopeError` → Task 8.
- Spec §5 web panel (flag, client, component, page, nav) → Tasks 10–14.
- Spec §6 flags/config + §9 rollout docs → Task 9 (`routing.md` + `.env.example`); the Flagship key + prod flip remain ops (out of code scope).
- Spec §8 testing → tests embedded per task + Task 15 full run.
```
