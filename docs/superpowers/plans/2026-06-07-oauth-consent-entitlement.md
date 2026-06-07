# OAuth Consent UI + Per-User Scope Entitlement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the OAuth AS able to complete a human `authorization_code` + PKCE flow: a per-user scope-entitlement model (via the Better Auth `admin` plugin role) enforced fail-closed at the AS, plus the `/oauth/consent` web page.

**Architecture:** Adopt the core `admin` plugin in `createAuth` (adds a `role` column to `user`; roles `user`/`curator`/`admin` reuse Better Auth's built-in `adminAc`/`userAc`). A pure `entitlement.ts` module maps `role` → grantable OAuth scopes. Enforcement is two-layer: a `hooks.before` gate on `/oauth2/consent` (early reject) and a `customAccessTokenClaims` backstop that re-checks at every user-token issuance and stamps the role claim. The foundation's relative `loginPage`/`consentPage` are corrected to absolute web-origin URLs. The consent page lives in the Next.js web app and drives the flow via the `oauthProviderClient()` browser plugin.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Workers + Hono, Drizzle ORM over D1, Better Auth (`better-auth` ^1.6.14 core incl. `admin` plugin, `@better-auth/oauth-provider` ^1.6.14), Next.js (App Router) + Tailwind v4, bun:test.

**Reference spec:** `docs/superpowers/specs/2026-06-07-oauth-consent-entitlement-design.md`

---

## File Structure

| File                                                         | Responsibility                                                                                                                                          | Action |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| `workers/api/src/auth/entitlement.ts`                        | Pure entitlement helpers: `IDENTITY_SCOPES`, `ROLE_LADDER`, `entitledScopes`, `assertScopesEntitled`, `oauthAccessTokenClaims`, `consentScopeViolation` | Create |
| `workers/api/test/oauth-entitlement.test.ts`                 | Unit tests for the entitlement helpers + wiring assertions                                                                                              | Create |
| `workers/api/src/db/schema-auth.ts`                          | Add `role`/`banned`/`banReason`/`banExpires` to `user`; `impersonatedBy` to `session`                                                                   | Modify |
| `workers/api/migrations/20260607010000_add_admin_plugin.sql` | Paired DDL (5 `ALTER TABLE ADD COLUMN`)                                                                                                                 | Create |
| `workers/api/src/index.ts`                                   | Add `OAUTH_ADMIN_USER_IDS` to the `Bindings` interface                                                                                                  | Modify |
| `workers/api/src/auth/index.ts`                              | `oauthAdminUserIds` helper; register `admin()`; `hooks.before` consent gate; `customAccessTokenClaims` + absolute `loginPage`/`consentPage`             | Modify |
| `web/src/lib/entitlement.ts`                                 | Web mirror: `IDENTITY_SCOPES`, `ROLE_LADDER`, `SCOPE_LABELS`, `entitledScopes`, `displayScopes`                                                         | Create |
| `web/src/lib/entitlement.test.ts`                            | Unit test for `displayScopes`                                                                                                                           | Create |
| `web/src/lib/auth-client.ts`                                 | Register `oauthProviderClient()`                                                                                                                        | Modify |
| `web/src/components/oauth-consent-form.tsx`                  | `"use client"` consent form                                                                                                                             | Create |
| `web/src/app/oauth/consent/page.tsx`                         | Consent route (gated, renders the form)                                                                                                                 | Create |

**Note on the entitlement mirror:** `ROLE_LADDER`/`IDENTITY_SCOPES` are duplicated in `web/src/lib/entitlement.ts` because the web app and the API worker do not share a runtime module (the web app is a separate Next.js build). The API copy is the security boundary; the web copy is display-only (it filters which scopes the consent page shows). Both are tiny constants — keep them in sync.

---

## Task 1: Entitlement helpers (pure module + unit tests)

**Files:**

- Create: `workers/api/src/auth/entitlement.ts`
- Create: `workers/api/test/oauth-entitlement.test.ts`

- [ ] **Step 1: Write the failing unit test**

Create `workers/api/test/oauth-entitlement.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import {
  IDENTITY_SCOPES,
  ROLE_LADDER,
  entitledScopes,
  assertScopesEntitled,
  oauthAccessTokenClaims,
  consentScopeViolation,
} from "../src/auth/entitlement.js";

describe("entitledScopes", () => {
  it("gives identity + read to a plain user", () => {
    expect(entitledScopes("user")).toEqual([...IDENTITY_SCOPES, "read"]);
  });
  it("gives read+write to a curator", () => {
    expect(entitledScopes("curator")).toEqual([...IDENTITY_SCOPES, "read", "write"]);
  });
  it("gives the full ladder to an admin", () => {
    expect(entitledScopes("admin")).toEqual([...IDENTITY_SCOPES, "read", "write", "admin"]);
  });
  it("fails closed for null/unknown roles → read-only", () => {
    expect(entitledScopes(null)).toEqual([...IDENTITY_SCOPES, "read"]);
    expect(entitledScopes(undefined)).toEqual([...IDENTITY_SCOPES, "read"]);
    expect(entitledScopes("wizard")).toEqual([...IDENTITY_SCOPES, "read"]);
  });
  it("unions ladders for a comma-separated multi-role", () => {
    expect(entitledScopes("user,curator")).toEqual([...IDENTITY_SCOPES, "read", "write"]);
  });
});

describe("assertScopesEntitled", () => {
  it("passes when requested ⊆ entitled", () => {
    expect(() => assertScopesEntitled("curator", ["openid", "read", "write"])).not.toThrow();
  });
  it("throws when a user requests write", () => {
    expect(() => assertScopesEntitled("user", ["read", "write"])).toThrow(/write/);
  });
  it("allows identity scopes for everyone", () => {
    expect(() => assertScopesEntitled("user", [...IDENTITY_SCOPES])).not.toThrow();
  });
});

describe("oauthAccessTokenClaims", () => {
  it("stamps the role claim for a user-bound token", () => {
    expect(
      oauthAccessTokenClaims({ user: { role: "curator" }, scopes: ["read", "write"] }),
    ).toEqual({
      "https://releases.sh/role": "curator",
    });
  });
  it("defaults the role claim to user when role is absent", () => {
    expect(oauthAccessTokenClaims({ user: { role: null }, scopes: ["read"] })).toEqual({
      "https://releases.sh/role": "user",
    });
  });
  it("throws (fail-closed) when a user-bound token exceeds entitlement", () => {
    expect(() =>
      oauthAccessTokenClaims({ user: { role: "user" }, scopes: ["read", "admin"] }),
    ).toThrow();
  });
  it("skips the entitlement check for M2M tokens (user undefined)", () => {
    expect(oauthAccessTokenClaims({ scopes: ["read", "write", "admin"] })).toEqual({});
  });
  it("denies a deleted user (user null) beyond read", () => {
    expect(() => oauthAccessTokenClaims({ user: null, scopes: ["write"] })).toThrow();
  });
});

describe("consentScopeViolation", () => {
  it("flags a user granting write", () => {
    expect(consentScopeViolation("user", { accept: true, scope: "read write" })).toBe(true);
  });
  it("passes a curator granting read+write", () => {
    expect(consentScopeViolation("curator", { accept: true, scope: "openid read write" })).toBe(
      false,
    );
  });
  it("ignores deny submissions", () => {
    expect(consentScopeViolation("user", { accept: false, scope: "read write" })).toBe(false);
  });
  it("passes when scope is omitted (token backstop catches over-broad)", () => {
    expect(consentScopeViolation("user", { accept: true })).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts`
Expected: FAIL — `../src/auth/entitlement.js` does not exist.

- [ ] **Step 3: Implement the module**

Create `workers/api/src/auth/entitlement.ts`:

```ts
/**
 * Per-user OAuth scope entitlement. A plain scope map keyed by the Better Auth
 * `admin`-plugin `role` — NOT the access-control (`createAccessControl`) system,
 * which governs admin-plugin endpoints, not OAuth scopes. This module is the
 * single security boundary for "which scopes may this user consent to / hold":
 * the consent gate (`hooks.before`) and the token-issuance backstop
 * (`customAccessTokenClaims`) both route through it. Pure + dependency-free so it
 * is exhaustively unit-testable. Fail-closed: an unknown/missing role → read-only.
 * A web-display mirror lives in web/src/lib/entitlement.ts — keep them in sync.
 */

/** Identity scopes everyone who signs in may grant. */
export const IDENTITY_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

/** API scope ladder per role. Cumulative (read ⊂ write ⊂ admin). */
export const ROLE_LADDER: Record<string, readonly string[]> = {
  user: ["read"],
  curator: ["read", "write"],
  admin: ["read", "write", "admin"],
};

/** Scopes a user with `role` may consent to / hold. Unknown/null → read-only (fail-closed). */
export function entitledScopes(role: string | null | undefined): string[] {
  // `role` may be a comma-separated multi-role string (admin-plugin convention).
  const roles = (role ?? "user")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const ladder = new Set<string>();
  for (const r of roles) for (const s of ROLE_LADDER[r] ?? ROLE_LADDER.user) ladder.add(s);
  if (ladder.size === 0) for (const s of ROLE_LADDER.user) ladder.add(s);
  return [...IDENTITY_SCOPES, ...ladder];
}

/** Throws if any requested scope exceeds the role's entitlement. */
export function assertScopesEntitled(role: string | null | undefined, requested: string[]): void {
  const allowed = new Set(entitledScopes(role));
  const forbidden = requested.filter((s) => !allowed.has(s));
  if (forbidden.length) {
    throw new Error(`scopes not entitled for role ${role ?? "user"}: ${forbidden.join(", ")}`);
  }
}

/**
 * `oauthProvider.customAccessTokenClaims` body. Runs at every JWT access-token
 * issuance (authorization_code, refresh_token re-issue, client_credentials) and
 * introspection. For a user-bound token it re-asserts the live entitlement
 * ceiling — covering skip_consent clients, refresh replay, and role downgrades —
 * and stamps the role claim. `user === undefined` means M2M (client_credentials),
 * where no per-user ceiling applies → skip. `user === null` means a deleted user
 * → falls through to the read-only ceiling (fail-closed).
 */
export function oauthAccessTokenClaims(info: {
  user?: { role?: string | null } | null;
  scopes?: string[];
}): Record<string, string> {
  const { user, scopes } = info;
  if (user !== undefined) assertScopesEntitled(user?.role, scopes ?? []);
  return user ? { "https://releases.sh/role": user.role ?? "user" } : {};
}

/**
 * True when a `/oauth2/consent` submission grants scopes beyond the user's
 * entitlement. Best-effort early gate: a deny (`accept !== true`) or an omitted
 * `scope` (the plugin then grants all originally-requested scopes) returns false
 * — the token-issuance backstop above is the authoritative guarantee.
 */
export function consentScopeViolation(
  role: string | null | undefined,
  body: { accept?: unknown; scope?: unknown } | undefined,
): boolean {
  if (!body || body.accept !== true) return false;
  const scope = typeof body.scope === "string" ? body.scope : "";
  if (!scope) return false;
  const requested = scope.split(/\s+/).filter(Boolean);
  try {
    assertScopesEntitled(role, requested);
    return false;
  } catch {
    return true;
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/auth/entitlement.ts workers/api/test/oauth-entitlement.test.ts
git commit -m "feat(api): per-user OAuth scope entitlement helpers"
```

---

## Task 2: Admin-plugin columns + paired migration

**Files:**

- Modify: `workers/api/src/db/schema-auth.ts`
- Create: `workers/api/migrations/20260607010000_add_admin_plugin.sql`
- Test: `workers/api/test/oauth-entitlement.test.ts` (append)

> **Field-name discipline:** the camelCase JS keys (`role`, `banned`, `banReason`, `banExpires`, `impersonatedBy`) MUST equal the admin plugin's schema field names or the Drizzle adapter cannot resolve them. They were confirmed against the installed `better-auth/dist/plugins/admin/schema.mjs`. SQL column names are snake_case (repo convention). `role` has no schema default (the plugin stamps `"user"` at runtime) → nullable column.

- [ ] **Step 1: Write the failing schema round-trip test**

Append to `workers/api/test/oauth-entitlement.test.ts`:

```ts
import { createTestDb } from "./setup";
import { user as userTable, session as sessionTable } from "../src/db/schema-auth.js";

describe("admin-plugin schema", () => {
  it("user.role + ban fields round-trip through drizzle", async () => {
    const db = createTestDb();
    await db.insert(userTable).values({
      id: "u_1",
      name: "Curator",
      email: "curator@example.com",
      emailVerified: true,
      role: "curator",
      banned: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const rows = await db.select().from(userTable);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.role).toBe("curator");
    expect(rows[0]?.banned).toBe(false);
  });

  it("session.impersonatedBy column exists", async () => {
    const db = createTestDb();
    await db.insert(userTable).values({
      id: "u_2",
      name: "U",
      email: "u2@example.com",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await db.insert(sessionTable).values({
      id: "s_1",
      userId: "u_2",
      token: "tok_1",
      expiresAt: new Date(Date.now() + 3_600_000),
      impersonatedBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const rows = await db.select().from(sessionTable);
    expect(rows[0]?.impersonatedBy ?? null).toBeNull();
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts`
Expected: FAIL — `role`/`banned`/`impersonatedBy` are not columns on the tables.

- [ ] **Step 3: Add the columns to `schema-auth.ts`**

In `workers/api/src/db/schema-auth.ts`, extend the `user` table object (add after `lastActiveAt`, before the closing `}`):

```ts
  // Better Auth `admin` plugin (better-auth/plugins). `role` drives the OAuth
  // scope-entitlement ceiling (see auth/entitlement.ts). No schema default — the
  // plugin stamps "user" on new sign-ups at runtime; existing rows stay NULL,
  // which entitledScopes() treats as read-only (fail-closed). Multi-role is a
  // comma-separated string. Paired migration: 20260607010000_add_admin_plugin.sql.
  role: text("role"),
  banned: integer("banned", { mode: "boolean" }),
  banReason: text("ban_reason"),
  banExpires: integer("ban_expires", { mode: "timestamp" }),
```

Extend the `session` table object (add after `updatedAt`, before the index callback / closing `}`):

```ts
    // Better Auth `admin` plugin — set when this session is an admin impersonating a user.
    impersonatedBy: text("impersonated_by"),
```

- [ ] **Step 4: Write the paired migration**

Create `workers/api/migrations/20260607010000_add_admin_plugin.sql`:

```sql
-- Better Auth `admin` plugin (better-auth/plugins) columns. Paired with the
-- role/banned/banReason/banExpires (user) + impersonatedBy (session) fields in
-- workers/api/src/db/schema-auth.ts (the schema↔migration pairing gate in ci.yml
-- watches that file). `role` is nullable (no default): the plugin stamps "user"
-- on new sign-ups at runtime; existing rows stay NULL → read-only (fail-closed).
-- `banned` is integer (boolean mode); ban_expires is integer epoch ms (timestamp).
ALTER TABLE user ADD COLUMN role text;
ALTER TABLE user ADD COLUMN banned integer;
ALTER TABLE user ADD COLUMN ban_reason text;
ALTER TABLE user ADD COLUMN ban_expires integer;
ALTER TABLE session ADD COLUMN impersonated_by text;
```

- [ ] **Step 5: Run the schema test to verify it passes**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts`
Expected: PASS. (If the test DB snapshot is cached stale, re-run once on a fresh process so the new migration is applied.)

- [ ] **Step 6: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/db/schema-auth.ts workers/api/migrations/20260607010000_add_admin_plugin.sql workers/api/test/oauth-entitlement.test.ts
git commit -m "feat(api): add admin-plugin role + ban columns and migration"
```

---

## Task 3: Register the `admin` plugin + bootstrap binding

**Files:**

- Modify: `workers/api/src/index.ts` (add `OAUTH_ADMIN_USER_IDS` to `Bindings`)
- Modify: `workers/api/src/auth/index.ts` (`oauthAdminUserIds` helper + `admin()` plugin)
- Test: `workers/api/test/oauth-entitlement.test.ts` (append)

- [ ] **Step 1: Write the failing `oauthAdminUserIds` + wiring tests**

Append to `workers/api/test/oauth-entitlement.test.ts`:

```ts
import { oauthAdminUserIds, createAuth } from "../src/auth/index.js";

describe("oauthAdminUserIds", () => {
  it("parses a comma-separated list, trimming blanks", () => {
    expect(oauthAdminUserIds({ OAUTH_ADMIN_USER_IDS: "u_1, u_2 ,, u_3" } as never)).toEqual([
      "u_1",
      "u_2",
      "u_3",
    ]);
  });
  it("returns [] when unset", () => {
    expect(oauthAdminUserIds({} as never)).toEqual([]);
  });
});

const wiringEnv = {
  BETTER_AUTH_URL: "https://api.releases.localhost",
  BETTER_AUTH_SECRET: "test-secret-do-not-use-in-prod-0123456789",
  WEB_BASE_URL: "https://releases.localhost",
} as never;

describe("admin plugin wiring", () => {
  it("registers the admin plugin", async () => {
    const auth = await createAuth(wiringEnv, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    const ids = (auth.options.plugins ?? []).map((p: { id: string }) => p.id);
    expect(ids.some((id: string) => /admin/i.test(id))).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts`
Expected: FAIL — `oauthAdminUserIds` is not exported / admin plugin not registered.

- [ ] **Step 3: Add the `OAUTH_ADMIN_USER_IDS` binding type**

In `workers/api/src/index.ts`, inside the `Bindings` interface (near `OAUTH_RESOURCE_AUDIENCES`), add:

```ts
    // Comma-separated Better Auth user IDs treated as admin regardless of their DB
    // `role` (admin-plugin `adminUserIds`). Bootstrap only: it unlocks the first
    // admin so they can `setRole` others; OAuth entitlement reads the persisted
    // `role` column, not this list. Operator-set; unset → no bootstrap admin.
    OAUTH_ADMIN_USER_IDS?: string;
```

- [ ] **Step 4: Add the `oauthAdminUserIds` helper**

In `workers/api/src/auth/index.ts`, add near `oauthValidAudiences` (pure + exported for testing):

```ts
/**
 * Better Auth `admin`-plugin `adminUserIds`: user IDs treated as admin regardless
 * of their DB `role`. Bootstrap seam for the first admin (who then `setRole`s
 * others) — OAuth scope entitlement reads the persisted `role` column, not this
 * list. Parses the comma-separated OAUTH_ADMIN_USER_IDS var. Pure + exported for testing.
 */
export function oauthAdminUserIds(env: Bindings): string[] {
  return (env.OAUTH_ADMIN_USER_IDS ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
}
```

- [ ] **Step 5: Import + register the `admin` plugin**

In `workers/api/src/auth/index.ts`:

(a) Extend the core-plugin import (add `admin`) and import the built-in roles:

```ts
import { oneTap, magicLink, deviceAuthorization, bearer, jwt, admin } from "better-auth/plugins";
import { adminAc, userAc } from "better-auth/plugins/admin/access";
```

(b) Add `admin()` to the `plugins` array (always-on). Place it immediately after the `oauthProvider({...})` block:

```ts
    // Better Auth admin plugin — adds the `role` column that drives OAuth scope
    // entitlement (auth/entitlement.ts). Reuses the built-in admin/user roles;
    // `curator` mirrors `user` for admin-plugin permissions (NO user-management
    // powers) — its only meaning is the OAuth scope ceiling. `adminUserIds`
    // bootstraps the first admin (then they setRole others). Always-on, no flag.
    admin({
      roles: { admin: adminAc, user: userAc, curator: userAc },
      adminRoles: ["admin"],
      defaultRole: "user",
      adminUserIds: oauthAdminUserIds(env),
    }),
```

- [ ] **Step 6: Run the wiring test to verify it passes**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts`
Expected: PASS.

- [ ] **Step 7: Type-check + regression**

Run: `cd workers/api && npx tsc --noEmit && bun test test/auth.test.ts test/oauth-provider.test.ts`
Expected: PASS (the admin columns are now on `user`/`session`; existing auth + oauth-provider tests still green).

- [ ] **Step 8: Commit**

```bash
git add workers/api/src/index.ts workers/api/src/auth/index.ts workers/api/test/oauth-entitlement.test.ts
git commit -m "feat(api): register admin plugin (roles + adminUserIds bootstrap)"
```

---

## Task 4: Consent gate + token-issuance backstop

**Files:**

- Modify: `workers/api/src/auth/index.ts` (`hooks.before` + `oauthProvider.customAccessTokenClaims`)
- Test: `workers/api/test/oauth-entitlement.test.ts` (append)

The pure logic (`consentScopeViolation`, `oauthAccessTokenClaims`) is already covered in Task 1. This task wires it in and asserts the wiring; the full interactive consent path is verified by the staging smoke (Task 10).

- [ ] **Step 1: Write the failing wiring test**

Append to `workers/api/test/oauth-entitlement.test.ts`:

```ts
describe("consent gate + claims wiring", () => {
  it("registers a before-hook on the auth instance", async () => {
    const auth = await createAuth(wiringEnv, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    expect(typeof auth.options.hooks?.before).toBe("function");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts`
Expected: FAIL — `auth.options.hooks?.before` is undefined.

- [ ] **Step 3: Import the entitlement seams**

In `workers/api/src/auth/index.ts`, add to the imports (`createAuthMiddleware`, `APIError`, `getSessionFromCtx` are already imported from `better-auth/api`):

```ts
import { oauthAccessTokenClaims, consentScopeViolation } from "./entitlement.js";
```

- [ ] **Step 4: Add `customAccessTokenClaims` to the oauthProvider block**

In the existing `oauthProvider({...})` config (the foundation block), add the claims hook (leave the other options as-is for now; the URL fix is Task 5):

```ts
      // Per-user entitlement backstop + role claim. Runs at every user-token
      // issuance (authorization_code, refresh re-issue) and introspection, so no
      // token can carry scopes beyond the user's live role — even via a
      // skip_consent client or refresh replay. M2M tokens (no user) are skipped.
      customAccessTokenClaims: oauthAccessTokenClaims,
```

- [ ] **Step 5: Add the `hooks.before` consent gate to the betterAuth config**

In the `return betterAuth({ ... })` object (`workers/api/src/auth/index.ts`), add a top-level `hooks` key (next to `databaseHooks`):

```ts
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
    },
```

- [ ] **Step 6: Run the wiring test + type-check**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts && npx tsc --noEmit`
Expected: PASS. (If tsc reports that `hooks.before` expects an array rather than a single middleware — a plugin-vs-config shape mismatch — wrap it as documented by Better Auth for the **top-level** config; the single-`createAuthMiddleware` form is the config shape. Confirm against `better-auth` types and adjust only if the compiler demands it.)

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/auth/index.ts workers/api/test/oauth-entitlement.test.ts
git commit -m "feat(api): enforce per-user scope entitlement at consent + token issuance"
```

---

## Task 5: Absolute `loginPage` / `consentPage` URLs (precursor fix)

**Files:**

- Modify: `workers/api/src/auth/index.ts` (oauthProvider `loginPage`/`consentPage`)
- Test: `workers/api/test/oauth-entitlement.test.ts` (append)

The plugin redirects the browser to `loginPage`/`consentPage` verbatim (string concat, no base-URL resolution). A relative `/login` resolves against the request origin (`api.releases.sh`) — the wrong worker. The pages live on `releases.sh`, so the URLs must be absolute, mirroring the device-auth `verificationUri`.

- [ ] **Step 1: Write the failing behavioral test (authorize → login redirect origin)**

Append to `workers/api/test/oauth-entitlement.test.ts`:

```ts
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { jwt } from "better-auth/plugins";
import { oauthProvider } from "@better-auth/oauth-provider";
import {
  user as userTbl,
  session as sessionTbl,
  account as accountTbl,
  verification as verificationTbl,
  jwks,
  oauthClient,
  oauthAccessToken,
  oauthRefreshToken,
  oauthConsent,
} from "../src/db/schema-auth.js";

describe("absolute consent/login redirect origin", () => {
  it("redirects an unauthenticated authorize to the WEB origin, not the api origin", async () => {
    const db = createTestDb();
    // Build an instance whose pages are absolute web-origin URLs and a client is
    // registered, so /oauth2/authorize (no session) must redirect to loginPage.
    const auth = betterAuth({
      baseURL: "https://api.releases.localhost",
      secret: "test-secret-do-not-use-in-prod-0123456789",
      database: drizzleAdapter(db, {
        provider: "sqlite",
        schema: {
          user: userTbl,
          session: sessionTbl,
          account: accountTbl,
          verification: verificationTbl,
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
          loginPage: "https://releases.localhost/login",
          consentPage: "https://releases.localhost/oauth/consent",
          scopes: ["openid", "read"],
          allowDynamicClientRegistration: true,
          allowUnauthenticatedClientRegistration: true,
        }),
      ],
    });
    const reg = await auth.handler(
      new Request("https://api.releases.localhost/api/auth/oauth2/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Test",
          redirect_uris: ["https://app.example.com/cb"],
          token_endpoint_auth_method: "none",
        }),
      }),
    );
    const { client_id } = (await reg.json()) as { client_id: string };
    const authorizeUrl = new URL("https://api.releases.localhost/api/auth/oauth2/authorize");
    authorizeUrl.searchParams.set("client_id", client_id);
    authorizeUrl.searchParams.set("redirect_uri", "https://app.example.com/cb");
    authorizeUrl.searchParams.set("response_type", "code");
    authorizeUrl.searchParams.set("scope", "openid read");
    authorizeUrl.searchParams.set("code_challenge", "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
    authorizeUrl.searchParams.set("code_challenge_method", "S256");
    const res = await auth.handler(new Request(authorizeUrl, { redirect: "manual" }));
    // The AS issues a redirect to the login page (no session). Its origin must be
    // the WEB origin, never the api origin.
    const location = res.headers.get("location") ?? "";
    expect(location.startsWith("https://releases.localhost/login")).toBe(true);
    expect(location.startsWith("https://api.releases.localhost")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify it currently passes with absolute URLs (guard test)**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts -t "absolute consent"`
Expected: PASS — this test instance already uses absolute URLs, so it documents the required behavior. (If it FAILS, the redirect path differs from the assumption; inspect the actual `location` and adjust the assertion to the real login redirect, keeping the origin check.)

- [ ] **Step 3: Apply the fix to the real `createAuth` oauthProvider block**

In `workers/api/src/auth/index.ts`, change the foundation's relative pages to absolute web-origin URLs:

```ts
      // ABSOLUTE web-origin URLs (not relative): the plugin redirects the browser
      // to these verbatim, and a relative path resolves against the request origin
      // (api.releases.sh) — the wrong worker. The /login + /oauth/consent pages are
      // served by the Next.js frontend (releases.sh). Same rule as the device-auth
      // verificationUri. WEB_BASE_URL is releases.sh in prod/staging, the portless
      // web origin locally; the session cookie is .releases.sh-scoped so it rides
      // across the two subdomains.
      loginPage: `${env.WEB_BASE_URL ?? "https://releases.sh"}/login`,
      consentPage: `${env.WEB_BASE_URL ?? "https://releases.sh"}/oauth/consent`,
```

- [ ] **Step 4: Run the full worker auth test set + type-check**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts test/oauth-provider.test.ts test/auth.test.ts && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/auth/index.ts workers/api/test/oauth-entitlement.test.ts
git commit -m "fix(api): absolute web-origin loginPage/consentPage for OAuth flow"
```

---

## Task 6: Web entitlement mirror (display filter)

**Files:**

- Create: `web/src/lib/entitlement.ts`
- Create: `web/src/lib/entitlement.test.ts`

- [ ] **Step 1: Write the failing test**

Create `web/src/lib/entitlement.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { displayScopes, SCOPE_LABELS, IDENTITY_SCOPES } from "./entitlement";

describe("displayScopes", () => {
  it("filters requested scopes to those the role is entitled to", () => {
    expect(displayScopes("user", ["openid", "read", "write"])).toEqual(["openid", "read"]);
    expect(displayScopes("curator", ["openid", "read", "write", "admin"])).toEqual([
      "openid",
      "read",
      "write",
    ]);
  });
  it("fails closed for unknown roles → identity + read only", () => {
    expect(displayScopes(null, ["read", "write", "admin"])).toEqual(["read"]);
  });
  it("has a label for every grantable scope", () => {
    for (const s of [...IDENTITY_SCOPES, "read", "write", "admin"]) {
      expect(SCOPE_LABELS[s]).toBeDefined();
    }
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (repo root): `bun test web/src/lib/entitlement.test.ts`
Expected: FAIL — `./entitlement` does not exist.

- [ ] **Step 3: Implement the mirror**

Create `web/src/lib/entitlement.ts`:

```ts
/**
 * Display-only mirror of the API worker's scope entitlement
 * (workers/api/src/auth/entitlement.ts). Used by the consent page to show only
 * the scopes the signed-in user may grant. NOT a security boundary — the API
 * gates (consent hook + token backstop) are authoritative; this just avoids
 * offering a scope the AS will refuse. Keep ROLE_LADDER/IDENTITY_SCOPES in sync
 * with the worker copy (both are tiny constants; the web app is a separate build
 * and cannot import the worker module).
 */
export const IDENTITY_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

export const ROLE_LADDER: Record<string, readonly string[]> = {
  user: ["read"],
  curator: ["read", "write"],
  admin: ["read", "write", "admin"],
};

/** Human-readable labels for the consent screen. */
export const SCOPE_LABELS: Record<string, { title: string; desc: string }> = {
  openid: { title: "Verify your identity", desc: "Confirm who you are." },
  profile: { title: "Basic profile", desc: "Your name and avatar." },
  email: { title: "Email address", desc: "Your account email." },
  offline_access: {
    title: "Stay connected",
    desc: "Keep access when you're away (refresh tokens).",
  },
  read: { title: "Read catalog data", desc: "View organizations, sources, and releases." },
  write: { title: "Manage catalog data", desc: "Create and edit catalog entries on your behalf." },
  admin: { title: "Full admin access", desc: "Administrative operations on your behalf." },
};

export function entitledScopes(role: string | null | undefined): string[] {
  const roles = (role ?? "user")
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean);
  const ladder = new Set<string>();
  for (const r of roles) for (const s of ROLE_LADDER[r] ?? ROLE_LADDER.user) ladder.add(s);
  if (ladder.size === 0) for (const s of ROLE_LADDER.user) ladder.add(s);
  return [...IDENTITY_SCOPES, ...ladder];
}

/** Requested scopes intersected with what `role` may grant (preserves request order). */
export function displayScopes(role: string | null | undefined, requested: string[]): string[] {
  const allowed = new Set(entitledScopes(role));
  return requested.filter((s) => allowed.has(s));
}
```

- [ ] **Step 4: Run to verify it passes**

Run (repo root): `bun test web/src/lib/entitlement.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/entitlement.ts web/src/lib/entitlement.test.ts
git commit -m "feat(web): scope-entitlement display mirror for consent page"
```

---

## Task 7: Register `oauthProviderClient()` in the web auth client

**Files:**

- Modify: `web/src/lib/auth-client.ts`

- [ ] **Step 1: Add the import**

In `web/src/lib/auth-client.ts`, add the oauth-provider client plugin import below the existing plugin imports:

```ts
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
```

- [ ] **Step 2: Register the plugin**

Add `oauthProviderClient()` to the `plugins` array (after `deviceAuthorizationClient()`):

```ts
    // OAuth provider client — infers typed methods from the server oauthProvider
    // plugin (authClient.oauth2Consent, authClient.oauth2PublicClient, …) and a
    // fetch hook that injects the signed `oauth_query` into consent POSTs. Drives
    // the /oauth/consent page. Inert until that page calls it.
    oauthProviderClient(),
```

- [ ] **Step 3: Confirm the dependency resolves**

Run (repo root): `bun install` (the `@better-auth/oauth-provider` package is already a workspace dependency of `workers/api`; confirm it resolves for `web`. If `web/package.json` lacks it, add `"@better-auth/oauth-provider": "^1.6.14"` to `web` dependencies and re-run `bun install`.)
Then: `cd web && npx tsc --noEmit`
Expected: PASS — the `/client` subpath is browser-safe; `authClient` gains the inferred `oauth2*` methods.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/auth-client.ts web/package.json bun.lock
git commit -m "feat(web): register oauthProviderClient for the consent page"
```

---

## Task 8: Consent form component

**Files:**

- Create: `web/src/components/oauth-consent-form.tsx`

This is a `"use client"` component, styled with hand-written Tailwind to match `device-approve-form.tsx`. It reads the signed OAuth params from the URL, fetches the public client info, filters scopes to the user's entitlement, and submits accept/deny.

- [ ] **Step 1: Create the component**

Create `web/src/components/oauth-consent-form.tsx`:

```tsx
"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";
import { displayScopes, SCOPE_LABELS } from "@/lib/entitlement";

type PublicClient = {
  client_id: string;
  client_name?: string;
  client_uri?: string;
  logo_uri?: string;
};

export function OauthConsentForm() {
  const params = useSearchParams();
  const clientId = params.get("client_id") ?? "";
  const requestedScopes = (params.get("scope") ?? "").split(/\s+/).filter(Boolean);

  const [client, setClient] = useState<PublicClient | null>(null);
  const [role, setRole] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data: sessionData } = await authClient.getSession();
      if (!cancelled) {
        setRole(
          ((sessionData?.user as { role?: string } | undefined)?.role ?? null) as string | null,
        );
      }
      if (clientId) {
        const { data } = await authClient.oauth2PublicClient({ query: { client_id: clientId } });
        if (!cancelled && data) setClient(data as PublicClient);
      }
      if (!cancelled) setLoaded(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [clientId]);

  const grantable = displayScopes(role, requestedScopes);

  async function submit(accept: boolean) {
    setSubmitting(true);
    setError(null);
    const { data, error: err } = await authClient.oauth2Consent({
      accept,
      scope: grantable.join(" "),
      oauth_query: typeof window !== "undefined" ? window.location.search.replace(/^\?/, "") : "",
    });
    if (err) {
      setError(err.message ?? "Something went wrong. Please try again.");
      setSubmitting(false);
      return;
    }
    const url = (data as { redirect?: boolean; url?: string } | null)?.url;
    if (url) window.location.href = url;
    else setSubmitting(false);
  }

  if (!loaded) {
    return <p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>;
  }
  if (!clientId) {
    return (
      <p className="text-sm text-red-700 dark:text-red-400">
        No pending authorization request. Start again from the application you were using.
      </p>
    );
  }

  const appName = client?.client_name ?? clientId;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {client?.logo_uri ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={client.logo_uri} alt="" className="h-10 w-10 rounded" />
        ) : null}
        <div>
          <p className="text-base font-semibold text-stone-900 dark:text-stone-100">{appName}</p>
          {client?.client_uri ? (
            <a
              href={client.client_uri}
              className="text-xs text-stone-500 underline dark:text-stone-400"
              target="_blank"
              rel="noreferrer"
            >
              {client.client_uri}
            </a>
          ) : null}
        </div>
      </div>

      <p className="text-sm text-stone-600 dark:text-stone-300">
        <span className="font-medium">{appName}</span> is requesting access to your Releases
        account:
      </p>

      <ul className="space-y-2">
        {grantable.map((scope) => {
          const label = SCOPE_LABELS[scope] ?? { title: scope, desc: "" };
          return (
            <li
              key={scope}
              className="border border-stone-200 bg-white px-3 py-2 text-sm dark:border-stone-800 dark:bg-stone-950"
            >
              <p className="font-medium text-stone-900 dark:text-stone-100">{label.title}</p>
              {label.desc ? (
                <p className="text-xs text-stone-500 dark:text-stone-400">{label.desc}</p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {error ? <p className="text-sm text-red-700 dark:text-red-400">{error}</p> : null}

      <div className="flex gap-3">
        <button
          type="button"
          disabled={submitting}
          onClick={() => submit(true)}
          className="inline-flex h-10 items-center justify-center border border-green-600/40 bg-green-50 px-4 text-sm font-medium text-green-800 hover:bg-green-100 disabled:opacity-50 dark:border-green-500/40 dark:bg-green-950/40 dark:text-green-300"
        >
          Allow access
        </button>
        <button
          type="button"
          disabled={submitting}
          onClick={() => submit(false)}
          className="inline-flex h-10 items-center justify-center border border-stone-300 bg-white px-4 text-sm font-medium text-stone-700 hover:bg-stone-100 disabled:opacity-50 dark:border-stone-700 dark:bg-stone-950 dark:text-stone-300"
        >
          Deny
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: PASS. (If the inferred `authClient.oauth2Consent` / `authClient.oauth2PublicClient` names differ from the installed plugin, adjust to the actual inferred method names — verify via `cd web && bun -e "import('@better-auth/oauth-provider/client').then(m=>console.log(Object.keys(m)))"` and the server plugin's endpoint paths.)

- [ ] **Step 3: Commit**

```bash
git add web/src/components/oauth-consent-form.tsx
git commit -m "feat(web): OAuth consent form component"
```

---

## Task 9: Consent page route

**Files:**

- Create: `web/src/app/oauth/consent/page.tsx`

- [ ] **Step 1: Create the route**

Create `web/src/app/oauth/consent/page.tsx` (mirrors `web/src/app/device/page.tsx`):

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Header } from "@/components/header";
import { OauthConsentForm } from "@/components/oauth-consent-form";
import { AUTH_UI_ENABLED } from "@/lib/auth-ui";

export const metadata: Metadata = {
  title: "Authorize application",
  description: "Grant an application access to your Releases account.",
  alternates: { canonical: "/oauth/consent" },
  robots: { index: false, follow: false },
};

export default function OauthConsentPage() {
  // The consent page is part of the human-auth surface and is meaningless without
  // sign-in, which AUTH_UI_ENABLED governs. No consent-specific feature flag (per
  // spec); NEXT_PUBLIC_BETTER_AUTH_URL is a functional prerequisite (the auth
  // client 404s without it).
  if (!AUTH_UI_ENABLED || !process.env.NEXT_PUBLIC_BETTER_AUTH_URL) {
    notFound();
  }

  return (
    <div className="min-h-screen">
      <Header />
      <div className="mx-auto grid w-full max-w-5xl gap-10 px-6 py-12 lg:grid-cols-[280px_minmax(0,1fr)]">
        <aside className="text-sm text-stone-500 dark:text-stone-400">
          <p className="font-mono text-[11px] uppercase tracking-[0.18em] text-stone-400 dark:text-stone-500">
            Authorize
          </p>
          <h1 className="mt-3 text-2xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
            Grant access
          </h1>
          <p className="mt-4 leading-6">
            An application wants to access your Releases account. Review what it can do, then allow
            or deny. You only see the permissions your account is entitled to grant.
          </p>
        </aside>

        <section className="border border-stone-200 bg-stone-50 p-5 dark:border-stone-800 dark:bg-stone-950 sm:p-6">
          {/* useSearchParams in the form requires a Suspense boundary in the App Router. */}
          <Suspense
            fallback={<p className="text-sm text-stone-500 dark:text-stone-400">Loading…</p>}
          >
            <OauthConsentForm />
          </Suspense>
        </section>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Type-check + build sanity**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/oauth/consent/page.tsx
git commit -m "feat(web): /oauth/consent page route"
```

---

## Task 10: Full verification, spec status, staging smoke

**Files:**

- Modify: `docs/superpowers/specs/2026-06-07-oauth-consent-entitlement-design.md` (status)

- [ ] **Step 1: Full type-check (root + worker + web)**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit) && (cd web && npx tsc --noEmit)`
Expected: PASS all three.

- [ ] **Step 2: Full test suite**

Run (repo root): `bun test`
Expected: PASS — including `workers/api/test/oauth-entitlement.test.ts`, the existing `workers/api/test/oauth-provider.test.ts` + `test/auth.test.ts` (regression: admin columns + hooks did not break the foundation), and `web/src/lib/entitlement.test.ts`.

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: PASS. (Run `bun run format` if `format:check` flags new files, then re-commit.)

- [ ] **Step 4: Update the spec status**

In `docs/superpowers/specs/2026-06-07-oauth-consent-entitlement-design.md`, change the status line to:

```markdown
- **Status:** Implemented; pending staging smoke
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-06-07-oauth-consent-entitlement-design.md
git commit -m "docs(oauth): mark consent + entitlement implemented"
```

- [ ] **Step 6: Open the PR**

Write the body to a file first (avoids HEREDOC backtick leakage), then `--body-file`:

```bash
git push -u origin worktree-oauth-consent-entitlement
cat > /tmp/oauth-consent-pr-body.md <<'EOF'
Sub-projects 2 (per-user scope entitlement) + 3 (consent UI) of the OAuth provider work, combined.

- `admin` plugin role (user/curator/admin) → OAuth scope ceiling (`entitlement.ts`), fail-closed.
- Two-layer enforcement: `/oauth2/consent` `hooks.before` gate + `customAccessTokenClaims` backstop (covers skip_consent + refresh) + role claim in the JWT.
- Fixes the foundation's relative `loginPage`/`consentPage` → absolute web-origin URLs.
- `/oauth/consent` web page + `oauthProviderClient()`.
- Migration `20260607010000` (admin-plugin columns). `OAUTH_ADMIN_USER_IDS` bootstraps the first admin.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
gh pr create --title "feat(oauth): consent UI + per-user scope entitlement (#2+#3)" --body-file /tmp/oauth-consent-pr-body.md
```

- [ ] **Step 7: Operator setup + staging smoke (manual, after deploy)**

Document for the operator (these are user actions — not done by the implementer):

1. Set `OAUTH_ADMIN_USER_IDS` to the bootstrap user's Better Auth user id (prod + staging `vars` in `workers/api/wrangler.jsonc`, or via the dashboard). Deploy.
2. Promote a curator: as the bootstrap admin, call `setRole` (`POST /api/auth/admin/set-role` with `{ userId, role: "curator" }`) — or set the `role` column directly in D1.
3. Smoke (staging access gate needs `-H "X-Releases-Staging-Key: $STAGING_ACCESS_KEY"`): admin-create a non-`skip_consent` OAuth client, run an `authorization_code` + PKCE flow through `https://releases-staging…/oauth/consent`, and verify:
   - a `user`-role account is offered only `read` and a forged `write` consent is rejected (`invalid_scope`);
   - a `curator` account can grant `write`; the issued JWT carries `https://releases.sh/role` and verifies against `/api/auth/jwks`.

Capture the result in the PR description.

---

## Notes for the executor

- **Worktree:** this plan executes in the `worktree-oauth-consent-entitlement` worktree. Run `bun install` in it first if `node_modules` is absent (workspace installs don't propagate to fresh worktrees).
- **Test-file imports go at the top.** `oauth-entitlement.test.ts` grows across Tasks 1–5; each task's snippet shows the `import` it relies on, but place every `import` in the file's top import block (TS hoists them, and oxlint's `import/first` rejects mid-file imports). Use distinct aliases where a name repeats (e.g. `user as userTable` for the schema table vs. nothing for the entitlement helpers).
- **Entitlement is the security boundary, twice.** The consent hook is the early/friendly reject; `customAccessTokenClaims` is authoritative (it gates every user-token issuance incl. refresh + skip_consent). Never weaken the backstop to "fix" a consent-hook edge case.
- **Keep the two `ROLE_LADDER`/`IDENTITY_SCOPES` copies in sync** (worker `auth/entitlement.ts` ↔ web `lib/entitlement.ts`). The web copy is display-only; the worker copy is enforced.
- **Do not** add a Flagship feature flag (spec decision). Do not adopt the `organization` plugin. Do not touch `workers/mcp` (resource-server verification is sub-project 5; keep `better-auth` out of that worker — zod-split landmine).
- **Reconcile inferred client method names** (`oauth2Consent`/`oauth2PublicClient`) against the installed `@better-auth/oauth-provider/client` if `web` tsc disagrees (Task 8 Step 2).
- **`hooks.before` shape:** the top-level `betterAuth({ hooks })` config takes a single `createAuthMiddleware` function for `before`/`after` (branch on `ctx.path`), not the plugin-level `{matcher,handler}[]` array. If tsc demands the array form, that's the only place to adapt (Task 4 Step 6).

```

```
