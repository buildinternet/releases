# Better Auth Device Authorization — Phase 4 (CLI Login) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the Releases CLI a no-paste, browser-based `releases login` using the OAuth 2.0 Device Authorization Grant (RFC 8628), which mints a durable user-owned `relu_` API key on the lane that Phases 1–3 build — without replacing the web self-serve panel (the web app remains a first-class way to generate keys).

**Architecture:** Register Better Auth's `deviceAuthorization()` plugin (+ `bearer()`) on the per-request auth instance in `workers/api`, flag-gated behind `cli-device-auth-enabled`. The web app hosts the `/device` verification + `/device/approve` pages (a logged-in human approves the code). The CLI (`releases-cli`, a separate repo) runs the device flow over plain `fetch` — request code → open browser → poll for an access token (a Better Auth session) → exchange that session for a `relu_` key via the Phase-1 `@better-auth/api-key` create endpoint → store the `relu_` key in `~/.releases/credentials` exactly as `auth login` does today, then discard the session. The REST hot path is unchanged: it verifies the stored `relu_` key through the Phase-1 middleware branch.

**Tech Stack:** Cloudflare Workers, Hono, Better Auth 1.6.14 (`deviceAuthorization` + `bearer` from `better-auth/plugins`), `@better-auth/api-key` 1.6.14 (from Phase 1), Drizzle (D1 / `bun:sqlite` test fixtures), Next.js (web), Bun + commander + chalk (CLI), Bun test, TypeScript strict.

**Scope:** Phase 4 of the Better Auth key effort. It is **additive** to Phases 1–3 and depends on the `relu_` lane (Phase 1) plus the server-side scope cap (Phase 3). It spans **two repos**: the monorepo (server + web) and `releases-cli` (the CLI command). Each task is tagged `[MONOREPO]` or `[CLI REPO]`. It does **not** modify the `relk_` machine lane, the static root key, or the web API Keys panel.

---

## Prerequisites & integration seams (Phases 1–3 are in flight — reconcile at execution)

Phase 4 builds on code the other agent is still landing. Treat each item below as a **seam to confirm against the merged P1–3 code before you rely on it.** None of them block writing Phase 4's own code; they affect two call sites (the server plugin registration and the CLI key exchange).

1. **`relu_` lane + `@better-auth/api-key` plugin (P1).** Phase 4's minted keys only work if the Phase-1 middleware branch verifies `relu_` keys. **Confirm:** `@better-auth/api-key` is registered in `workers/api/src/auth/index.ts` and `middleware/auth.ts` has the `relu_` verify branch. If P1 hasn't merged, Phase 4's CLI login will mint a key that 401s — do not flip the prod flag until P1 is live.
2. **The api-key _create_ endpoint + Bearer-session acceptance.** The CLI exchanges the device session for a key by calling the api-key create endpoint with `Authorization: Bearer <device access token>`. This requires the `bearer()` plugin (Task 2 adds it) so Better Auth resolves the session from the header. **Confirm:** the create route path (assumed `POST /api/auth/api-key/create`) and the request body shape against the installed `@better-auth/api-key` reference/OpenAPI. If the path or body differs, fix it in `releases-cli/src/lib/device-auth.ts` (Task 5, `createUserApiKey`) only.
3. **Server-side scope cap (P3, design §8.5).** The device/CLI create path must be capped at `write` server-side (operator-only `admin`), since Phase 4 has no UI to enforce it. **Confirm:** the cap is enforced at the _create endpoint_ (a create hook/validator), not only in the web panel UI. If P3 enforces it UI-side only, the device path can over-grant — gate the prod rollout (Task 9) on the server-side cap existing.
4. **Permission encoding (`scopeToPermissions`, P1 `workers/api/src/auth/api-key-scope.ts`).** Phase 1 encodes the ladder as cumulative actions on one `api` resource (`read`→`["read"]`, `write`→`["read","write"]`). The CLI carries its **own** 3-line copy of this mapping (`scopeToApiPermissions`, Task 5) because the thin client must not import worker code. **Confirm:** the encoding still matches; if P1 changes the resource name or shape, update the CLI helper. (Low risk — it's a documented, stable decision.)
5. **`user-api-keys-enabled` flag (P1).** `relu_` verification is gated by this flag. Phase 4's `cli-device-auth-enabled` flag is **independent** but functionally depends on it: device login is only end-to-end useful when _both_ are on. Documented in the Task 1 flag comment; enforced operationally in the Task 9 rollout, not in code.
6. **Exact Better Auth endpoint paths.** This plan assumes the standard handler paths: `POST /api/auth/device/code`, `POST /api/auth/device/token`, `GET /api/auth/device`, `POST /api/auth/device/approve`, `POST /api/auth/device/deny`, and `GET /api/auth/get-session`. **Confirm** against the auth instance's OpenAPI (`/api/auth/reference`) at execution; the plugin is minified so the literals weren't machine-verifiable when this plan was written. The client methods (`auth.api.deviceCode`, `authClient.device.code`, etc.) are stable.

---

## As-built reconciliation (implemented 2026-06-05, after P1–3 merged)

The seams above resolved as follows once the api-key lane (PRs #1434/#1435/#1444) was on `main`. Deltas from the plan-as-written:

1. **Flag name.** Shipped as **`device-authorization-enabled`** (env `DEVICE_AUTHORIZATION_ENABLED`), not the placeholder `cli-device-auth-enabled`. Web reveal flag: `NEXT_PUBLIC_DEVICE_AUTH_ENABLED`.
2. **Key-exchange endpoint (the big one).** The CLI does **not** call Better Auth's raw `POST /api/auth/api-key/create`. The web panel and CLI both use the worker's own **`POST /v1/api-keys`** route (`workers/api/src/routes/user-api-keys.ts`), which runs under `requireSession`, injects the owner from the session, and caps the scope. Body is **`{ name, scope }`** (scope = `"read" | "write"`), not a client-built `permissions` map. The device-flow access token rides as `Authorization: Bearer …`, honored because we register **`bearer()`**.
3. **Server-side scope cap.** Enforced in the `/v1/api-keys` POST handler (`isSelfServeScope` → 400 on anything but read/write). The device path inherits it for free by reusing that route.
4. **Permission encoding.** Owned entirely server-side (`scopeToPermissions` in `workers/api/src/auth/api-key-scope.ts`). The CLI's local `scopeToApiPermissions` copy was **deleted** — it sends `scope` and the server encodes.
5. **`user-api-keys-enabled` dependency.** Unchanged: device login mints `relu_` keys via `/v1/api-keys`, which is gated on `user-api-keys-enabled`. Both flags must be on for end-to-end login. The two flag reads are batched with `Promise.all`.
6. **Endpoint paths.** Confirmed verbatim against the installed `better-auth@1.6.14` device-authorization bundle.

**New finding not in the plan — zod skew.** `better-auth@1.6.14`'s `deviceAuthorization()` options schema marks its `schema` field nonoptional-by-omission; the root-resolved **zod@4.4.3** rejects a missing value (`"expected nonoptional"`). Fix: pass `schema: {}` at the call site (an additive `mergeSchema` no-op). Necessary for prod, not just tests. See `[[reference_mcp_worker_zod_pinned_to_sdk_nested]]`.

**Shared client-id contract.** `DEVICE_AUTH_CLIENT_ID = "releases-cli"` lives in `@buildinternet/releases-core/api-token` (next to `USER_API_KEY_PREFIX`); the worker's `validateClient` allow-list rejects anything else (fail closed). The CLI hard-codes the same literal until it adopts the published core version exposing it.

---

## File Structure

**[MONOREPO] Create:**

- `workers/api/migrations/20260604040000_add_device_code.sql` — DDL for the Better Auth `deviceCode` table.
- `tests/api/device-auth-plugin.test.ts` — table-exists + `deviceCode`/`validateClient` integration (test DB).
- `web/src/app/device/page.tsx` — user-code verification page (claims the pending code for the session).
- `web/src/app/device/approve/page.tsx` — approve/deny page.

**[MONOREPO] Modify:**

- `workers/api/src/db/schema-auth.ts` — add the `deviceCode` Drizzle table + type.
- `packages/lib/src/flags.ts` — add the `cliDeviceAuthEnabled` flag.
- `workers/api/src/index.ts` — add `CLI_DEVICE_AUTH_ENABLED` + `WEB_APP_ORIGIN` to the `Env` bindings.
- `workers/api/wrangler.jsonc` — add `CLI_DEVICE_AUTH_ENABLED` + `WEB_APP_ORIGIN` vars (prod + staging blocks).
- `workers/api/src/auth/index.ts` — register `deviceAuthorization()` + `bearer()` (flag-gated) with `validateClient`; add `deviceCode` to the drizzle adapter schema map.
- `web/src/lib/auth-client.ts` — add `deviceAuthorizationClient()` to the client plugins.
- `docs/architecture/remote-mode.md` + `AGENTS.md` — document the device-auth login lane.

**[CLI REPO] Create:** (`/Users/zachdunn/Code/releases-cli`)

- `src/lib/device-auth.ts` — device-flow client (plain `fetch`): `requestDeviceCode`, `pollForToken`, `getSessionUser`, `createUserApiKey`, `scopeToApiPermissions`, `runDeviceLogin`.
- `src/lib/open-browser.ts` — OS-detecting browser opener (`browserCommand` + `openBrowser`).
- `src/cli/commands/login.ts` — the top-level `releases login` command (thin wrapper over `runDeviceLogin`).
- `tests/unit/device-auth.test.ts` — unit tests for the device-flow helpers + `runDeviceLogin` (injected deps).
- `tests/unit/open-browser.test.ts` — unit tests for `browserCommand`.

**[CLI REPO] Modify:**

- `src/cli/program.ts` — import + register the `login` command.

**Untouched on purpose:** the `relk_` machine lane, `RELEASES_API_KEY` root, the existing `auth login`/`logout`/`status`/`token` subcommands (paste path stays), the Phase-1/2/3 files, and the web API Keys panel.

---

## Task 1: `[MONOREPO]` `deviceCode` table, migration, flag, and env bindings

**Files:**

- Modify: `workers/api/src/db/schema-auth.ts`
- Create: `workers/api/migrations/20260604040000_add_device_code.sql`
- Modify: `packages/lib/src/flags.ts`
- Modify: `workers/api/src/index.ts`
- Modify: `workers/api/wrangler.jsonc`
- Test: `tests/api/device-auth-plugin.test.ts` (table-exists first; integration in Task 2)

- [ ] **Step 1: Generate the canonical `deviceCode` schema to verify column shape**

The exact columns/types for the installed plugin version are authoritative from the Better Auth CLI (the plugin is minified; don't hand-guess). Temporarily register `deviceAuthorization()` (you formalize this in Task 2) or run the generator against a scratch config, then read the emitted `deviceCode` model:

Run: `bunx @better-auth/cli@1.6.14 generate --help`
Then generate the schema for an auth config that includes `deviceAuthorization()` and read the emitted `deviceCode` model.
Expected: a table named `deviceCode` with columns covering at least: `id`, `deviceCode`, `userCode`, `userId` (optional), `clientId` (optional), `scope` (optional), `status`, `expiresAt`, `lastPolledAt` (optional), `pollingInterval` (optional), and Better Auth's standard `createdAt`/`updatedAt` if present. **Reconcile Steps 2–3 to the generator output** — if a column name/type differs, the generator wins.

- [ ] **Step 2: Add the Drizzle table**

In `workers/api/src/db/schema-auth.ts`, after the last existing Better Auth table (before the `export type` block), add (snake_case columns, integer timestamp mode — match the rest of this file; reconcile to Step 1 output):

```ts
/**
 * Better Auth device-authorization plugin (`deviceAuthorization`) store — the
 * short-lived device/user code pairs for the RFC 8628 CLI login flow. `status`
 * is pending|approved|denied; `userId` is set once a logged-in human approves
 * the user code on /device/approve. Rows are ephemeral (expire in minutes).
 * Column set is mandated by the plugin — reconcile with `@better-auth/cli
 * generate`. Paired migration: 20260604040000_add_device_code.sql.
 */
export const deviceCode = sqliteTable(
  "deviceCode",
  {
    id: text("id").primaryKey(),
    deviceCode: text("device_code").notNull(),
    userCode: text("user_code").notNull(),
    userId: text("user_id"),
    clientId: text("client_id"),
    scope: text("scope"),
    status: text("status").notNull(),
    expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
    lastPolledAt: integer("last_polled_at", { mode: "timestamp" }),
    pollingInterval: integer("polling_interval"),
    createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp" }).notNull(),
  },
  (t) => [
    index("idx_device_code_device_code").on(t.deviceCode),
    index("idx_device_code_user_code").on(t.userCode),
  ],
);
```

Then add to the `export type` block at the bottom:

```ts
export type AuthDeviceCode = typeof deviceCode.$inferSelect;
```

(If `index`/`sqliteTable`/`integer`/`text` aren't already imported at the top of the file, they are — this file already defines `sqliteTable` tables with indexes; reuse the existing imports.)

- [ ] **Step 3: Write the migration**

Create `workers/api/migrations/20260604040000_add_device_code.sql` (mirror Step 2 exactly; reconcile to the generator output):

```sql
-- Better Auth device-authorization plugin (deviceAuthorization) store — the
-- short-lived device/user code pairs for the RFC 8628 CLI login flow. Paired
-- with the `deviceCode` table in workers/api/src/db/schema-auth.ts (the
-- schema<->migration pairing gate in ci.yml watches that file). Rows are
-- ephemeral (expire in minutes). Reconcile columns with `@better-auth/cli generate`.
CREATE TABLE deviceCode (
  id text PRIMARY KEY NOT NULL,
  device_code text NOT NULL,
  user_code text NOT NULL,
  user_id text,
  client_id text,
  scope text,
  status text NOT NULL,
  expires_at integer NOT NULL,
  last_polled_at integer,
  polling_interval integer,
  created_at integer NOT NULL,
  updated_at integer NOT NULL
);
CREATE INDEX idx_device_code_device_code ON deviceCode (device_code);
CREATE INDEX idx_device_code_user_code ON deviceCode (user_code);
```

- [ ] **Step 4: Add the flag to the registry**

In `packages/lib/src/flags.ts`, in the `FLAGS` object after the `userApiKeysEnabled` entry (added in Phase 1; if Phase 1 hasn't merged, add it after `apiTokensDisabled`), add:

```ts
  // Rollout gate (#TBD-issue): the CLI device-authorization login flow. default:
  // false → OFF until the /device pages ship + P1's relu_ lane is live. When on,
  // the API worker registers deviceAuthorization() + bearer(). Functionally
  // depends on userApiKeysEnabled (a minted relu_ key only verifies when that is
  // also on). Flip on in BOTH Flagship apps.
  cliDeviceAuthEnabled: {
    key: "cli-device-auth-enabled",
    env: "CLI_DEVICE_AUTH_ENABLED",
    default: false,
  },
```

- [ ] **Step 5: Add the Env bindings**

In `workers/api/src/index.ts`, next to the other optional string bindings (near `API_TOKENS_DISABLED?: string;`), add:

```ts
    CLI_DEVICE_AUTH_ENABLED?: string;
    // Origin of the web app that hosts the /device verification pages (NOT the
    // API worker origin). Used to build the device flow's verification_uri.
    WEB_APP_ORIGIN?: string;
```

- [ ] **Step 6: Add the wrangler vars**

In `workers/api/wrangler.jsonc`, in the top-level `"vars"` block add `"CLI_DEVICE_AUTH_ENABLED": "false"` and `"WEB_APP_ORIGIN": "https://releases.sh"`; add the same two lines to the `"env": { "staging": { "vars": { ... } } }` block (use the staging web origin, or `"https://releases.sh"` if staging has no distinct web host). Match the existing quoting/trailing-comma style.

- [ ] **Step 7: Write the table-exists test**

Create `tests/api/device-auth-plugin.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { deviceCode } from "../../workers/api/src/db/schema-auth.js";

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

describe("deviceCode table", () => {
  it("is created by the migration and is queryable", () => {
    h = createTestDb();
    const rows = h.db.select().from(deviceCode).all();
    expect(rows).toEqual([]);
  });
});
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `bun test tests/api/device-auth-plugin.test.ts`
Expected: PASS (the harness applies `20260604040000_add_device_code.sql`; `SELECT` returns `[]`). If FAIL with "no such table: deviceCode", the migration filename sort or DDL is wrong.

- [ ] **Step 9: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: PASS (new optional bindings recognized; nothing references them yet).

- [ ] **Step 10: Commit**

```bash
git add workers/api/src/db/schema-auth.ts workers/api/migrations/20260604040000_add_device_code.sql packages/lib/src/flags.ts workers/api/src/index.ts workers/api/wrangler.jsonc tests/api/device-auth-plugin.test.ts
git commit -m "feat(auth): add deviceCode table + cli-device-auth flag + env bindings"
```

> **Manual follow-up (not a code step):** create the `cli-device-auth-enabled` key in BOTH Flagship apps (`releases-platform` and `releases-platform-staging`), default OFF, before relying on it in prod.

---

## Task 2: `[MONOREPO]` Register `deviceAuthorization()` + `bearer()` (flag-gated) with `validateClient`

**Files:**

- Modify: `workers/api/src/auth/index.ts`
- Test: `tests/api/device-auth-plugin.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/api/device-auth-plugin.test.ts`:

```ts
import { createAuth } from "../../workers/api/src/auth/index.js";

// Minimal env: not production, device-auth ON, a fixed web origin + secret. Cast —
// tests don't need the full Env.
function testEnv() {
  return {
    ENVIRONMENT: "test",
    BETTER_AUTH_SECRET: "test-secret-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    CLI_DEVICE_AUTH_ENABLED: "true",
    WEB_APP_ORIGIN: "https://releases.sh",
    // oxlint-disable-next-line no-explicit-any
  } as any;
}

describe("deviceAuthorization plugin", () => {
  it("issues a device + user code with the web-app verification_uri", async () => {
    h = createTestDb();
    const auth = await createAuth(testEnv(), undefined, { db: h.db });
    const res = await auth.api.deviceCode({
      body: { client_id: "releases-cli", scope: "write" },
    });
    expect(res.device_code).toBeTruthy();
    expect(res.user_code).toBeTruthy();
    expect(res.verification_uri).toBe("https://releases.sh/device");
  });

  it("rejects an unknown client_id via validateClient", async () => {
    h = createTestDb();
    const auth = await createAuth(testEnv(), undefined, { db: h.db });
    await expect(
      auth.api.deviceCode({ body: { client_id: "not-our-cli", scope: "read" } }),
    ).rejects.toBeDefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/device-auth-plugin.test.ts -t "deviceAuthorization plugin"`
Expected: FAIL (`auth.api.deviceCode` is undefined — plugin not registered).

- [ ] **Step 3: Register the plugins**

In `workers/api/src/auth/index.ts`:

(a) Add the imports after the existing `better-auth/plugins` imports (top of file):

```ts
import { deviceAuthorization, bearer } from "better-auth/plugins";
```

(If a plugin import line from `better-auth/plugins` already exists, merge `deviceAuthorization, bearer` into it.)

(b) Add the `deviceCode` table to the local schema imports (alongside `user, session, account, verification, rateLimit`, and `apikey` if Phase 1 added it):

```ts
import { deviceCode } from "../db/schema-auth.js";
```

(If Phase 1 already imports tables as a group from `schema-auth.js`, add `deviceCode` to that import.)

(c) Ensure the flag helper is imported (Phase 1 likely already added `FLAGS, flag` from `@releases/lib/flags`; if not, add it):

```ts
import { FLAGS, flag } from "@releases/lib/flags";
```

(d) Resolve the flag just before the `plugins` array is built (next to Phase 1's `userApiKeysOn` resolve, if present):

```ts
// CLI device-authorization login (relu_ via RFC 8628) is a flagged rollout. When
// off, neither the device endpoints nor the Bearer-session bridge are registered.
// Flag order: Flagship -> var -> default(false).
const cliDeviceAuthOn = await flag(
  env.FLAGS,
  env.CLI_DEVICE_AUTH_ENABLED,
  FLAGS.cliDeviceAuthEnabled,
);
```

(e) Add the `deviceCode` table to the drizzle adapter schema map (the `schema: { ... }` object passed to `drizzleAdapter`):

```ts
      schema: { user, session, account, verification, rateLimit, apikey, deviceCode },
```

(If Phase 1's `apikey` isn't merged yet, omit it — add only `deviceCode`.)

(f) Add the plugins to the `plugins` array literal, gated:

```ts
    ...(cliDeviceAuthOn
      ? [
          // Lets a Better Auth session be carried as `Authorization: Bearer`, so
          // the CLI can present the device-flow access token to the api-key create
          // endpoint (which is otherwise cookie-gated). Required by the CLI exchange.
          bearer(),
          deviceAuthorization({
            // The verification page lives on the WEB app, not this worker. Absolute
            // URL so `verification_uri` points the human at releases.sh/device.
            verificationUri: `${env.WEB_APP_ORIGIN ?? "https://releases.sh"}/device`,
            expiresIn: "15m",
            interval: "5s",
            // Only our CLI may run the flow. Constant for now; widen to an env-driven
            // allowlist if other first-party clients adopt it.
            validateClient: async (clientId: string) => clientId === "releases-cli",
          }),
        ]
      : []),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/api/device-auth-plugin.test.ts`
Expected: PASS (codes issued; verification_uri is `https://releases.sh/device`; unknown client rejected). If `deviceCode` rejects on a missing column, re-check Task 1 Step 1 (generator reconcile). If `verification_uri` is relative, the `verificationUri` option didn't take the absolute origin — re-check Step 3(f).

- [ ] **Step 5: Run the auth suite to confirm no regression**

Run: `bun test tests/api/`
Expected: PASS — existing auth/token behavior unchanged (the new plugins are flag-gated and off by default in those tests).

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/auth/index.ts tests/api/device-auth-plugin.test.ts
git commit -m "feat(auth): register deviceAuthorization + bearer plugins (flag-gated, releases-cli only)"
```

---

## Task 3: `[MONOREPO]` Web `deviceAuthorizationClient()` + `/device` verification page

**Files:**

- Modify: `web/src/lib/auth-client.ts`
- Create: `web/src/app/device/page.tsx`

- [ ] **Step 1: Add the client plugin**

In `web/src/lib/auth-client.ts`:

(a) Extend the plugins import:

```ts
import {
  oneTapClient,
  magicLinkClient,
  deviceAuthorizationClient,
} from "better-auth/client/plugins";
```

(b) Add it to the `plugins` array (unconditional — it only exposes the `device.*` methods; inert until called), after `magicLinkClient()`:

```ts
    // Device authorization (RFC 8628) — registers authClient.device(),
    // device.approve(), device.deny() used by the /device pages. Inert otherwise.
    deviceAuthorizationClient(),
```

- [ ] **Step 2: Create the verification page**

Create `web/src/app/device/page.tsx`. It claims the pending code for the logged-in session (per the plugin's security model: the verifying session is the only one that can approve), then forwards to the approve page. No emojis / arrow glyphs (house rule). Adapt to the project's existing component/styling conventions; the logic is what matters:

```tsx
"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";

function DeviceVerifyInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: session } = authClient.useSession();
  const [userCode, setUserCode] = useState(params.get("user_code") ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);

    // Normalize: strip dashes, uppercase (codes are entered as ABCD-1234).
    const code = userCode.trim().replace(/-/g, "").toUpperCase();
    const verifyPath = `/device?user_code=${encodeURIComponent(code)}`;

    // The verifying session must be authenticated — it binds the pending code to
    // this user, and only this session can later approve/deny.
    if (!session?.user) {
      router.push(`/login?redirect=${encodeURIComponent(verifyPath)}`);
      return;
    }

    const res = await authClient.device({ query: { user_code: code } });
    if (res.error) {
      setError("That code is invalid or has expired. Request a new one from the CLI.");
      setBusy(false);
      return;
    }
    router.push(`/device/approve?user_code=${encodeURIComponent(code)}`);
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-xl font-semibold">Connect a device</h1>
      <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
        Enter the code shown in your terminal to connect the Releases CLI to your account.
      </p>
      <form onSubmit={handleSubmit} className="mt-6 flex flex-col gap-3">
        <input
          type="text"
          inputMode="text"
          autoComplete="off"
          autoFocus
          value={userCode}
          onChange={(e) => setUserCode(e.target.value)}
          placeholder="ABCD-1234"
          maxLength={12}
          className="rounded border border-stone-300 px-3 py-2 font-mono tracking-widest dark:border-stone-700 dark:bg-stone-900"
        />
        <button
          type="submit"
          disabled={busy || userCode.trim().length === 0}
          className="rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
        >
          Continue
        </button>
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </main>
  );
}

export default function DeviceVerifyPage() {
  return (
    <Suspense fallback={null}>
      <DeviceVerifyInner />
    </Suspense>
  );
}
```

> **Seam:** `/login?redirect=` is the project's existing convention (`web/src/components/auth-form.tsx`). The `@/` alias and Tailwind classes follow the existing web app; if the alias or styling differs in a reviewed file you touch, match that file. Confirm `authClient.device({ query })` and `useSession()` exist after Step 1 (they come from the client plugin).

- [ ] **Step 3: Type-check the web app**

Run: `cd web && npx tsc --noEmit`
Expected: PASS. If `authClient.device` is untyped, confirm Step 1 added the client plugin and re-run.

- [ ] **Step 4: Commit**

```bash
git add web/src/lib/auth-client.ts web/src/app/device/page.tsx
git commit -m "feat(web): device-authorization client + /device verification page"
```

---

## Task 4: `[MONOREPO]` Web `/device/approve` approve/deny page

**Files:**

- Create: `web/src/app/device/approve/page.tsx`

- [ ] **Step 1: Create the approve page**

Create `web/src/app/device/approve/page.tsx`:

```tsx
"use client";

import { useState, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { authClient } from "@/lib/auth-client";

function DeviceApproveInner() {
  const router = useRouter();
  const params = useSearchParams();
  const { data: session } = authClient.useSession();
  const userCode = params.get("user_code") ?? "";
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<"approved" | "denied" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!session?.user) {
    const verifyPath = `/device?user_code=${encodeURIComponent(userCode)}`;
    router.push(`/login?redirect=${encodeURIComponent(verifyPath)}`);
    return null;
  }

  async function act(kind: "approve" | "deny") {
    setBusy(true);
    setError(null);
    const res =
      kind === "approve"
        ? await authClient.device.approve({ userCode })
        : await authClient.device.deny({ userCode });
    if (res.error) {
      setError("Something went wrong. The code may have expired — request a new one from the CLI.");
      setBusy(false);
      return;
    }
    setDone(kind === "approve" ? "approved" : "denied");
    setBusy(false);
  }

  if (done) {
    return (
      <main className="mx-auto max-w-md px-4 py-16">
        <h1 className="text-xl font-semibold">
          {done === "approved" ? "Device connected" : "Request denied"}
        </h1>
        <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
          {done === "approved"
            ? "You can return to your terminal — the CLI is now signed in."
            : "No access was granted. You can close this page."}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md px-4 py-16">
      <h1 className="text-xl font-semibold">Authorize the Releases CLI</h1>
      <p className="mt-2 text-sm text-stone-600 dark:text-stone-400">
        Signed in as <span className="font-medium">{session.user.email}</span>. A device with code{" "}
        <span className="font-mono">{userCode}</span> is requesting access to your account.
      </p>
      <div className="mt-6 flex gap-3">
        <button
          onClick={() => act("approve")}
          disabled={busy || userCode.length === 0}
          className="rounded bg-stone-900 px-4 py-2 text-white disabled:opacity-50 dark:bg-stone-100 dark:text-stone-900"
        >
          Approve
        </button>
        <button
          onClick={() => act("deny")}
          disabled={busy || userCode.length === 0}
          className="rounded border border-stone-300 px-4 py-2 disabled:opacity-50 dark:border-stone-700"
        >
          Deny
        </button>
      </div>
      {error && <p className="mt-4 text-sm text-red-600">{error}</p>}
    </main>
  );
}

export default function DeviceApprovePage() {
  return (
    <Suspense fallback={null}>
      <DeviceApproveInner />
    </Suspense>
  );
}
```

- [ ] **Step 2: Type-check the web app**

Run: `cd web && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add web/src/app/device/approve/page.tsx
git commit -m "feat(web): /device/approve approve-or-deny page"
```

---

## Task 5: `[CLI REPO]` Device-flow client helpers

> All paths below are under `/Users/zachdunn/Code/releases-cli`. ESM with `.js` import suffixes; Bun test; chalk + commander already present.

**Files:**

- Create: `src/lib/device-auth.ts`
- Test: `tests/unit/device-auth.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/device-auth.test.ts`. Use the base URL `https://test.example.com` (the CLI's `getApiUrl()` memoizes its first value process-wide — see the repo's getApiUrl test gotcha) and inject a fake `fetch`:

```ts
import { describe, it, expect } from "bun:test";
import {
  scopeToApiPermissions,
  requestDeviceCode,
  pollForToken,
} from "../../src/lib/device-auth.js";

const BASE = "https://test.example.com";

describe("scopeToApiPermissions", () => {
  it("maps read/write to cumulative api actions", () => {
    expect(scopeToApiPermissions("read")).toEqual({ api: ["read"] });
    expect(scopeToApiPermissions("write")).toEqual({ api: ["read", "write"] });
  });
});

describe("requestDeviceCode", () => {
  it("POSTs client_id + scope and returns the code payload", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const fakeFetch = (async (url: string, init?: RequestInit) => {
      seen = { url, body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({
          device_code: "dev123",
          user_code: "ABCD1234",
          verification_uri: "https://releases.sh/device",
          verification_uri_complete: "https://releases.sh/device?user_code=ABCD1234",
          expires_in: 900,
          interval: 5,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const res = await requestDeviceCode(BASE, "write", fakeFetch);
    expect(res.user_code).toBe("ABCD1234");
    expect(seen!.url).toBe(`${BASE}/api/auth/device/code`);
    expect(seen!.body).toEqual({ client_id: "releases-cli", scope: "write" });
  });
});

describe("pollForToken", () => {
  it("returns the access_token after an authorization_pending round", async () => {
    let call = 0;
    const fakeFetch = (async () => {
      call += 1;
      if (call === 1) {
        return new Response(JSON.stringify({ error: "authorization_pending" }), {
          status: 400,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ access_token: "tok_abc" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const token = await pollForToken(BASE, "dev123", {
      intervalSeconds: 0, // no real waiting in tests
      expiresInSeconds: 60,
      fetchImpl: fakeFetch,
      sleep: async () => {},
    });
    expect(token).toBe("tok_abc");
    expect(call).toBe(2);
  });

  it("throws when the user denies", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: "access_denied" }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    await expect(
      pollForToken(BASE, "dev123", {
        intervalSeconds: 0,
        expiresInSeconds: 60,
        fetchImpl: fakeFetch,
        sleep: async () => {},
      }),
    ).rejects.toThrow(/denied/i);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/device-auth.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the helpers**

Create `src/lib/device-auth.ts`:

```ts
/**
 * RFC 8628 device-authorization client for `releases login`. Plain `fetch`
 * against the API worker's Better Auth handler — no `better-auth` dependency, so
 * the thin client stays thin. The flow: request a device+user code, have the
 * human approve it in a browser, poll for a session access token, then exchange
 * that session for a durable `relu_` API key (created server-side, capped at the
 * requested scope) and hand it back to the caller to store.
 */

const CLIENT_ID = "releases-cli";
const GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export type UserScope = "read" | "write";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval?: number;
}

/**
 * Cumulative `api`-resource actions matching the server's Phase-1 permission
 * encoding (`workers/api/src/auth/api-key-scope.ts`). Kept as a local copy so the
 * CLI doesn't import worker code; reconcile if the server encoding changes.
 */
export function scopeToApiPermissions(scope: UserScope): Record<string, string[]> {
  return scope === "write" ? { api: ["read", "write"] } : { api: ["read"] };
}

export async function requestDeviceCode(
  apiUrl: string,
  scope: UserScope,
  fetchImpl: typeof fetch = fetch,
): Promise<DeviceCodeResponse> {
  const res = await fetchImpl(`${apiUrl}/api/auth/device/code`, {
    method: "POST",
    headers: { "content-type": "application/json", "user-agent": CLIENT_ID },
    body: JSON.stringify({ client_id: CLIENT_ID, scope }),
  });
  if (!res.ok) {
    throw new Error(`Could not start device login (HTTP ${res.status}).`);
  }
  return (await res.json()) as DeviceCodeResponse;
}

export interface PollOptions {
  intervalSeconds: number;
  expiresInSeconds: number;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll the token endpoint until approval, denial, or expiry. Returns the access token. */
export async function pollForToken(
  apiUrl: string,
  deviceCode: string,
  opts: PollOptions,
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  let interval = Math.max(0, opts.intervalSeconds);
  const deadline = Date.now() + opts.expiresInSeconds * 1000;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (Date.now() > deadline) {
      throw new Error("Device code expired before it was approved. Run `releases login` again.");
    }
    await sleep(interval * 1000);

    const res = await fetchImpl(`${apiUrl}/api/auth/device/token`, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": CLIENT_ID },
      body: JSON.stringify({
        grant_type: GRANT_TYPE,
        device_code: deviceCode,
        client_id: CLIENT_ID,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };

    if (data.access_token) return data.access_token;

    switch (data.error) {
      case "authorization_pending":
        continue;
      case "slow_down":
        interval += 5;
        continue;
      case "access_denied":
        throw new Error("Authorization was denied in the browser.");
      case "expired_token":
        throw new Error("Device code expired before it was approved. Run `releases login` again.");
      default:
        throw new Error(
          `Device login failed: ${data.error_description ?? data.error ?? "unknown error"}`,
        );
    }
  }
}

export interface SessionUser {
  email: string;
  name?: string;
}

/** Fetch the user behind a device-flow access token (for the "Logged in as" greeting). */
export async function getSessionUser(
  apiUrl: string,
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SessionUser | null> {
  const res = await fetchImpl(`${apiUrl}/api/auth/get-session`, {
    headers: { authorization: `Bearer ${accessToken}`, "user-agent": CLIENT_ID },
  });
  if (!res.ok) return null;
  const data = (await res.json().catch(() => null)) as { user?: SessionUser } | null;
  return data?.user ?? null;
}

export interface CreatedKey {
  key: string;
  name?: string;
  scopes?: string[];
}

/**
 * Exchange the device-flow session for a durable `relu_` API key. Calls the
 * Phase-1 `@better-auth/api-key` create endpoint with the session as a Bearer
 * token (requires the server `bearer()` plugin). The server caps the scope.
 *
 * Seam: confirm the create path + body against the installed plugin (see the
 * plan's Prerequisites §2). If the endpoint differs, change it here only.
 */
export async function createUserApiKey(
  apiUrl: string,
  accessToken: string,
  name: string,
  scope: UserScope,
  fetchImpl: typeof fetch = fetch,
): Promise<CreatedKey> {
  const res = await fetchImpl(`${apiUrl}/api/auth/api-key/create`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      "user-agent": CLIENT_ID,
    },
    body: JSON.stringify({ name, permissions: scopeToApiPermissions(scope) }),
  });
  if (!res.ok) {
    throw new Error(`Login succeeded but issuing an API key failed (HTTP ${res.status}).`);
  }
  return (await res.json()) as CreatedKey;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/device-auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/device-auth.ts tests/unit/device-auth.test.ts
git commit -m "feat(cli): RFC 8628 device-flow client helpers (plain fetch)"
```

---

## Task 6: `[CLI REPO]` Browser opener

**Files:**

- Create: `src/lib/open-browser.ts`
- Test: `tests/unit/open-browser.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/open-browser.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { browserCommand } from "../../src/lib/open-browser.js";

describe("browserCommand", () => {
  it("uses `open` on macOS", () => {
    expect(browserCommand("darwin", "https://x")).toEqual({ cmd: "open", args: ["https://x"] });
  });
  it("uses cmd/start on Windows", () => {
    expect(browserCommand("win32", "https://x")).toEqual({
      cmd: "cmd",
      args: ["/c", "start", "", "https://x"],
    });
  });
  it("uses xdg-open elsewhere", () => {
    expect(browserCommand("linux", "https://x")).toEqual({ cmd: "xdg-open", args: ["https://x"] });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/open-browser.test.ts`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the opener**

Create `src/lib/open-browser.ts`:

```ts
import { spawn } from "node:child_process";

/** Resolve the OS-specific command to open a URL in the default browser. */
export function browserCommand(
  platform: NodeJS.Platform,
  url: string,
): { cmd: string; args: string[] } {
  if (platform === "darwin") return { cmd: "open", args: [url] };
  if (platform === "win32") return { cmd: "cmd", args: ["/c", "start", "", url] };
  return { cmd: "xdg-open", args: [url] };
}

/**
 * Best-effort: open `url` in the default browser, detached. Returns false if the
 * launch throws (headless box, missing opener) so the caller can fall back to
 * printing the URL for manual opening. Never throws.
 */
export function openBrowser(url: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    const { cmd, args } = browserCommand(platform, url);
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/open-browser.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/open-browser.ts tests/unit/open-browser.test.ts
git commit -m "feat(cli): OS-detecting browser opener with headless fallback"
```

---

## Task 7: `[CLI REPO]` `runDeviceLogin` orchestration + `releases login` command

**Files:**

- Modify: `src/lib/device-auth.ts` (add `runDeviceLogin`)
- Create: `src/cli/commands/login.ts`
- Modify: `src/cli/program.ts`
- Test: `tests/unit/device-auth.test.ts` (extend)

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/device-auth.test.ts`:

```ts
import { runDeviceLogin } from "../../src/lib/device-auth.js";

describe("runDeviceLogin", () => {
  it("returns a stored-credential payload on success", async () => {
    const apiUrl = "https://test.example.com";
    let opened: string | null = null;
    const printed: string[] = [];

    const fakeFetch = (async (url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.endsWith("/api/auth/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "dev123",
            user_code: "ABCD1234",
            verification_uri: `${apiUrl}/device`,
            verification_uri_complete: `${apiUrl}/device?user_code=ABCD1234`,
            expires_in: 900,
            interval: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (u.endsWith("/api/auth/device/token")) {
        return new Response(JSON.stringify({ access_token: "tok_abc" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/api/auth/get-session")) {
        return new Response(JSON.stringify({ user: { email: "z@example.com", name: "Zach" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (u.endsWith("/api/auth/api-key/create")) {
        return new Response(
          JSON.stringify({
            key: "relu_secretkey",
            name: "releases-cli",
            scopes: ["read", "write"],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      throw new Error(`unexpected url ${u}`);
    }) as unknown as typeof fetch;

    const result = await runDeviceLogin({
      apiUrl,
      scope: "write",
      openInBrowser: true,
      deps: {
        fetchImpl: fakeFetch,
        sleep: async () => {},
        openBrowser: (url) => {
          opened = url;
          return true;
        },
        print: (line) => printed.push(line),
        keyName: "releases-cli (testhost)",
      },
    });

    expect(result.token).toBe("relu_secretkey");
    expect(result.apiUrl).toBe(apiUrl);
    expect(result.scopes).toEqual(["read", "write"]);
    expect(opened).toBe(`${apiUrl}/device?user_code=ABCD1234`);
    // The user code is shown to the human at least once.
    expect(printed.join("\n")).toContain("ABCD1234");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/unit/device-auth.test.ts -t "runDeviceLogin"`
Expected: FAIL (`runDeviceLogin` not exported).

- [ ] **Step 3: Implement `runDeviceLogin`**

Append to `src/lib/device-auth.ts`:

```ts
export interface DeviceLoginDeps {
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => boolean;
  print?: (line: string) => void;
  /** Name recorded on the minted key (defaults to `releases-cli (<hostname>)`). */
  keyName?: string;
}

export interface DeviceLoginArgs {
  apiUrl: string;
  scope: UserScope;
  openInBrowser: boolean;
  deps?: DeviceLoginDeps;
}

export interface DeviceLoginResult {
  token: string;
  name?: string;
  scopes?: string[];
  apiUrl: string;
}

/**
 * Orchestrate the full device-login flow and return a credential payload for the
 * caller to persist. Pure of I/O specifics via injectable deps (fetch, sleep,
 * browser, print) so it's unit-testable. Does NOT write to disk — the command
 * layer owns persistence so storage stays in one place.
 */
export async function runDeviceLogin(args: DeviceLoginArgs): Promise<DeviceLoginResult> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const print = args.deps?.print ?? ((l: string) => console.log(l));
  const keyName = args.deps?.keyName ?? "releases-cli";

  const code = await requestDeviceCode(args.apiUrl, args.scope, fetchImpl);

  print(`\nTo connect the CLI, visit:\n  ${code.verification_uri}`);
  print(`and enter the code:\n  ${code.user_code}\n`);

  const target = code.verification_uri_complete ?? code.verification_uri;
  if (args.openInBrowser && args.deps?.openBrowser) {
    const ok = args.deps.openBrowser(target);
    print(ok ? "Opening your browser..." : `Open this URL manually:\n  ${target}`);
  } else if (args.openInBrowser) {
    // No injected opener in this context; the command layer wires the real one.
    print(`Open this URL to continue:\n  ${target}`);
  }

  print("Waiting for authorization...");
  const accessToken = await pollForToken(args.apiUrl, code.device_code, {
    intervalSeconds: code.interval ?? 5,
    expiresInSeconds: code.expires_in,
    fetchImpl,
    sleep: args.deps?.sleep,
  });

  const sessionUser = await getSessionUser(args.apiUrl, accessToken, fetchImpl);
  if (sessionUser) print(`Authorized as ${sessionUser.name ?? sessionUser.email}.`);

  const created = await createUserApiKey(args.apiUrl, accessToken, keyName, args.scope, fetchImpl);

  return {
    token: created.key,
    name: created.name ?? keyName,
    scopes: created.scopes ?? scopeToApiPermissions(args.scope).api,
    apiUrl: args.apiUrl,
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test tests/unit/device-auth.test.ts -t "runDeviceLogin"`
Expected: PASS.

- [ ] **Step 5: Create the command**

Create `src/cli/commands/login.ts`:

```ts
import { hostname } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import chalk from "chalk";
import { getApiUrl, getDataDir } from "../../lib/mode.js";
import { writeCredential, type StoredCredential } from "../../lib/credentials.js";
import { openBrowser } from "../../lib/open-browser.js";
import { runDeviceLogin, type UserScope } from "../../lib/device-auth.js";

export function registerLoginCommand(program: Command): void {
  program
    .command("login")
    .description("Sign in via your browser and store an API key (device authorization)")
    .option("--scope <scope>", "Requested scope: read or write", "write")
    .option("--no-browser", "Print the URL instead of opening a browser")
    .action(async (opts: { scope?: string; browser?: boolean }) => {
      const scope: UserScope = opts.scope === "read" ? "read" : "write";
      const apiUrl = getApiUrl();

      try {
        const result = await runDeviceLogin({
          apiUrl,
          scope,
          openInBrowser: opts.browser !== false,
          deps: {
            openBrowser,
            keyName: `releases-cli (${hostname()})`,
            print: (line) => console.log(line),
          },
        });

        const cred: StoredCredential = {
          token: result.token,
          name: result.name,
          scopes: result.scopes,
          apiUrl: result.apiUrl,
          savedAt: new Date().toISOString(),
        };
        writeCredential(cred);

        console.log(
          `${chalk.green("Signed in")} ${chalk.dim(
            `(scopes: ${(result.scopes ?? []).join(", ")})`,
          )}`,
        );
        console.log(chalk.dim(`  Saved to ${join(getDataDir(), "credentials")}`));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}
```

> **Seam:** `getDataDir` is imported from `../../lib/mode.js` to match `auth login`'s "Saved to" message. Confirm `getDataDir` is exported there (the existing `auth.ts` uses it); if it lives elsewhere, import it from the same place `auth.ts` does.

- [ ] **Step 6: Register the command**

In `src/cli/program.ts`, add the import alongside the other `register*Command` imports:

```ts
import { registerLoginCommand } from "./commands/login.js";
```

Then call it where the other commands are registered (with the public commands, near `registerAuthCommand`):

```ts
registerLoginCommand(program);
```

- [ ] **Step 7: Type-check + full CLI test run**

Run: `npx tsc --noEmit && bun test`
Expected: PASS. (If `getApiUrl()` cache poisoning surfaces across tests, confirm all device-auth tests use `https://test.example.com` per the repo gotcha.)

- [ ] **Step 8: Commit**

```bash
git add src/lib/device-auth.ts src/cli/commands/login.ts src/cli/program.ts tests/unit/device-auth.test.ts
git commit -m "feat(cli): add `releases login` device-authorization command"
```

---

## Task 8: `[MONOREPO]` Documentation

**Files:**

- Modify: `docs/architecture/remote-mode.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update remote-mode.md**

In `docs/architecture/remote-mode.md`, in the auth-model section (near the `relu_` user-key paragraph Phase 1 adds), add:

```markdown
**CLI login (device authorization, `relu_`).** `releases login` uses the OAuth
2.0 Device Authorization Grant (RFC 8628) via Better Auth's `deviceAuthorization`
plugin: the CLI requests a device+user code, the human approves it at
`releases.sh/device` (a logged-in web session), the CLI polls for a session
access token, then exchanges that session (carried as a Bearer token, via the
`bearer()` plugin) for a durable `relu_` API key through the `@better-auth/api-key`
create endpoint — scope-capped server-side. The minted key is stored in
`~/.releases/credentials` and verified on the REST hot path exactly like any other
`relu_` key; the device session is discarded. Gated by `cli-device-auth-enabled`
(and functionally requires `user-api-keys-enabled`). The web API Keys panel
remains a first-class alternative for generating keys.
```

- [ ] **Step 2: Update the AGENTS.md conventions line**

In `AGENTS.md`, extend the scoped-tokens / user-keys bullet with a clause:

```markdown
The CLI also offers **`releases login`** (device authorization, RFC 8628) which mints a `relu_` key via the browser — gated by `cli-device-auth-enabled`; the web API Keys panel stays a first-class issuance path. See [remote-mode.md → Auth model](docs/architecture/remote-mode.md).
```

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/remote-mode.md AGENTS.md
git commit -m "docs(auth): document the CLI device-authorization login lane"
```

---

## Task 9: Full verification gate + rollout

- [ ] **Step 1: `[MONOREPO]` Type-check the whole repo**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit) && (cd web && npx tsc --noEmit)`
Expected: PASS.

- [ ] **Step 2: `[MONOREPO]` Run the test suite**

Run: `bun test`
Expected: PASS. (If the `packages/` mock-leak surfaces, run `bun test tests/` and the `packages/` suites separately, per AGENTS.md.)

- [ ] **Step 3: `[MONOREPO]` Lint + format**

Run: `bun run lint && bun run format:check`
Expected: PASS. Run `bun run format` if needed.

- [ ] **Step 4: `[MONOREPO]` Confirm the migration applies to a fresh local D1**

Run: `bun run db:reset:local`
Expected: all migrations apply cleanly, including `20260604040000_add_device_code.sql`.

- [ ] **Step 5: `[CLI REPO]` Type-check, test, build**

Run (in `/Users/zachdunn/Code/releases-cli`): `npx tsc --noEmit && bun test && bun run build`
Expected: PASS; `dist/releases` builds.

- [ ] **Step 6: Staging end-to-end smoke (manual; gate on P1 + P3)**

Only after Phases 1 (relu\_ lane) and 3 (server-side scope cap) are live in staging, and `cli-device-auth-enabled` + `user-api-keys-enabled` are ON in `releases-platform-staging`:

1. Point the CLI at staging (`RELEASES_API_URL=https://api-staging.releases.sh`, plus the staging access key header as required) and run `releases login`.
2. Approve in the browser at the staging web `/device`.
3. Confirm a `relu_` key lands in `~/.releases/credentials` and that a subsequent authenticated CLI call (e.g. `releases auth status --verify`, or any `write` command) succeeds.
4. Confirm requesting `--scope write` is honored and that `admin` cannot be obtained (the server cap holds).

Expected: login completes without a paste; the stored `relu_` key authenticates.

- [ ] **Step 7: Final commit (if any lint/format fixes were applied)**

```bash
git add -A
git commit -m "chore(auth): lint/format pass for device-auth phase 4"
```

> **Prod rollout order (operational, not a code step):** (1) merge P1 (`relu_` lane) and P3 (server-side scope cap); (2) deploy Phase 4 with both flags OFF (no behavior change); (3) create `cli-device-auth-enabled` in both Flagship apps; (4) enable in staging, run Step 6; (5) ship the CLI release carrying `releases login`; (6) flip `cli-device-auth-enabled` + `user-api-keys-enabled` ON in prod. Rollback: flip `cli-device-auth-enabled` OFF (device endpoints + bearer bridge disappear); the paste-based `auth login` and the `relk_` lane are unaffected.

---

## Self-Review

**1. Spec coverage (Phase 4 scope):**

- No-paste browser CLI login → Tasks 5–7 (`releases login`). ✓
- RFC 8628 device grant on the server → Task 2 (`deviceAuthorization`). ✓
- `relu_` key minted from the session, not a bespoke token → Task 5 (`createUserApiKey` against the P1 api-key endpoint). ✓
- Bearer-session create bridge → Task 2 (`bearer()` plugin). ✓
- Web verification + approval, logged-in human → Tasks 3–4 (`/device`, `/device/approve`). ✓
- Web panel remains a first-class issuance path → untouched by this plan (stated in scope + docs). ✓
- Scope cap honored without a CLI UI → relies on P3 server-side cap (Prerequisites §3; rollout gates on it). ✓
- Durable, stored like today → Task 7 (`writeCredential`, existing `StoredCredential`). ✓
- Thin client, no `better-auth` dep → Task 5 (plain `fetch`). ✓
- Flag/schema/migration/env → Tasks 1–2. ✓
- `relk_` machine lane + static root + paste `auth login` untouched → explicit "untouched" note + no edits to those files. ✓

**2. Placeholder scan:** Two `#TBD-issue` markers (Task 1 flag comment) are issue-number references to fill at PR time, not logic gaps. The "Seam"/"Confirm" notes (Prerequisites §1–6, Task 5/7 seams) are concrete reconcile-against-merged-P1–3 instructions with the exact action to take, not deferred work.

**3. Type consistency:** `UserScope` (`"read" | "write"`) is defined in `device-auth.ts` (Task 5) and consumed in `login.ts` (Task 7). `scopeToApiPermissions` returns `{ api: string[] }` and is used by `createUserApiKey` (Task 5) and the runDeviceLogin fallback (Task 7). `DeviceLoginResult` (`token`/`name`/`scopes`/`apiUrl`) maps 1:1 onto `StoredCredential` (`token`/`name`/`scopes`/`apiUrl`/`savedAt`) in Task 7's command. `deviceCode` table export (Task 1) is imported by the auth schema map (Task 2) and the table-exists test. The server `verificationUri` (Task 2) yields `https://releases.sh/device`, which the web `/device` page (Task 3) serves and the CLI surfaces verbatim.

**Open verification risks (call out at execution, don't guess):**

- Exact `deviceCode` columns/types for 1.6.14 — resolved by the `@better-auth/cli generate` reconcile in Task 1 Step 1.
- Exact handler paths (`/api/auth/device/*`, `/api/auth/api-key/create`, `/api/auth/get-session`) — resolved by checking the auth OpenAPI at execution (Prerequisites §6, §2).
- Whether the api-key create endpoint accepts a Bearer session and applies the P3 scope cap — resolved by the staging smoke (Task 9 Step 6) and Prerequisites §2–3.

---

## Dependency on Phases 1–3 (summary for the other agent)

This plan needs **zero structural changes** to P1–3, only confirmations (Prerequisites §1–6). The one thing P1–3 should not paint into a corner: the `@better-auth/api-key` _create_ path must accept a **Bearer** session and enforce the **scope cap server-side** (not UI-only) — Phase 4 adds `bearer()` itself, so the only ask is that the cap lives at the create endpoint. If P1–3 introduce a single session→`relu_`-key mint chokepoint (taking a `scope`), Task 5's `createUserApiKey` should call that instead of `POST /api/auth/api-key/create` directly — a one-function change.

---

## Execution Handoff

Recommended execution: **Subagent-Driven** (`superpowers:subagent-driven-development`) — fresh subagent per task with review between tasks. Hold execution until Phase 1 (the `relu_` lane) has merged; Tasks 1–4 (server + web) can proceed in the monorepo as soon as it does, and Tasks 5–7 (CLI repo) can run in parallel against a deployed staging API once Task 2 is live.
