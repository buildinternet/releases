# Production Admin Capabilities via Per-User Role Gate — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a signed-in **admin** user use the web app's admin capabilities (entity admin menus + the `/admin` hub) in deployed production, with the API independently enforcing admin per user — and nothing exposed to non-admins.

**Architecture:** Admin server actions mint the caller's own short-lived JWT from Better Auth's `GET /api/auth/token` (forwarding the session cookie) and call the admin API with it. The JWT's `scope` claim is role-clamped at issuance via the `jwt()` plugin's `definePayload`, so the API's existing OAuth-JWT resource-server lane is the single authoritative gate (a non-admin's JWT carries `read` only → admin routes 403). UI menus are gated client-side via `useSession()` (cosmetic; bypassing just yields a 403); the `/admin` hub pages gate server-side. Local dev keeps the existing root-key path unchanged.

**Tech Stack:** Better Auth (`jwt()` + `oauthProvider()` plugins) on a Cloudflare Worker (Hono), Next.js 16 App Router web frontend, Bun test, TypeScript strict.

**Spec:** `docs/superpowers/specs/2026-06-15-prod-admin-role-gate-design.md` (verification gates both resolved there).

---

## Background facts (verified)

- The `jwt()` plugin is already registered at `workers/api/src/auth/index.ts:839`. Its `GET /api/auth/token` mints a session JWT and coexists with `oauthProvider()` (distinct route from `/oauth2/token`).
- `jwt.definePayload` is **isolated** to `/token` (OAuth access tokens use `customAccessTokenClaims`). `jwt.audience` does not reach OAuth tokens (they set `aud` explicitly). `jwt.issuer` feeds OAuth tokens but the value we set (`${origin}/api/auth`) already equals their resolved `iss` — a no-op.
- The API verifier (`packages/lib/src/oauth-jwt.ts` → `verifyOAuthJwt`) requires `iss = ${origin}/api/auth`, `aud = ${origin}` (bare origin), and reads the `scope` claim. `oauthJwtConfig()` (`workers/api/src/middleware/auth.ts`) derives these from `BETTER_AUTH_URL`.
- `entitlement.ts` already exports the audited, fail-closed `entitledScopes(role)` (`workers/api/src/auth/entitlement.ts`).
- `BETTER_AUTH_URL` is `https://api.releases.sh` in prod (`workers/api/wrangler.jsonc`); `DEFAULT_AUTH_ORIGIN = "https://api.releases.sh"` (`auth/index.ts:322`). Default basePath `/api/auth`.
- Next.js 16: `cookies()` is async (`(await cookies())`).

## File Structure

**Create:**

- `web/src/lib/server-session.ts` — server-only: read the caller's session role from the API; `isAdminViewer()` gate for `/admin` pages.
- `web/src/components/admin-only.tsx` — client: `computeIsAdmin()` pure predicate, `useIsAdmin()` hook, `AdminOnly` wrapper that mounts children only for admins.

**Modify (API):**

- `workers/api/src/auth/entitlement.ts` — add `jwtSessionPayload(user)`.
- `workers/api/src/auth/index.ts` — configure the `jwt()` plugin.
- `workers/api/test/oauth-entitlement.test.ts` — add `jwtSessionPayload` + jwt-plugin wiring tests.

**Modify (web — credential):**

- `web/src/lib/admin-action.ts` — `adminActionEnv()` becomes async; mints per-user JWT in prod.
- `web/src/app/actions/{org,source,product,release,collection}-admin.ts`, `web/src/app/actions/site-notice.ts` — `await adminActionEnv()`.
- `web/src/app/actions/api-tokens.ts` — async `adminHeaders()` via `adminActionEnv()`.

**Modify (web — UI gating):**

- `web/src/app/[orgSlug]/(org)/layout.tsx`, `web/src/app/[orgSlug]/[slug]/layout.tsx`, `web/src/app/sources/[id]/layout.tsx`, `web/src/app/[orgSlug]/[slug]/_views/product-view.tsx`, `web/src/app/release/[id]/page.tsx`, `web/src/app/collections/[slug]/page.tsx` — wrap menus in `<AdminOnly>`.
- `web/src/components/account-nav.tsx` — OR session role into the Admin-link visibility.
- `web/src/app/admin/page.tsx`, `web/src/app/admin/api-tokens/page.tsx`, `web/src/app/admin/site-notice/page.tsx` — gate via `isAdminViewer()`.

**Commands:** root tsc `npx tsc --noEmit`; web tsc `cd web && npx tsc --noEmit`; worker tsc `cd workers/api && npx tsc --noEmit`; tests `bun test`; web build `cd web && bun run build`.

---

## Phase A — API: per-user JWT issuance

### Task A1: `jwtSessionPayload` helper (role-clamped scope claim)

**Files:**

- Modify: `workers/api/src/auth/entitlement.ts`
- Test: `workers/api/test/oauth-entitlement.test.ts`

- [ ] **Step 1: Write the failing test** — append to `workers/api/test/oauth-entitlement.test.ts` after the `oauthAccessTokenClaims` describe block (around line 90). Add `jwtSessionPayload` to the existing import from `../src/auth/entitlement.js`.

```ts
describe("jwtSessionPayload", () => {
  it("gives an admin the full ladder in the scope claim + role", () => {
    expect(jwtSessionPayload({ role: "admin" })).toEqual({
      scope: "openid profile email offline_access read write admin",
      "https://releases.sh/role": "admin",
    });
  });
  it("gives a plain user read-only scope", () => {
    expect(jwtSessionPayload({ role: "user" })).toEqual({
      scope: "openid profile email offline_access read",
      "https://releases.sh/role": "user",
    });
  });
  it("fails closed for null/unknown role → read-only, role defaults to user", () => {
    expect(jwtSessionPayload({ role: null })).toEqual({
      scope: "openid profile email offline_access read",
      "https://releases.sh/role": "user",
    });
    expect(jwtSessionPayload(undefined)).toEqual({
      scope: "openid profile email offline_access read",
      "https://releases.sh/role": "user",
    });
    expect(jwtSessionPayload({ role: "wizard" })).toEqual({
      scope: "openid profile email offline_access read",
      "https://releases.sh/role": "wizard",
    });
  });
});
```

Note: the `role` claim echoes the stored role verbatim (`"wizard"`) while the **scope** fails closed to read — the scope is the security boundary, the role claim is informational.

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts -t jwtSessionPayload`
Expected: FAIL — `jwtSessionPayload is not a function` / import error.

- [ ] **Step 3: Implement `jwtSessionPayload`** — append to `workers/api/src/auth/entitlement.ts`:

```ts
/**
 * Payload for the `jwt()` plugin's `/api/auth/token` endpoint (the first-party
 * session → JWT path the web admin actions use). The `scope` claim is
 * role-clamped via {@link entitledScopes} (fail-closed: unknown/null role →
 * read-only), so the resource server (verifyOAuthJwt) authorizes the caller at
 * exactly their role — a non-admin can never obtain an admin-scoped token. The
 * `https://releases.sh/role` claim mirrors the OAuth lane and is informational.
 */
export function jwtSessionPayload(user: { role?: string | null } | null | undefined): {
  scope: string;
  "https://releases.sh/role": string;
} {
  const role = user?.role ?? null;
  return {
    scope: entitledScopes(role).join(" "),
    "https://releases.sh/role": role ?? "user",
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts -t jwtSessionPayload`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/auth/entitlement.ts workers/api/test/oauth-entitlement.test.ts
git commit -m "feat(api): jwtSessionPayload — role-clamped scope for session /token JWTs"
```

### Task A2: Configure the `jwt()` plugin for the resource-server lane

**Files:**

- Modify: `workers/api/src/auth/index.ts` (import at line 29; `jwt()` call at line 839)
- Test: `workers/api/test/oauth-entitlement.test.ts`

- [ ] **Step 1: Write the failing wiring test** — append to `workers/api/test/oauth-entitlement.test.ts`. It inspects the constructed plugin options (mirrors the existing "admin plugin wiring" tests). Uses the existing `wiringEnv` (`BETTER_AUTH_URL: "https://api.releases.localhost"`).

```ts
describe("jwt plugin resource-server config", () => {
  it("pins issuer/audience to the API verifier's expectations and clamps the payload", async () => {
    const auth = await createAuth(wiringEnv, undefined, {
      db: createTestDb(),
      sendEmail: () => {},
    });
    const jwtPlugin = (auth.options.plugins ?? []).find((p: { id: string }) => p.id === "jwt") as
      | {
          options?: {
            disableSettingJwtHeader?: boolean;
            jwt?: {
              issuer?: string;
              audience?: string;
              definePayload?: (info: { user: { role?: string | null } }) => unknown;
            };
          };
        }
      | undefined;
    expect(jwtPlugin).toBeDefined();
    // Bare-origin audience + /api/auth-suffixed issuer == what oauthJwtConfig() checks.
    // The issuer equals the OAuth tokens' resolved iss (baseURL + default basePath),
    // so setting it is a no-op for the OAuth lane (#1483).
    expect(jwtPlugin?.options?.jwt?.issuer).toBe("https://api.releases.localhost/api/auth");
    expect(jwtPlugin?.options?.jwt?.audience).toBe("https://api.releases.localhost");
    expect(jwtPlugin?.options?.disableSettingJwtHeader).toBe(true);
    // definePayload role-clamps: admin → admin scope, user → read only.
    expect(jwtPlugin?.options?.jwt?.definePayload?.({ user: { role: "admin" } })).toEqual({
      scope: "openid profile email offline_access read write admin",
      "https://releases.sh/role": "admin",
    });
    expect(jwtPlugin?.options?.jwt?.definePayload?.({ user: { role: "user" } })).toEqual({
      scope: "openid profile email offline_access read",
      "https://releases.sh/role": "user",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts -t "jwt plugin resource-server config"`
Expected: FAIL — `issuer` is `undefined` (plugin currently called as bare `jwt()`).

- [ ] **Step 3: Add `jwtSessionPayload` to the import** — `workers/api/src/auth/index.ts` line 29:

```ts
import { oauthAccessTokenClaims, consentScopeViolation, jwtSessionPayload } from "./entitlement.js";
```

- [ ] **Step 4: Replace the bare `jwt()` call** — `workers/api/src/auth/index.ts` line 839. Replace `    jwt(),` with:

```ts
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
```

- [ ] **Step 5: Run the wiring test + the full entitlement suite**

Run: `cd workers/api && bun test test/oauth-entitlement.test.ts`
Expected: PASS (new wiring test + all pre-existing tests still green — confirms nothing else broke).

- [ ] **Step 6: Type-check the worker**

Run: `cd workers/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/auth/index.ts workers/api/test/oauth-entitlement.test.ts
git commit -m "feat(api): configure jwt() /token for the resource-server lane (role-clamped)"
```

---

## Phase B — Web: per-user credential resolver

### Task B1: `adminActionEnv()` mints the per-user JWT in production

**Files:**

- Modify: `web/src/lib/admin-action.ts`

- [ ] **Step 1: Rewrite the file** — replace the entire contents of `web/src/lib/admin-action.ts` with:

```ts
import "server-only";
import { cookies } from "next/headers";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl, serverApiKey } from "./env";

/**
 * Resolve `{ apiUrl, apiSecret }` for an admin server action, where `apiSecret`
 * is a Bearer credential the admin API accepts:
 *
 *  - **Local dev** (`isLocalAdminEnabled()`): the root `RELEASES_API_KEY`, as before.
 *  - **Production**: a short-lived, per-user JWT minted from the CALLER's Better
 *    Auth session via `GET /api/auth/token`. Its scope is role-clamped at
 *    issuance, so the API authorizes the operation at the caller's role — a
 *    non-admin's token carries `read` only and admin routes 403. No shared
 *    admin secret sits on the web server; the only credential is the user's own.
 *
 * (Field name `apiSecret` is kept so the many `Bearer ${env.apiSecret}` call
 * sites are unchanged; it holds the root key in dev and the user JWT in prod.)
 */
export async function adminActionEnv(): Promise<
  { apiUrl: string; apiSecret: string } | { error: string }
> {
  const apiUrl = apiBaseUrl() ?? "http://localhost:3456";

  if (isLocalAdminEnabled()) {
    const apiSecret = serverApiKey();
    if (!apiSecret)
      return { error: "RELEASES_API_KEY (or legacy RELEASED_API_KEY) not configured." };
    return { apiUrl, apiSecret };
  }

  const jwt = await mintUserJwt(apiUrl);
  if (!jwt) return { error: "Admin actions require an admin session." };
  return { apiUrl, apiSecret: jwt };
}

/**
 * Mint the caller's session JWT from `GET /api/auth/token`, forwarding the
 * incoming `.releases.sh` session cookie. Returns null when there is no session
 * (anonymous caller) or the request fails — the caller then surfaces an error.
 */
async function mintUserJwt(apiUrl: string): Promise<string | null> {
  const cookie = (await cookies()).toString();
  if (!cookie) return null;
  try {
    const res = await fetch(`${apiUrl}/api/auth/token`, {
      headers: webApiHeaders({ Cookie: cookie }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { token?: string };
    return body.token ?? null;
  } catch {
    return null;
  }
}
```

- [ ] **Step 2: Type-check (expected to FAIL until callers add `await`)**

Run: `cd web && npx tsc --noEmit`
Expected: errors at the action call sites — `'error' in env` etc. on a `Promise` (because `adminActionEnv()` is now async and callers don't `await`). This is the failing signal that drives Task B2/B3. Proceed to those before committing.

### Task B2: `await adminActionEnv()` in every entity + site-notice action

**Files (each has one or more `const env = adminActionEnv();`):**

- `web/src/app/actions/org-admin.ts` (5 sites)
- `web/src/app/actions/source-admin.ts` (6 sites)
- `web/src/app/actions/product-admin.ts` (2 sites)
- `web/src/app/actions/release-admin.ts` (2 sites)
- `web/src/app/actions/collection-admin.ts` (1 site)
- `web/src/app/actions/site-notice.ts` (2 sites)

- [ ] **Step 1: Replace every occurrence** of:

```ts
const env = adminActionEnv();
```

with:

```ts
const env = await adminActionEnv();
```

in all six files. Every enclosing function is already `async`, so no signature changes are needed. (In `site-notice.ts`, both `getSiteNoticeAdminAction` and `setSiteNoticeAction` are already `async`.)

- [ ] **Step 2: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: the entity/site-notice action errors are gone. Any remaining error should be only in `api-tokens.ts` (Task B3).

- [ ] **Step 3: Commit**

```bash
git add web/src/lib/admin-action.ts web/src/app/actions/org-admin.ts web/src/app/actions/source-admin.ts web/src/app/actions/product-admin.ts web/src/app/actions/release-admin.ts web/src/app/actions/collection-admin.ts web/src/app/actions/site-notice.ts
git commit -m "feat(web): mint per-user JWT for admin actions in prod (await adminActionEnv)"
```

### Task B3: API-tokens actions use the per-user credential

`api-tokens.ts` does not use `adminActionEnv()` — it has its own sync `adminHeaders()` (root key) and gates `adminFetch` on `isApiTokensAdminEnabled()`. Route it through `adminActionEnv()` so it gets the dev-root-key / prod-user-JWT behavior, and drop the now-redundant env gate (the credential resolver IS the gate).

**Files:**

- Modify: `web/src/app/actions/api-tokens.ts`

- [ ] **Step 1: Update the imports** — in `web/src/app/actions/api-tokens.ts`, replace:

```ts
import { webApiHeaders } from "@/lib/api";
import { isApiScope, type ApiScope } from "@buildinternet/releases-core/api-token";
import { isApiTokensAdminEnabled, PRIMARY_OWNER } from "@/lib/api-tokens-admin-flag";
import { apiBaseUrl, serverApiKey } from "@/lib/env";

const API_URL = apiBaseUrl() ?? "http://localhost:3456";
const REQUEST_TIMEOUT_MS = 10_000;
```

with:

```ts
import { isApiScope, type ApiScope } from "@buildinternet/releases-core/api-token";
import { PRIMARY_OWNER } from "@/lib/api-tokens-admin-flag";
import { adminActionEnv } from "@/lib/admin-action";

const REQUEST_TIMEOUT_MS = 10_000;
```

- [ ] **Step 2: Replace `adminHeaders()` and the `adminFetch()` header/gate wiring** — replace the existing `adminHeaders()` function and the top of `adminFetch()` (down to the `try { res = await fetch(...) }` block) so the credential comes from `adminActionEnv()`. Replace this current block:

```ts
function adminHeaders(): Record<string, string> {
  const secret = serverApiKey();
  if (!secret) throw new Error("RELEASES_API_KEY (or legacy RELEASED_API_KEY) not configured.");
  return webApiHeaders({ Authorization: `Bearer ${secret}`, "Content-Type": "application/json" });
}

/**
 * Gate-checked admin fetch that parses the JSON body. Every failure mode —
 * disabled gate, network error, timeout, non-2xx, or malformed body — is
 * normalized to an `{ ok: false; error }` result so callers never throw.
 */
async function adminFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  if (!isApiTokensAdminEnabled()) {
    return { ok: false, error: "API tokens admin is disabled in this environment." };
  }
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      cache: "no-store",
      ...init,
      headers: adminHeaders(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
```

with:

```ts
/**
 * Admin fetch that parses the JSON body. The credential is resolved by
 * `adminActionEnv()` — the root key in local dev, or the caller's role-clamped
 * per-user JWT in production (the API enforces `admin` scope). Every failure
 * mode — no admin credential, network error, timeout, non-2xx, or malformed
 * body — is normalized to an `{ ok: false; error }` result so callers never throw.
 */
async function adminFetch<T>(
  path: string,
  init?: RequestInit,
): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };
  const { webApiHeaders } = await import("@/lib/api");
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}${path}`, {
      cache: "no-store",
      ...init,
      headers: webApiHeaders({
        Authorization: `Bearer ${env.apiSecret}`,
        "Content-Type": "application/json",
      }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
```

(The rest of `adminFetch` — the `TimeoutError`/`AbortError` handling, `!res.ok`, and JSON parse — is unchanged. The `import("@/lib/api")` is a local dynamic import only because the static `webApiHeaders` import was removed; alternatively keep a top-level `import { webApiHeaders } from "@/lib/api";` and drop the dynamic import — either is fine, choose the static import for clarity:)

Cleaner equivalent — keep a static import instead of the dynamic one. Use this for Step 1 imports block instead:

```ts
import { webApiHeaders } from "@/lib/api";
import { isApiScope, type ApiScope } from "@buildinternet/releases-core/api-token";
import { PRIMARY_OWNER } from "@/lib/api-tokens-admin-flag";
import { adminActionEnv } from "@/lib/admin-action";

const REQUEST_TIMEOUT_MS = 10_000;
```

and in Step 2 use `webApiHeaders({...})` directly (no `await import`).

- [ ] **Step 3: Type-check the whole web app**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. (`serverApiKey` and `API_URL` are no longer referenced in this file; `isApiTokensAdminEnabled` import removed — confirm no other file imports it; if `api-tokens-admin-flag.ts`'s `isApiTokensAdminEnabled` is now unused, leave the file — `PRIMARY_OWNER` is still exported and used.)

- [ ] **Step 4: Commit**

```bash
git add web/src/app/actions/api-tokens.ts
git commit -m "feat(web): route api-tokens admin actions through per-user credential"
```

---

## Phase C — Web: UI gating

### Task C1: `AdminOnly` wrapper + `useIsAdmin` hook

**Files:**

- Create: `web/src/components/admin-only.tsx`
- Test: `web/src/components/admin-only.test.ts`

- [ ] **Step 1: Write the failing test** — create `web/src/components/admin-only.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { computeIsAdmin } from "./admin-only";

describe("computeIsAdmin", () => {
  it("true for an admin-role session", () => {
    expect(computeIsAdmin("admin", false)).toBe(true);
  });
  it("false for a non-admin session", () => {
    expect(computeIsAdmin("user", false)).toBe(false);
    expect(computeIsAdmin("curator", false)).toBe(false);
    expect(computeIsAdmin(null, false)).toBe(false);
    expect(computeIsAdmin(undefined, false)).toBe(false);
  });
  it("true when the dev override is set, regardless of role", () => {
    expect(computeIsAdmin(null, true)).toBe(true);
    expect(computeIsAdmin("user", true)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web && bun test src/components/admin-only.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create the component** — `web/src/components/admin-only.tsx`:

```tsx
"use client";

import type { ReactNode } from "react";
import { useSession } from "@/lib/auth-client";

/** Pure predicate (unit-tested): admin when role is `admin` or the dev override is on. */
export function computeIsAdmin(role: string | null | undefined, devAdmin: boolean): boolean {
  return devAdmin || role === "admin";
}

/**
 * Client hook: is the current viewer an admin? `devAdmin` is the server-evaluated
 * local-dev override (`isLocalAdminEnabled()`), passed down so the keyless local
 * workflow still shows admin UI when no user is signed in.
 */
export function useIsAdmin(devAdmin = false): boolean {
  const { data } = useSession();
  const role = (data?.user as { role?: string } | undefined)?.role ?? null;
  return computeIsAdmin(role, devAdmin);
}

/**
 * Mounts `children` only for admins. Server parents render this around an admin
 * menu and pass `devAdmin`; the menu's own hooks run only when an admin is
 * present (the element is created server-side but rendered client-side only when
 * `useIsAdmin` is true), so anonymous SSR output — and thus page caching — is
 * unaffected. This is cosmetic gating: the server actions the menu calls enforce
 * admin at the API regardless.
 */
export function AdminOnly({
  devAdmin = false,
  children,
}: {
  devAdmin?: boolean;
  children: ReactNode;
}): ReactNode {
  return useIsAdmin(devAdmin) ? children : null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web && bun test src/components/admin-only.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/admin-only.tsx web/src/components/admin-only.test.ts
git commit -m "feat(web): AdminOnly wrapper + useIsAdmin (client role gate)"
```

### Task C2: Wrap entity admin menus in `<AdminOnly>`

For each render site, keep `isLocalAdminEnabled()` but rename the local to `devAdmin`, import `AdminOnly`, and replace the `{adminEnabled && <Menu/>}` guard with an `<AdminOnly devAdmin={devAdmin}>` wrapper so the menu always reaches the client and self-gates on session role.

**Files:**

- `web/src/app/[orgSlug]/(org)/layout.tsx`
- `web/src/app/[orgSlug]/[slug]/layout.tsx`
- `web/src/app/sources/[id]/layout.tsx`
- `web/src/app/[orgSlug]/[slug]/_views/product-view.tsx`
- `web/src/app/release/[id]/page.tsx`
- `web/src/app/collections/[slug]/page.tsx`

- [ ] **Step 1: Org layout** — `web/src/app/[orgSlug]/(org)/layout.tsx`. Add the import (near the other component imports):

```tsx
import { AdminOnly } from "@/components/admin-only";
```

Rename the local at line 46: change `const adminEnabled = isLocalAdminEnabled();` to `const devAdmin = isLocalAdminEnabled();`. Replace the render block:

```tsx
{
  adminEnabled && (
    <div className="mt-2">
      <OrgAdminMenu
        orgSlug={org.slug}
        name={org.name}
        isHidden={org.isHidden ?? false}
        autoGenerateContent={org.autoGenerateContent ?? false}
        featured={org.featured ?? false}
        discovery={org.discovery}
        fetchPaused={org.fetchPaused}
        notice={org.notice}
      />
    </div>
  );
}
```

with:

```tsx
<AdminOnly devAdmin={devAdmin}>
  <div className="mt-2">
    <OrgAdminMenu
      orgSlug={org.slug}
      name={org.name}
      isHidden={org.isHidden ?? false}
      autoGenerateContent={org.autoGenerateContent ?? false}
      featured={org.featured ?? false}
      discovery={org.discovery}
      fetchPaused={org.fetchPaused}
      notice={org.notice}
    />
  </div>
</AdminOnly>
```

- [ ] **Step 2: Org-scoped source layout** — `web/src/app/[orgSlug]/[slug]/layout.tsx`. Add `import { AdminOnly } from "@/components/admin-only";`. Rename `const adminEnabled = isLocalAdminEnabled();` → `const devAdmin = isLocalAdminEnabled();`. Replace:

```tsx
{
  adminEnabled && (
    <SourceAdminMenu
      orgSlug={source.org?.slug ?? orgSlug}
      sourceSlug={source.slug}
      name={source.name}
      marketingFilter={sourceMeta.marketingFilter === true}
      marketingFilterHint={sourceMeta.marketingFilterHint ?? null}
      feedContentDepth={sourceMeta.feedContentDepth ?? null}
      discovery={source.discovery}
      isHidden={source.isHidden ?? false}
      notice={source.notice}
    />
  );
}
```

with:

```tsx
<AdminOnly devAdmin={devAdmin}>
  <SourceAdminMenu
    orgSlug={source.org?.slug ?? orgSlug}
    sourceSlug={source.slug}
    name={source.name}
    marketingFilter={sourceMeta.marketingFilter === true}
    marketingFilterHint={sourceMeta.marketingFilterHint ?? null}
    feedContentDepth={sourceMeta.feedContentDepth ?? null}
    discovery={source.discovery}
    isHidden={source.isHidden ?? false}
    notice={source.notice}
  />
</AdminOnly>
```

- [ ] **Step 3: Legacy source layout** — `web/src/app/sources/[id]/layout.tsx`. Add `import { AdminOnly } from "@/components/admin-only";`. Rename `const adminEnabled = isLocalAdminEnabled();` → `const devAdmin = isLocalAdminEnabled();`. This site has an extra `source.org` condition — preserve it inside the wrapper:

```tsx
{
  adminEnabled && source.org && (
    <SourceAdminMenu
      orgSlug={source.org.slug}
      sourceSlug={source.slug}
      name={source.name}
      marketingFilter={sourceMeta.marketingFilter === true}
      marketingFilterHint={sourceMeta.marketingFilterHint ?? null}
      feedContentDepth={sourceMeta.feedContentDepth ?? null}
      discovery={source.discovery}
      isHidden={source.isHidden ?? false}
    />
  );
}
```

with:

```tsx
{
  source.org && (
    <AdminOnly devAdmin={devAdmin}>
      <SourceAdminMenu
        orgSlug={source.org.slug}
        sourceSlug={source.slug}
        name={source.name}
        marketingFilter={sourceMeta.marketingFilter === true}
        marketingFilterHint={sourceMeta.marketingFilterHint ?? null}
        feedContentDepth={sourceMeta.feedContentDepth ?? null}
        discovery={source.discovery}
        isHidden={source.isHidden ?? false}
      />
    </AdminOnly>
  );
}
```

- [ ] **Step 4: Product view** — `web/src/app/[orgSlug]/[slug]/_views/product-view.tsx`. Add `import { AdminOnly } from "@/components/admin-only";`. Rename `const adminEnabled = isLocalAdminEnabled();` → `const devAdmin = isLocalAdminEnabled();`. Replace:

```tsx
{
  adminEnabled && (
    <div className="mt-2">
      <ProductAdminMenu
        orgSlug={orgSlug}
        productSlug={productSlug}
        name={product.name}
        notice={product.notice}
      />
    </div>
  );
}
```

with:

```tsx
<AdminOnly devAdmin={devAdmin}>
  <div className="mt-2">
    <ProductAdminMenu
      orgSlug={orgSlug}
      productSlug={productSlug}
      name={product.name}
      notice={product.notice}
    />
  </div>
</AdminOnly>
```

- [ ] **Step 5: Release page** — `web/src/app/release/[id]/page.tsx`. Add `import { AdminOnly } from "@/components/admin-only";`. Rename `const adminEnabled = isLocalAdminEnabled();` → `const devAdmin = isLocalAdminEnabled();`. Replace:

```tsx
{
  adminEnabled && (
    <span className="ml-auto">
      <ReleaseAdminMenu
        releaseId={release.id}
        redirectTo={sourcePath}
        rawJsonHref={`${API_URL}/v1/releases/${encodeURIComponent(release.id)}`}
      />
    </span>
  );
}
```

with:

```tsx
<AdminOnly devAdmin={devAdmin}>
  <span className="ml-auto">
    <ReleaseAdminMenu
      releaseId={release.id}
      redirectTo={sourcePath}
      rawJsonHref={`${API_URL}/v1/releases/${encodeURIComponent(release.id)}`}
    />
  </span>
</AdminOnly>
```

- [ ] **Step 6: Collections page** — `web/src/app/collections/[slug]/page.tsx`. Add `import { AdminOnly } from "@/components/admin-only";` and `import { isLocalAdminEnabled } from "@/lib/local-admin-flag";` if not already imported (it currently calls `isLocalAdminEnabled()` inline, so the import exists). Replace:

```tsx
{
  isLocalAdminEnabled() && (
    <div className="mt-3">
      <CollectionAdminMenu slug={slug} isFeatured={detail.isFeatured} />
    </div>
  );
}
```

with:

```tsx
<AdminOnly devAdmin={isLocalAdminEnabled()}>
  <div className="mt-3">
    <CollectionAdminMenu slug={slug} isFeatured={detail.isFeatured} />
  </div>
</AdminOnly>
```

- [ ] **Step 7: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add web/src/app/[orgSlug]/\(org\)/layout.tsx web/src/app/[orgSlug]/[slug]/layout.tsx web/src/app/sources/[id]/layout.tsx web/src/app/[orgSlug]/[slug]/_views/product-view.tsx web/src/app/release/[id]/page.tsx web/src/app/collections/[slug]/page.tsx
git commit -m "feat(web): gate entity admin menus on session role via AdminOnly"
```

### Task C3: Header "Admin" link visible to admin-role users

`header.tsx` passes `adminEnabled = isLocalAdminEnabled()` to `AccountNav` (and `MobileNav`, which forwards it to `AccountNav`'s mobile variant). Keep that prop as the **dev override** and OR the session role inside `AccountNav` (which already calls `useSession()`).

**Files:**

- Modify: `web/src/components/account-nav.tsx`

- [ ] **Step 1: Import the predicate** — add to the imports at the top of `web/src/components/account-nav.tsx`:

```tsx
import { computeIsAdmin } from "@/components/admin-only";
```

- [ ] **Step 2: Compute `showAdmin` from the session** — in `AccountNavInner`, just after `const user = data?.user;` (the line preceding the `if (variant === "mobile")` block), add:

```tsx
const role = (user as { role?: string } | undefined)?.role ?? null;
const showAdmin = computeIsAdmin(role, adminEnabled);
```

- [ ] **Step 3: Use `showAdmin` for both Admin links** — replace both occurrences of `{adminEnabled && (` that wrap an `<Link href="/admin" ...>` (the mobile variant and the desktop variant) with `{showAdmin && (`. Leave every other use of `adminEnabled` untouched.

- [ ] **Step 4: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add web/src/components/account-nav.tsx
git commit -m "feat(web): show header Admin link to admin-role users"
```

### Task C4: Server-side gate for the `/admin` hub pages

**Files:**

- Create: `web/src/lib/server-session.ts`
- Modify: `web/src/app/admin/page.tsx`, `web/src/app/admin/api-tokens/page.tsx`, `web/src/app/admin/site-notice/page.tsx`

- [ ] **Step 1: Create the server-session helper** — `web/src/lib/server-session.ts`:

```ts
import "server-only";
import { cookies } from "next/headers";
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
import { webApiHeaders } from "@/lib/api";
import { apiBaseUrl } from "./env";

/**
 * The caller's Better Auth role, read server-side by forwarding the session
 * cookie to the API's `/api/auth/get-session`. Returns null for anonymous
 * callers or on any failure (fail-closed). Used to gate the `/admin` hub pages;
 * it forces dynamic rendering, which is fine for these low-traffic, non-cached
 * routes.
 */
export async function getServerSessionRole(): Promise<string | null> {
  const base = apiBaseUrl();
  if (!base) return null;
  const cookie = (await cookies()).toString();
  if (!cookie) return null;
  try {
    const res = await fetch(`${base}/api/auth/get-session`, {
      headers: webApiHeaders({ Cookie: cookie }),
      cache: "no-store",
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { user?: { role?: string | null } } | null;
    return body?.user?.role ?? null;
  } catch {
    return null;
  }
}

/** True when the caller may view admin pages: the local-dev override, or an admin-role session. */
export async function isAdminViewer(): Promise<boolean> {
  if (isLocalAdminEnabled()) return true;
  return (await getServerSessionRole()) === "admin";
}
```

- [ ] **Step 2: Gate the hub page** — `web/src/app/admin/page.tsx`. Replace the import:

```tsx
import { isLocalAdminEnabled } from "@/lib/local-admin-flag";
```

with:

```tsx
import { isAdminViewer } from "@/lib/server-session";
```

and change the component to async + awaited gate. Replace:

```tsx
export default function AdminHubPage() {
  if (!isLocalAdminEnabled()) notFound();
```

with:

```tsx
export default async function AdminHubPage() {
  if (!(await isAdminViewer())) notFound();
```

- [ ] **Step 3: Gate the api-tokens page** — `web/src/app/admin/api-tokens/page.tsx`. Replace:

```tsx
import { isApiTokensAdminEnabled } from "@/lib/api-tokens-admin-flag";
```

with:

```tsx
import { isAdminViewer } from "@/lib/server-session";
```

and replace:

```tsx
if (!isApiTokensAdminEnabled()) notFound();
```

with:

```tsx
if (!(await isAdminViewer())) notFound();
```

(The page is already `async`.)

- [ ] **Step 4: Gate the site-notice page** — `web/src/app/admin/site-notice/page.tsx`. Replace:

```tsx
import { isSiteNoticeAdminEnabled } from "@/lib/site-notice-admin-flag";
```

with:

```tsx
import { isAdminViewer } from "@/lib/server-session";
```

and replace:

```tsx
if (!isSiteNoticeAdminEnabled()) notFound();
```

with:

```tsx
if (!(await isAdminViewer())) notFound();
```

(The page is already `async`.)

- [ ] **Step 5: Type-check**

Run: `cd web && npx tsc --noEmit`
Expected: no errors. (`isApiTokensAdminEnabled` / `isSiteNoticeAdminEnabled` may now be unused — that's fine; leave the flag files, since `api-tokens-admin-flag.ts` still exports `PRIMARY_OWNER`. Optionally delete `site-notice-admin-flag.ts` if nothing else imports it — verify with `rg "isSiteNoticeAdminEnabled" web/src` first.)

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/server-session.ts web/src/app/admin/page.tsx web/src/app/admin/api-tokens/page.tsx web/src/app/admin/site-notice/page.tsx
git commit -m "feat(web): server-side admin-role gate for the /admin hub pages"
```

---

## Phase D — Verification

### Task D1: Full type-check + tests + build

- [ ] **Step 1: Root + worker + web type-check**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit) && (cd web && npx tsc --noEmit)`
Expected: all clean.

- [ ] **Step 2: Run the test suite**

Run: `bun run test`
Expected: PASS. (Use `bun run test`, NOT bare `bun test` — the root script isolates `workers/api` in its own process; see AGENTS.md.) Confirm the new `jwtSessionPayload`, jwt-wiring, and `computeIsAdmin` tests are included and green.

- [ ] **Step 3: Web production build (lint + RSC boundaries + caching)**

Run: `cd web && bun run build`
Expected: build succeeds. Confirm the org/release/collection routes are NOT forced dynamic by the change (the `AdminOnly` client wrapper must not deopt them); only `/admin/*` may be dynamic. If the build marks an entity route dynamic, the cause is a server-side session read leaking into it — re-check that only `/admin/*` pages import `server-session`.

- [ ] **Step 4: Commit any incidental fixes, then summarize**

```bash
git add -A && git commit -m "chore: verification fixes for prod admin role gate" || echo "nothing to commit"
```

### Task D2: Manual smoke (local) + ops note

- [ ] **Step 1: Local dev unchanged** — with `dev:web` + `dev:api` running and `RELEASES_API_KEY` set in web env, confirm the org/source/product/release/collection admin menus and `/admin` still appear and function (local-dev override path). No regression.

- [ ] **Step 2: Document the production rollout prerequisites** (do NOT run against prod here — these are handoff notes for the user):
  - The web server (Vercel) must have `RELEASES_API_URL` pointing at `https://api.releases.sh` so `/api/auth/token` and `/api/auth/get-session` are reachable. (`RELEASES_API_KEY` is only needed for the local-dev path; production no longer relies on it for admin actions.)
  - Set the target user's role once: `releases admin user set-role <user> admin` (root-key gated).
  - After deploy, verify as that admin user on `https://releases.sh`: the entity admin menus appear, an edit (e.g. toggle org featured) succeeds, `/admin` loads, and an API-token mint works. Then verify a non-admin account: no menus, `/admin` 404s, and a forced admin action returns a 403 from the API.
  - Regression check (gate 2): confirm "Sign in with Releases" still works end-to-end (an OAuth client can still exchange a code for a usable access token) — guards the `jwt.issuer` no-op against real OAuth tokens.

- [ ] **Step 3: Final state** — open the PR per the team workflow (branch `worktree-prod-admin-role-gate`). Summarize: API change (jwt() config), web credential change (per-user JWT), UI gating (client menus + server `/admin`), and the two manual prod-verification steps above.
