# Better Auth API Keys — Phase 1 (Server Core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let authenticated users own metered, rate-limited API keys verified on the REST API, by adopting the `@better-auth/api-key` plugin as the system-of-record for user keys (prefix `relu_`) while leaving the existing `relk_` machine-token lane untouched.

**Architecture:** Add the `@better-auth/api-key` plugin to the per-request Better Auth instance in `workers/api`. A new prefix `relu_` routes user keys to `auth.api.verifyApiKey` (metered: per-key rate-limit + `remaining`); the existing `relk_` prefix continues routing to the legacy `verifyApiToken` (unmetered machine lane); the static `RELEASES_API_KEY` stays root. The auth middleware gains a `relu_` branch, memoized per request (so a single request meters exactly once even though `resolveAuth` runs 2–3× per request today). The scope ladder (`read ⊂ write ⊂ admin`) is encoded as cumulative actions on one `api` permission resource, so every existing route guard keeps working unchanged.

**Tech Stack:** Cloudflare Workers, Hono, Better Auth 1.6.14 + `@better-auth/api-key` 1.6.14, Drizzle (D1 / bun:sqlite test fixtures), Bun test, TypeScript strict.

**Scope:** This plan is **Phase 1 of 3** (server core). Phase 2 (MCP enforcement over the `API` service binding) and Phase 3 (web self-serve panel + self-serve scope cap) are scoped at the end and get their own plans — their code depends on the helpers and flag this phase introduces.

---

## File Structure

**Create:**

- `workers/api/migrations/20260604030000_add_api_key.sql` — DDL for the Better Auth `apikey` table.
- `workers/api/src/auth/api-key-scope.ts` — pure scope↔Better-Auth-permission shim (worker-local; keeps the BA-permission shape out of the runtime-neutral `core`).
- `tests/unit/api-key-scope.test.ts` — unit tests for the shim.
- `tests/api/api-key-plugin.test.ts` — Better Auth create+verify integration (test DB).
- `tests/api/user-api-key-auth.test.ts` — middleware `relu_` verify branch (route-level).

**Modify:**

- `workers/api/package.json` — add `@better-auth/api-key` dependency.
- `workers/api/src/db/schema-auth.ts` — add the `apikey` Drizzle table + type.
- `packages/core/src/api-token.ts` — add `USER_API_KEY_PREFIX` (`relu_`) + `isUserApiKeyShaped` (pure, shared; **does not touch** the existing `relk_` machine-lane code).
- `packages/lib/src/flags.ts` — add the `userApiKeysEnabled` flag.
- `workers/api/src/index.ts` — add `USER_API_KEYS_ENABLED` to the `Env` bindings.
- `workers/api/wrangler.jsonc` — add the `USER_API_KEYS_ENABLED` var (prod + staging blocks).
- `workers/api/src/auth/index.ts` — register the `apiKey()` plugin (flag-gated) + add `apikey` to the drizzle adapter schema map.
- `workers/api/src/middleware/auth.ts` — add the `relu_` verify branch, request-memoize `resolveAuth`, map rate-limit → 429.
- `docs/architecture/remote-mode.md` + `AGENTS.md` — document the user-key lane.
- `docs/superpowers/specs/2026-06-04-better-auth-api-keys-design.md` — correct the prefix note to `relu_`.

**Untouched on purpose:** `packages/core-internal/src/api-token-store.ts`, `scripts/mint-token.ts`, the MCP worker, and every existing `relk_` reference/test — the machine lane does not change in Phase 1.

---

## Task 1: Add the `@better-auth/api-key` dependency, the `apikey` table, and its migration

**Files:**

- Modify: `workers/api/package.json`
- Modify: `workers/api/src/db/schema-auth.ts`
- Create: `workers/api/migrations/20260604030000_add_api_key.sql`
- Test: `tests/api/api-key-plugin.test.ts` (table-exists assertion first; full create/verify in Task 5)

- [ ] **Step 1: Add the dependency**

In `workers/api/package.json`, add to `dependencies` (alphabetically, right after the existing `"better-auth": "^1.6.14",` line — keep the same minor as `better-auth`; the plugin's peer range is `better-auth: ^1.6.14`):

```jsonc
"@better-auth/api-key": "^1.6.14",
```

- [ ] **Step 2: Install (worktree needs its own install)**

Run: `bun install`
Expected: lockfile resolves `@better-auth/api-key@1.6.14` sharing `@better-auth/core@1.6.14` (no `better-auth` version change). If it tries to bump `better-auth`, stop and pin exact `1.6.14`.

- [ ] **Step 3: Generate the canonical `apikey` schema to verify column shape**

The exact column set/types for the installed plugin version are authoritative from the Better Auth CLI. After Step 1–2, temporarily register the plugin (you'll formalize this in Task 5) or run the generator against a scratch config, then inspect its output:

Run: `bunx @better-auth/cli@1.6.14 generate --help`
Then generate the schema for an auth config that includes `apiKey()` and read the emitted `apikey` model.
Expected: a table named `apikey` with columns matching Step 4 (id, name, start, prefix, key, referenceId, refillInterval, refillAmount, lastRefillAt, enabled, rateLimitEnabled, rateLimitTimeWindow, rateLimitMax, requestCount, remaining, lastRequest, expiresAt, createdAt, updatedAt, permissions, metadata; plus `configId` if present). **Reconcile Steps 4–5 to the generator output** — if a column name/type differs, the generator wins.

- [ ] **Step 4: Add the Drizzle table**

In `workers/api/src/db/schema-auth.ts`, after the `rateLimit` table (before the `export type` block), add (snake_case columns, Better Auth's canonical Drizzle/SQLite shape — integer timestamp/boolean modes, matching the rest of this file):

```ts
/**
 * Better Auth API key plugin (`@better-auth/api-key`) store — user-owned, metered
 * API keys. `referenceId` is the owning user id (config `references: "user"`).
 * `permissions` is a JSON string encoding the scope ladder as cumulative actions
 * on one `api` resource (see workers/api/src/auth/api-key-scope.ts). The hashed
 * key lives in `key`; `start`/`prefix` are non-secret display aids. Column set is
 * mandated by the plugin — reconcile with `@better-auth/cli generate`. Paired
 * migration: 20260604030000_add_api_key.sql.
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
    enabled: integer("enabled", { mode: "boolean" }),
    rateLimitEnabled: integer("rate_limit_enabled", { mode: "boolean" }),
    rateLimitTimeWindow: integer("rate_limit_time_window"),
    rateLimitMax: integer("rate_limit_max"),
    requestCount: integer("request_count"),
    remaining: integer("remaining"),
    lastRequest: integer("last_request", { mode: "timestamp" }),
    expiresAt: integer("expires_at", { mode: "timestamp" }),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
    permissions: text("permissions"),
    metadata: text("metadata"),
  },
  (t) => [index("idx_apikey_key").on(t.key), index("idx_apikey_reference_id").on(t.referenceId)],
);
```

Then add to the `export type` block at the bottom:

```ts
export type AuthApiKey = typeof apikey.$inferSelect;
```

- [ ] **Step 5: Write the migration**

Create `workers/api/migrations/20260604030000_add_api_key.sql` (mirror Step 4 exactly; reconcile to the generator output from Step 3):

```sql
-- Better Auth API key plugin (@better-auth/api-key) store — user-owned, metered
-- API keys (prefix relu_). Paired with the `apikey` table in
-- workers/api/src/db/schema-auth.ts (the schema↔migration pairing gate in ci.yml
-- watches that file). referenceId = owning user id (config references: "user").
-- permissions is a JSON string encoding the scope ladder as cumulative actions on
-- one `api` resource. Reconcile columns with `@better-auth/cli generate`.
CREATE TABLE apikey (
  id text PRIMARY KEY NOT NULL,
  name text,
  start text,
  prefix text,
  key text NOT NULL,
  reference_id text NOT NULL,
  config_id text,
  refill_interval integer,
  refill_amount integer,
  last_refill_at integer,
  enabled integer,
  rate_limit_enabled integer,
  rate_limit_time_window integer,
  rate_limit_max integer,
  request_count integer,
  remaining integer,
  last_request integer,
  expires_at integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL,
  permissions text,
  metadata text
);
CREATE INDEX idx_apikey_key ON apikey (key);
CREATE INDEX idx_apikey_reference_id ON apikey (reference_id);
```

- [ ] **Step 6: Write the table-exists test**

Create `tests/api/api-key-plugin.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apikey } from "../../workers/api/src/db/schema-auth.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

describe("apikey table", () => {
  it("is created by the migration and is queryable", () => {
    h = createTestDb();
    // No rows yet, but the table must exist (migration applied by the harness).
    const rows = h.db.select().from(apikey).all();
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 7: Run the test to verify it passes**

Run: `bun test tests/api/api-key-plugin.test.ts`
Expected: PASS (the harness applies `20260604030000_add_api_key.sql`; `SELECT` returns `[]`). If FAIL with "no such table: apikey", the migration filename sort or DDL is wrong.

- [ ] **Step 8: Commit**

```bash
git add workers/api/package.json bun.lock workers/api/src/db/schema-auth.ts workers/api/migrations/20260604030000_add_api_key.sql tests/api/api-key-plugin.test.ts
git commit -m "feat(auth): add @better-auth/api-key dep + apikey table + migration"
```

---

## Task 2: Add the `relu_` user-key prefix helpers to core

**Files:**

- Modify: `packages/core/src/api-token.ts`
- Test: `tests/unit/api-token.test.ts` (extend the existing file)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/api-token.test.ts`:

```ts
import {
  USER_API_KEY_PREFIX,
  isUserApiKeyShaped,
  isApiTokenShaped,
} from "@buildinternet/releases-core/api-token";

describe("user API key prefix (relu_)", () => {
  it("recognizes relu_ as a user key, not a machine token", () => {
    expect(USER_API_KEY_PREFIX).toBe("relu_");
    expect(isUserApiKeyShaped("relu_abc123")).toBe(true);
    expect(isApiTokenShaped("relu_abc123")).toBe(false); // machine check is relk_
  });

  it("keeps relk_ as the machine lane, distinct from user keys", () => {
    expect(isUserApiKeyShaped("relk_abc_def")).toBe(false);
    expect(isApiTokenShaped("relk_abc_def")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/api-token.test.ts -t "user API key prefix"`
Expected: FAIL (`USER_API_KEY_PREFIX`/`isUserApiKeyShaped` not exported).

- [ ] **Step 3: Implement the helpers**

In `packages/core/src/api-token.ts`, immediately after the existing `isApiTokenShaped` function (around line 96), add:

```ts
/**
 * Wire prefix for Better Auth-issued, user-owned API keys. Distinct from the
 * machine-lane `API_TOKEN_PREFIX` (`relk_`) so the auth middleware routes a
 * presented credential to exactly one verifier. Set as the plugin's
 * `defaultPrefix` in workers/api/src/auth/index.ts.
 */
export const USER_API_KEY_PREFIX = "relu_";

/** Cheap prefix check routing a credential to the Better Auth verify path. */
export function isUserApiKeyShaped(raw: string): boolean {
  return raw.startsWith(USER_API_KEY_PREFIX);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/api-token.test.ts -t "user API key prefix"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/api-token.ts tests/unit/api-token.test.ts
git commit -m "feat(core): add relu_ user-API-key prefix helpers (machine relk_ unchanged)"
```

---

## Task 3: Scope ↔ Better Auth permission shim

The plugin stores `permissions` as a resource→actions map checked for all-present membership. Encode the ladder as **cumulative** actions on one `api` resource so the stored array (`["read"]` / `["read","write"]` / `["read","write","admin"]`) is itself a valid `scopes` array for the existing `scopeSatisfies`.

**Files:**

- Create: `workers/api/src/auth/api-key-scope.ts`
- Test: `tests/unit/api-key-scope.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/api-key-scope.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import {
  API_PERMISSION_RESOURCE,
  scopeToPermissions,
  apiScopesFromPermissions,
} from "../../workers/api/src/auth/api-key-scope.js";
import { scopeSatisfies } from "@buildinternet/releases-core/api-token";

describe("scopeToPermissions", () => {
  it("expands a ladder scope to cumulative actions on the api resource", () => {
    expect(scopeToPermissions("read")).toEqual({ [API_PERMISSION_RESOURCE]: ["read"] });
    expect(scopeToPermissions("write")).toEqual({ [API_PERMISSION_RESOURCE]: ["read", "write"] });
    expect(scopeToPermissions("admin")).toEqual({
      [API_PERMISSION_RESOURCE]: ["read", "write", "admin"],
    });
  });
});

describe("apiScopesFromPermissions", () => {
  it("reads the api actions back as a scopes array usable by scopeSatisfies", () => {
    const perms = scopeToPermissions("write");
    const scopes = apiScopesFromPermissions(perms);
    expect(scopes).toEqual(["read", "write"]);
    expect(scopeSatisfies(scopes, "write")).toBe(true);
    expect(scopeSatisfies(scopes, "admin")).toBe(false);
  });

  it("returns [] for missing/garbage permissions (caller denies on empty)", () => {
    expect(apiScopesFromPermissions(null)).toEqual([]);
    expect(apiScopesFromPermissions({})).toEqual([]);
    expect(apiScopesFromPermissions({ other: ["read"] })).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/api-key-scope.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the shim**

Create `workers/api/src/auth/api-key-scope.ts`:

```ts
/**
 * Pure shim between the Releases scope ladder (`read ⊂ write ⊂ admin`) and the
 * Better Auth API-key permission model (a flat `resource → actions` map checked
 * for all-present membership). We encode the ladder as CUMULATIVE actions on one
 * `api` resource, so the stored array is itself a valid `scopes` array for
 * `scopeSatisfies`. Worker-local on purpose — keeps the BA-permission shape out
 * of the runtime-neutral, OSS-shared `core` package.
 */
import { type ApiScope } from "@buildinternet/releases-core/api-token";

/** The single permission resource the scope ladder maps onto. */
export const API_PERMISSION_RESOURCE = "api";

const LADDER: Record<ApiScope, string[]> = {
  read: ["read"],
  write: ["read", "write"],
  admin: ["read", "write", "admin"],
};

/** Expand a ladder scope to cumulative permissions. Used at key creation. */
export function scopeToPermissions(scope: ApiScope): Record<string, string[]> {
  return { [API_PERMISSION_RESOURCE]: LADDER[scope] };
}

/**
 * Read a verified key's permissions back into a scopes array. Defensive: a
 * missing map, a non-`api` resource, or a non-array yields `[]` so the caller
 * denies (an empty-scope identity must never authenticate).
 */
export function apiScopesFromPermissions(
  permissions: Record<string, string[]> | null | undefined,
): string[] {
  const actions = permissions?.[API_PERMISSION_RESOURCE];
  return Array.isArray(actions) ? actions.filter((a): a is string => typeof a === "string") : [];
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/api-key-scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/auth/api-key-scope.ts tests/unit/api-key-scope.test.ts
git commit -m "feat(auth): scope<->Better-Auth-permission shim for api keys"
```

---

## Task 4: Add the `userApiKeysEnabled` flag, Env binding, and wrangler vars

**Files:**

- Modify: `packages/lib/src/flags.ts`
- Modify: `workers/api/src/index.ts` (the `Env` bindings, near `API_TOKENS_DISABLED?: string;` at line 218)
- Modify: `workers/api/wrangler.jsonc` (the top-level `vars` and the `env.staging` `vars`)

- [ ] **Step 1: Add the flag to the registry**

In `packages/lib/src/flags.ts`, in the `FLAGS` object right after the `apiTokensDisabled` entry (line 100), add:

```ts
  // Rollout gate (#TBD-issue): the Better Auth user-API-key path. default:false →
  // OFF until the web self-serve panel ships; flip on in BOTH Flagship apps to
  // enable relu_ key verification + (later) self-serve creation. Separate from
  // apiTokensDisabled, which kills the whole token path (both lanes).
  userApiKeysEnabled: {
    key: "user-api-keys-enabled",
    env: "USER_API_KEYS_ENABLED",
    default: false,
  },
```

- [ ] **Step 2: Add the Env binding**

In `workers/api/src/index.ts`, next to `API_TOKENS_DISABLED?: string;` (line 218), add:

```ts
    USER_API_KEYS_ENABLED?: string;
```

- [ ] **Step 3: Add the wrangler vars**

In `workers/api/wrangler.jsonc`, in the top-level `"vars"` block (line ~22) add `"USER_API_KEYS_ENABLED": "false"`, and add the same line to the `"env": { "staging": { "vars": { ... } } }` block (line ~500). Match the existing quoting/trailing-comma style of neighboring vars.

- [ ] **Step 4: Verify type-check passes (no test needed for config)**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS (the new optional binding is recognized; nothing references it yet).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/flags.ts workers/api/src/index.ts workers/api/wrangler.jsonc
git commit -m "feat(flags): add user-api-keys-enabled rollout gate + env binding"
```

> **Manual follow-up (not a code step):** create the `user-api-keys-enabled` key in BOTH Flagship apps (`releases-platform` and `releases-platform-staging`), default OFF, before relying on it in prod.

---

## Task 5: Register the `apiKey()` plugin in `createAuth` (flag-gated) + create/verify test

**Files:**

- Modify: `workers/api/src/auth/index.ts`
- Test: `tests/api/api-key-plugin.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/api/api-key-plugin.test.ts`:

```ts
import { createAuth } from "../../workers/api/src/auth/index.js";
import { user } from "../../workers/api/src/db/schema-auth.js";
import { scopeToPermissions } from "../../workers/api/src/auth/api-key-scope.js";

// Minimal env: not production (top-level auth rate-limit stays off), feature ON,
// a fixed secret so Better Auth doesn't warn. Cast — tests don't need full Env.
function testEnv() {
  return {
    ENVIRONMENT: "test",
    BETTER_AUTH_SECRET: "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    USER_API_KEYS_ENABLED: "true",
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

describe("apiKey plugin create + verify", () => {
  it("creates a relu_ key and verifies it, returning api permissions", async () => {
    h = createTestDb();
    h.db
      .insert(user)
      .values({
        id: "user_test_1",
        name: "Test",
        email: "t@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();

    const auth = await createAuth(testEnv(), undefined, { db: h.db });

    const created = await auth.api.createApiKey({
      body: {
        name: "my key",
        userId: "user_test_1",
        permissions: scopeToPermissions("write"),
      },
    });
    expect(created.key).toMatch(/^relu_/);

    const verified = await auth.api.verifyApiKey({ body: { key: created.key } });
    expect(verified.valid).toBe(true);
    expect(verified.key?.permissions).toEqual(scopeToPermissions("write"));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/api-key-plugin.test.ts -t "create + verify"`
Expected: FAIL (the plugin isn't registered, so `auth.api.createApiKey` is undefined).

- [ ] **Step 3: Register the plugin**

In `workers/api/src/auth/index.ts`:

(a) Add the import after the existing plugin import (line 3):

```ts
import { apiKey } from "@better-auth/api-key";
```

(b) Add the flag + scope-shim imports near the other local imports (after line 11):

```ts
import { FLAGS, flag } from "@releases/lib/flags";
import { scopeToPermissions } from "./api-key-scope.js";
import { apikey } from "../db/schema-auth.js";
```

(c) Add `apikey` to the drizzle adapter schema map (line 375):

```ts
      schema: { user, session, account, verification, rateLimit, apikey },
```

(d) Resolve the flag just before the `plugins` array is built (after the `dashApiKey` line, ~330):

```ts
// User-API-key path (relu_) is a flagged rollout. When off, the plugin (and its
// self-serve endpoints) are simply not registered. Flag order: Flagship → var →
// default(false). Mirrors the middleware gate in middleware/auth.ts.
const userApiKeysOn = await flag(env.FLAGS, env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled);
```

(e) Add the plugin to the `plugins` array (inside the array literal at line 351), gated:

```ts
    ...(userApiKeysOn
      ? [
          apiKey({
            // Public-facing user keys. Distinct prefix from the relk_ machine lane.
            defaultPrefix: "relu_",
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
        ]
      : []),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/api/api-key-plugin.test.ts`
Expected: PASS. If `createApiKey` rejects on a missing column, re-check Task 1 Step 3 (generator reconcile). If `verified.key.permissions` is a JSON string rather than an object, adjust the assertion to `JSON.parse` — and note it for Task 6.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/auth/index.ts tests/api/api-key-plugin.test.ts
git commit -m "feat(auth): register @better-auth/api-key plugin (flag-gated, relu_, metered)"
```

---

## Task 6: Middleware — route `relu_` to Better Auth, memoized per request

`resolveAuth` is called 2–3× per request (rate limiter, the auth middleware, `isValidBearerAuth`). Because `verifyApiKey` meters on every call, the whole resolution is memoized per request via a `WeakMap` keyed on `c.req.raw`, so a `relu_` key is verified+metered exactly once.

**Files:**

- Modify: `workers/api/src/middleware/auth.ts`
- Test: `tests/api/user-api-key-auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/user-api-key-auth.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { Hono } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { createAuth } from "../../workers/api/src/auth/index.js";
import { publicReadAuthMiddleware } from "../../workers/api/src/middleware/auth.js";
import { user } from "../../workers/api/src/db/schema-auth.js";
import { scopeToPermissions } from "../../workers/api/src/auth/api-key-scope.js";
import type { Env } from "../../workers/api/src/index.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

function env() {
  return {
    ENVIRONMENT: "test",
    BETTER_AUTH_SECRET: "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    USER_API_KEYS_ENABLED: "true",
    DB: h!.db,
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

// A tiny app guarding an unsafe (POST) route with the public-read middleware,
// which requires `write` for non-safe methods.
function app() {
  const a = new Hono<Env>();
  a.use("/thing", publicReadAuthMiddleware);
  a.post("/thing", (c) => c.json({ ok: true }));
  return a;
}

async function mintKey(scope: "read" | "write") {
  h!.db
    .insert(user)
    .values({
      id: "user_1",
      name: "T",
      email: "t@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  const auth = await createAuth(env(), undefined, { db: h!.db });
  const created = await auth.api.createApiKey({
    body: { name: "k", userId: "user_1", permissions: scopeToPermissions(scope) },
  });
  return created.key as string;
}

describe("relu_ user key auth on the public-read middleware", () => {
  it("a write key passes a POST (unsafe method requires write)", async () => {
    h = createTestDb();
    const key = await mintKey("write");
    const res = await app().request(
      "/thing",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
      },
      env(),
    );
    expect(res.status).toBe(200);
  });

  it("a read key is rejected on a POST with 403 insufficient_scope", async () => {
    h = createTestDb();
    const key = await mintKey("read");
    const res = await app().request(
      "/thing",
      {
        method: "POST",
        headers: { Authorization: `Bearer ${key}` },
      },
      env(),
    );
    expect(res.status).toBe(403);
  });

  it("a bogus relu_ key is rejected 401", async () => {
    h = createTestDb();
    const res = await app().request(
      "/thing",
      {
        method: "POST",
        headers: { Authorization: "Bearer relu_deadbeefdeadbeef" },
      },
      env(),
    );
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/user-api-key-auth.test.ts`
Expected: FAIL — the write key currently falls through to the static-key path and 401s (no `relu_` branch yet).

- [ ] **Step 3: Add the `relu_` branch + per-request memo**

In `workers/api/src/middleware/auth.ts`:

(a) Extend the core import (lines 4–9) to add `isUserApiKeyShaped`, and add the new imports below the existing ones (after line 12):

```ts
import {
  type ApiScope,
  isApiTokenShaped,
  isUserApiKeyShaped,
  ROOT_SCOPE,
  scopeSatisfies,
} from "@buildinternet/releases-core/api-token";
import { createAuth } from "../auth/index.js";
import { apiScopesFromPermissions } from "../auth/api-key-scope.js";
import { FLAGS, flag } from "@releases/lib/flags";
```

(`FLAGS, flag` are already imported at line 2 — merge, don't duplicate.)

(b) Add a verify helper above `resolveAuth` (after line 33). It builds a per-request Better Auth instance and verifies a `relu_` key, surfacing rate-limit rejections:

```ts
/**
 * Verify a `relu_` user key via Better Auth. Returns the resolved scopes (the
 * cumulative `api` permission actions) on success. `rateLimited` lets the caller
 * answer 429 instead of a generic 401. Builds a per-request auth instance; the
 * surrounding `resolveAuth` memo ensures this runs (and meters) at most once.
 */
async function verifyUserKey(
  c: Context<Env>,
  presented: string,
): Promise<{ ok: true; scopes: string[] } | { ok: false; rateLimited: boolean }> {
  let waitUntil: ((p: Promise<unknown>) => void) | undefined;
  try {
    waitUntil = c.executionCtx.waitUntil.bind(c.executionCtx);
  } catch {
    waitUntil = undefined;
  }
  const auth = await createAuth(c.env, waitUntil);
  const result = await auth.api.verifyApiKey({ body: { key: presented } });
  if (result.valid && result.key) {
    const scopes = apiScopesFromPermissions(
      result.key.permissions as Record<string, string[]> | null | undefined,
    );
    if (scopes.length > 0) return { ok: true, scopes };
    return { ok: false, rateLimited: false };
  }
  const code = result.error?.code ?? "";
  return { ok: false, rateLimited: /rate.?limit/i.test(code) };
}
```

(c) Add the `relu_` branch at the top of `resolveAuth` (before the `isApiTokenShaped` check at line 41). Note the new `rate_limited` resolved kind:

```ts
if (isUserApiKeyShaped(presented)) {
  if (await flag(c.env.FLAGS, c.env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled))
    return { kind: "none", skip: false };
  if (!(await flag(c.env.FLAGS, c.env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled)))
    return { kind: "none", skip: false };
  const v = await verifyUserKey(c, presented);
  if (v.ok) return { kind: "token", tokenId: presented.slice(0, 12), scopes: v.scopes };
  return v.rateLimited ? { kind: "rate_limited" } : { kind: "none", skip: false };
}
```

(d) Extend the `ResolvedAuth` union (line 24) with the rate-limited kind:

```ts
type ResolvedAuth =
  | { kind: "root"; scopes: string[] }
  | { kind: "token"; tokenId: string; scopes: string[] }
  | { kind: "rate_limited" }
  | { kind: "none"; skip: boolean };
```

(e) Wrap `resolveAuth`'s body in a per-request memo. Rename the current function to `resolveAuthUncached` and add a memoizing wrapper above it:

```ts
const RESOLVE_MEMO = new WeakMap<Request, Promise<ResolvedAuth>>();

/**
 * Memoize resolution per request. `resolveAuth` runs 2–3× per request (rate
 * limiter, auth middleware, isValidBearerAuth); Better Auth's verifyApiKey
 * meters on every call, so without this a single request would meter a relu_
 * key multiple times. Keyed on the underlying Request (stable per request,
 * WeakMap auto-GCs). `presented` is derived from the same request, so it's
 * constant across callers.
 */
function resolveAuth(c: Context<Env>, presented: string): Promise<ResolvedAuth> {
  const key = c.req.raw;
  const cached = RESOLVE_MEMO.get(key);
  if (cached) return cached;
  const p = resolveAuthUncached(c, presented);
  RESOLVE_MEMO.set(key, p);
  return p;
}
```

(Rename the existing `async function resolveAuth(...)` at line 40 to `async function resolveAuthUncached(...)`.)

(f) Handle the new `rate_limited` kind everywhere `resolveAuth`'s result is consumed:

- In `resolveAuthIdentity` (line 66): `return auth.kind === "root" || auth.kind === "token" ? auth : null;` (rate-limited is not a usable identity for the limiter).
- In `isValidBearerAuth` (lines 88–90): unchanged — only `root`/`token` return true; `rate_limited` falls through to `return false`.
- In the public-read branch of `createAuthMiddleware` (line 187): `if (auth.kind === "root" || auth.kind === "token") recordAuth(c, auth);` — don't record a rate-limited result, but also surface it (see Task 7). For now, leave the read public (an over-limit key on a public GET still reads).
- In the gated branch (line 196 onward): add a 429 before the `none` handling (implemented in Task 7).

For this task, make the gated branch treat `rate_limited` as a rejection so the bogus-key/scope tests pass; the precise 429 shape comes in Task 7. Insert before the `if (auth.kind === "none")` block:

```ts
if (auth.kind === "rate_limited") {
  return c.json({ error: "rate_limited", message: "API key rate limit exceeded" }, 429);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/api/user-api-key-auth.test.ts`
Expected: PASS (write→200, read→403, bogus→401).

- [ ] **Step 5: Run the full auth/token suite to confirm no regression on the machine lane**

Run: `bun test tests/api/auth-tokens.test.ts tests/api/api-tokens-route.test.ts tests/api/resolve-auth-identity.test.ts tests/api/token-store.test.ts tests/api/tokens-me-middleware.test.ts tests/api/rate-limit.test.ts`
Expected: PASS — `relk_` behavior is unchanged.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/middleware/auth.ts tests/api/user-api-key-auth.test.ts
git commit -m "feat(auth): verify relu_ user keys in middleware, memoized to meter once"
```

---

## Task 7: Map per-key rate-limit exhaustion to HTTP 429

Task 6 already returns 429 for the gated path when `resolveAuth` yields `rate_limited`. This task adds an explicit test pinning the behavior and confirms the rate-limit metering actually trips.

**Files:**

- Test: `tests/api/user-api-key-auth.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/api/user-api-key-auth.test.ts`:

```ts
import { createApiKeyWithLimit } from "./helpers/api-key-rate-limit.js"; // inline below if no helpers dir

describe("relu_ key rate limiting", () => {
  it("returns 429 once the per-key request budget is exhausted", async () => {
    h = createTestDb();
    h.db
      .insert(user)
      .values({
        id: "user_1",
        name: "T",
        email: "t@example.com",
        emailVerified: true,
        createdAt: new Date(),
        updatedAt: new Date(),
      })
      .run();
    const auth = await createAuth(env(), undefined, { db: h.db });
    // Per-key override: 1 request per hour, write scope.
    const created = await auth.api.createApiKey({
      body: {
        name: "tight",
        userId: "user_1",
        permissions: scopeToPermissions("write"),
        rateLimitEnabled: true,
        rateLimitMax: 1,
        rateLimitTimeWindow: 1000 * 60 * 60,
      },
    });
    const key = created.key as string;
    const once = await app().request(
      "/thing",
      { method: "POST", headers: { Authorization: `Bearer ${key}` } },
      env(),
    );
    expect(once.status).toBe(200);
    const twice = await app().request(
      "/thing",
      { method: "POST", headers: { Authorization: `Bearer ${key}` } },
      env(),
    );
    expect(twice.status).toBe(429);
  });
});
```

(Delete the unused `createApiKeyWithLimit` import line — it's illustrative; the test creates the key inline.)

- [ ] **Step 2: Run the test**

Run: `bun test tests/api/user-api-key-auth.test.ts -t "rate limiting"`
Expected: First request 200, second 429. If the second is 401 (not 429), the plugin's rate-limit error `code` doesn't match `/rate.?limit/i` — inspect the actual `result.error.code` (log it in `verifyUserKey` temporarily) and widen the check in Task 6 Step 3(b) to the exact code string. Re-run.

- [ ] **Step 3: Commit**

```bash
git add tests/api/user-api-key-auth.test.ts workers/api/src/middleware/auth.ts
git commit -m "test(auth): pin relu_ per-key rate-limit -> 429 mapping"
```

---

## Task 8: Documentation + spec correction

**Files:**

- Modify: `docs/architecture/remote-mode.md` (the Auth model section)
- Modify: `AGENTS.md` (the scoped-API-tokens conventions one-liner)
- Modify: `docs/superpowers/specs/2026-06-04-better-auth-api-keys-design.md` (prefix note → `relu_`)

- [ ] **Step 1: Update remote-mode.md**

In `docs/architecture/remote-mode.md`, in the auth-model section that currently describes `relk_` scoped tokens, add a paragraph:

```markdown
**User API keys (`relu_`).** Logged-in users own metered, rate-limited API keys
issued by the Better Auth `@better-auth/api-key` plugin (the `apikey` table),
distinct from the `relk_` machine lane. The auth middleware routes `relu_` →
`auth.api.verifyApiKey` (per-key rate-limit + `remaining`, deferred via
`waitUntil`); the scope ladder is encoded as cumulative actions on one `api`
permission resource, so route guards are unchanged. Gated by the
`user-api-keys-enabled` flag; rate-limit exhaustion → HTTP 429. Verification is
memoized per request so a single request meters exactly once.
```

- [ ] **Step 2: Update the AGENTS.md conventions line**

In `AGENTS.md`, extend the "Scoped API tokens" bullet with a clause:

```markdown
User-owned **API keys** use the Better Auth `@better-auth/api-key` plugin (prefix `relu_`, `apikey` table, per-key rate-limit + metering), gated by `user-api-keys-enabled`; the `relk_` lane stays for machine principals. See [remote-mode.md → Auth model](docs/architecture/remote-mode.md).
```

- [ ] **Step 3: Correct the spec prefix note**

In `docs/superpowers/specs/2026-06-04-better-auth-api-keys-design.md`, update §1 (and the decisions table "Key prefix" row) so user keys are `relu_` and the machine lane keeps `relk_` unchanged (reflecting the approved low-churn decision). Replace the "Key format note" paragraph's `relk_` user-key references with `relu_`.

- [ ] **Step 4: Commit**

```bash
git add docs/architecture/remote-mode.md AGENTS.md docs/superpowers/specs/2026-06-04-better-auth-api-keys-design.md
git commit -m "docs(auth): document relu_ user API key lane; correct spec prefix note"
```

---

## Task 9: Full verification gate

- [ ] **Step 1: Type-check the whole repo**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit)`
Expected: PASS, no errors.

- [ ] **Step 2: Run the full test suite**

Run: `bun test`
Expected: PASS. (If the monorepo `packages/` mock-leak surfaces, run `bun test tests/` and the `packages/` suites separately, per AGENTS.md.)

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: PASS. Run `bun run format` if format:check flags the new files.

- [ ] **Step 4: Confirm the migration applies to a fresh local D1**

Run: `bun run db:reset:local`
Expected: all migrations apply cleanly, including `20260604030000_add_api_key.sql` (the `apikey` table is created).

- [ ] **Step 5: Final commit (if any format/lint fixes were applied)**

```bash
git add -A
git commit -m "chore(auth): lint/format pass for api-key phase 1"
```

---

## Self-Review

**1. Spec coverage (Phase 1 scope):**

- Adopt plugin as system-of-record for user keys → Tasks 1, 5. ✓
- Per-key rate limiting → Task 5 (plugin config) + Task 7 (429 mapping). ✓
- Usage quotas / metering (`remaining`/`refill`) → Task 5 (plugin enables them; per-key overrides at create). ✓
- Preserve scope semantics / route guards unchanged → Task 3 (cumulative permissions) + Task 6 (scopes from permissions feed the existing `scopeSatisfies`). ✓
- `relu_` user prefix, `relk_` machine lane untouched → Tasks 2, 6 (+ explicit "untouched" note). ✓
- Meter-once at the API layer → Task 6 (per-request `WeakMap` memo). ✓
- `deferUpdates` on the existing `backgroundTasks` → Task 5. ✓
- Flags/schema/migration → Tasks 1, 4. ✓
- Static root unaffected → unchanged code path; verified by Task 6 Step 5. ✓
- **Deferred to later phases (named):** MCP enforcement (Phase 2), web self-serve panel + self-serve `admin`-cap enforcement (Phase 3). The cap matters only at the session-gated create boundary, which the web panel introduces; the flag stays OFF in prod until Phase 3 ships (rollout step ordering).

**2. Placeholder scan:** Two `#TBD-issue` markers (Task 4 flag comment) — these are issue-number references to fill at PR time, not logic gaps. Task 1 Step 3 and Task 6 Step 3(b) Step-4 notes are real verification/branch instructions (reconcile generated schema; confirm rate-limit error code), each with the exact action to take — not deferred work.

**3. Type consistency:** `scopeToPermissions`/`apiScopesFromPermissions`/`API_PERMISSION_RESOURCE` (Task 3) are used identically in Tasks 5 and 6. `ResolvedAuth` gains `{ kind: "rate_limited" }` (Task 6d) and every consumer is updated (Task 6f). `USER_API_KEY_PREFIX`/`isUserApiKeyShaped` (Task 2) used in Task 6. `FLAGS.userApiKeysEnabled` (Task 4) used in Tasks 5 and 6. The `apikey` table export (Task 1) is imported in Tasks 5 and the tests.

**Open verification risks (call out at execution, don't guess):**

- Exact `apikey` columns/types for 1.6.14 — resolved by the `@better-auth/cli generate` reconcile in Task 1 Step 3.
- The plugin's rate-limit `error.code` string — resolved by the inspect-and-widen note in Task 7 Step 2.
- Whether `verifyApiKey` returns `permissions` as an object vs a JSON string — resolved by the assertion note in Task 5 Step 4 (and `apiScopesFromPermissions` should then parse if needed).

---

## Follow-on plans (own specs/plans, after Phase 1 lands)

**Phase 2 — MCP enforcement.** Route `relu_` user keys in `workers/mcp/src/auth.ts`: native MCP tools (no API-worker call, e.g. `summarize_changes`/`compare_products`) verify+meter via a new **`API`-binding-only** `verifyApiKey` endpoint on the API worker; forwarding tools (`maybeLookup` → `/v1/lookups`) forward the user key and let the API worker meter once. Classify every MCP tool native-vs-forwarding (the §4 checklist in the spec). Keep `relk_` machine + static root local/unmetered. Tests assert the meter-once invariant (native once; forwarding once at the API worker, not twice).

**Phase 3 — Web self-serve panel + scope cap.** Add the `@better-auth/api-key/client` `apiKeyClient()` to the web auth client; build the account-settings "API Keys" panel (list / create read|write with reveal-once / revoke) against `api.releases.sh/api/auth/*`. Enforce the **self-serve scope cap** server-side (a create hook/validator that rejects `admin` permissions from the session-gated create path). Only after this ships does rollout flip `user-api-keys-enabled` ON in prod.

---

## Execution Handoff

(filled in by the brainstorming/writing-plans flow after save)
