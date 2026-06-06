# User API Keys Phase 4 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the `UserApiKey` wire shape from `@buildinternet/releases-api-types` and add session-authed `releases keys` create/list/revoke verbs to the OSS CLI.

**Architecture:** Two repos. Part 1 (monorepo, this worktree) adds plain interfaces to api-types, bumps the package, and swaps the web local type for the published one. Part 2 (`~/Code/releases-cli`) persists the device-flow session token at login, refactors device-auth so re-auth never mints a stray key, and adds a `keys` command group calling the existing session-gated `/v1/api-keys` endpoints.

**Tech Stack:** TypeScript, Bun, `bun test`, Commander (CLI), Hono (server, unchanged), Better Auth (session via `bearer()` plugin, unchanged).

**Spec:** `docs/superpowers/specs/2026-06-06-better-auth-api-keys-phase4-design.md`

---

## Part 1 — Monorepo (this worktree: `.claude/worktrees/phase4-user-api-keys`)

### Task 1: Add `UserApiKey` wire types to api-types + bump version

**Files:**

- Modify: `packages/api-types/src/api-types.ts`
- Modify: `packages/api-types/package.json` (version)

- [ ] **Step 1: Add the interfaces near the other plain response interfaces (after `ListResponse<T>`, ~line 493).**

In `packages/api-types/src/api-types.ts`, add a top-of-file type-only import (group it with the other `import type` lines, ~line 14):

```ts
import type { ApiScope } from "@buildinternet/releases-core/api-token";
```

Then add this block (place it just after the `export interface ListResponse<T>` declaration):

```ts
// === User-owned API keys (relu_) — self-serve surface served by /v1/api-keys ===

/** A user-owned API key (relu_) as returned by GET /v1/api-keys. */
export interface UserApiKey {
  id: string;
  name: string | null;
  start: string | null;
  scope: ApiScope | null;
  enabled: boolean | null;
  remaining: number | null;
  lastRequest: string | null; // ISO 8601
  createdAt: string; // ISO 8601
  expiresAt: string | null; // ISO 8601
}

/** POST /v1/api-keys create response — includes the full key string exactly once. */
export interface CreatedUserApiKey extends Omit<UserApiKey, "enabled" | "lastRequest"> {
  key: string;
}

/** GET /v1/api-keys response envelope. */
export interface ListUserApiKeysResponse {
  apiKeys: UserApiKey[];
}

/** POST /v1/api-keys request body. Self-serve mints are capped at read server-side. */
export interface CreateUserApiKeyBody {
  name: string;
  scope?: ApiScope;
  expiresInDays?: number;
}
```

- [ ] **Step 2: Bump the package version.**

In `packages/api-types/package.json`, change `"version": "0.30.0"` to `"version": "0.31.0"`.

- [ ] **Step 3: Type-check api-types.**

Run: `cd packages/api-types && npx tsc --noEmit`
Expected: PASS (no errors). The `ApiScope` import resolves against the workspace `@buildinternet/releases-core`.

- [ ] **Step 4: Commit.**

```bash
git add packages/api-types/src/api-types.ts packages/api-types/package.json
git commit -m "feat(api-types): publish UserApiKey wire shape (0.31.0)"
```

---

### Task 2: Swap the web local type for the published one

**Files:**

- Modify: `web/src/lib/api-keys.ts`

Current file declares local `UserApiKey` / `CreatedUserApiKey` and a `UserApiKeyScope` alias, plus fetch helpers `listApiKeys` / `createApiKey` / `revokeApiKey`. The web component `web/src/components/api-keys-panel.tsx` imports `UserApiKey` and `CreatedUserApiKey` from `@/lib/api-keys`, so those names MUST remain exported from this module (re-export).

- [ ] **Step 1: Replace the local type declarations with a re-export of the published types.**

In `web/src/lib/api-keys.ts`, delete these local declarations:

```ts
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

export interface CreatedUserApiKey extends Omit<UserApiKey, "enabled" | "lastRequest"> {
  key: string;
}
```

Replace them with a re-export (so `api-keys-panel.tsx`'s `import { type UserApiKey, type CreatedUserApiKey } from "@/lib/api-keys"` keeps working unchanged):

```ts
export type {
  UserApiKey,
  CreatedUserApiKey,
  ListUserApiKeysResponse,
} from "@buildinternet/releases-api-types";
```

- [ ] **Step 2: Fix the `listApiKeys` cast to use the published envelope.**

The `listApiKeys` body currently does `const data = (await res.json()) as { apiKeys: UserApiKey[] };`. Change the import line at the top of the function file usage so it references the published `ListUserApiKeysResponse`:

```ts
const data = (await res.json()) as ListUserApiKeysResponse;
```

Add `ListUserApiKeysResponse` to the value-position import if needed — since it's a type, the `export type { ... } from` line above already brings it into scope for use within this module.

- [ ] **Step 3: Confirm `createApiKey` still compiles.**

The `createApiKey` signature uses `scope?: "read"` literally — that is assignable to the published `CreateUserApiKeyBody.scope?: ApiScope` and needs no change. Leave the function body as-is. The `UserApiKeyScope` alias is removed; verify nothing else in `web/src` imports it (grep below).

- [ ] **Step 4: Verify no other web file imports the removed alias.**

Run: `grep -rn "UserApiKeyScope" web/src`
Expected: no matches (the alias was internal-only).

- [ ] **Step 5: Type-check web.**

Run: `cd web && npx tsc --noEmit`
Expected: PASS. The published `scope: ApiScope | null` is the same `"read" | "write" | "admin" | null` set the component renders.

- [ ] **Step 6: Commit.**

```bash
git add web/src/lib/api-keys.ts
git commit -m "refactor(web): consume published UserApiKey type from api-types"
```

---

### Task 3 (Part 1 wrap): Open the monorepo PR

- [ ] **Step 1: Push the branch and open the PR.**

```bash
git push -u origin worktree-phase4-user-api-keys
gh pr create --repo buildinternet/releases \
  --title "feat(api-types): publish UserApiKey wire shape + web swap (Phase 4 part 1)" \
  --body-file <(cat <<'EOF'
Part 1 of #1445. Publishes `UserApiKey` / `CreatedUserApiKey` / `ListUserApiKeysResponse` / `CreateUserApiKeyBody` from `@buildinternet/releases-api-types` (bumped 0.30.0 → 0.31.0, which fires `publish-*.yml` on merge) and swaps `web/src/lib/api-keys.ts` from its local type to the published one.

No core co-bump — `ApiScope` is already published in core's `^0.23.0` range. No server changes.

Part 2 (the `releases keys` CLI verbs) lands in `buildinternet/releases-cli` after this publishes, pinning api-types `^0.31.0`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```

Expected: PR URL printed. Merge gate: CI green (tsc root + workers + web). After merge, confirm `@buildinternet/releases-api-types@0.31.0` appears on npm before starting Part 2's pin bump.

---

## Part 2 — `releases-cli` repo (`~/Code/releases-cli`)

> Work on a fresh branch in the CLI repo: `git -C ~/Code/releases-cli checkout -b feat/keys-verbs`. All paths below are relative to `~/Code/releases-cli`. Tests run with `bun test`.

### Task 4: Persist the session token in `StoredCredential`

**Files:**

- Modify: `src/lib/credentials.ts`
- Test: `tests/unit/credentials.test.ts`

- [ ] **Step 1: Write the failing test.**

Add to `tests/unit/credentials.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
// (reuse the file's existing imports for writeCredential/readCredential/clearCredential)

describe("StoredCredential.sessionToken", () => {
  afterEach(() => clearCredential());

  it("round-trips an optional sessionToken", () => {
    writeCredential({
      token: "relu_abc",
      sessionToken: "sess_xyz",
      apiUrl: "https://api.releases.sh",
      savedAt: new Date().toISOString(),
    });
    const read = readCredential();
    expect(read?.sessionToken).toBe("sess_xyz");
  });

  it("accepts a credential with no sessionToken (back-compat)", () => {
    writeCredential({
      token: "relu_abc",
      apiUrl: "https://api.releases.sh",
      savedAt: new Date().toISOString(),
    });
    expect(readCredential()?.sessionToken).toBeUndefined();
  });

  it("rejects a credential whose sessionToken is a non-string", () => {
    // hand-write a malformed file, then expect readCredential() === null
    writeCredential({
      token: "relu_abc",
      apiUrl: "https://api.releases.sh",
      savedAt: new Date().toISOString(),
    });
    const path = `${process.env.RELEASES_DATA_DIR}/credentials`;
    const fs = require("node:fs");
    const obj = JSON.parse(fs.readFileSync(path, "utf8"));
    obj.sessionToken = 123;
    fs.writeFileSync(path, JSON.stringify(obj));
    expect(readCredential()).toBeNull();
  });
});
```

> Note: the existing `credentials.test.ts` sets `RELEASES_DATA_DIR` to a temp dir in a `beforeEach`/setup — reuse that harness rather than re-establishing it. If it uses a helper, match it.

- [ ] **Step 2: Run the test to verify it fails.**

Run: `bun test tests/unit/credentials.test.ts`
Expected: FAIL — `sessionToken` is dropped (not in the interface) or the malformed-reject case passes through.

- [ ] **Step 3: Add the field and its validation.**

In `src/lib/credentials.ts`, extend the interface:

```ts
export interface StoredCredential {
  token: string; // durable read-only relu_ key — used for normal API calls
  /**
   * Device-flow session token, used ONLY for the session-gated /v1/api-keys
   * management endpoints. Broader than `token` (it can manage the account), so
   * it shares the same 0600 file and is cleared by `auth logout`.
   */
  sessionToken?: string;
  name?: string;
  scopes?: string[];
  apiUrl: string;
  savedAt: string;
}
```

In `readCredential()`, after the existing `token` checks and before the `scopes` check, add:

```ts
if (
  parsed.sessionToken !== undefined &&
  (typeof parsed.sessionToken !== "string" || !parsed.sessionToken)
) {
  return null;
}
```

- [ ] **Step 4: Run the test to verify it passes.**

Run: `bun test tests/unit/credentials.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/credentials.ts tests/unit/credentials.test.ts
git commit -m "feat(credentials): persist optional device-flow sessionToken"
```

---

### Task 5: Refactor device-auth into `runDeviceAuth` + `runDeviceLogin`

**Files:**

- Modify: `src/lib/device-auth.ts`
- Test: `tests/unit/device-auth.test.ts`

Goal: extract a session-only path that mints nothing, so the auto-reauth flow in Task 6 never creates a stray `relu_` key.

- [ ] **Step 1: Write the failing test.**

Add to `tests/unit/device-auth.test.ts`:

```ts
import { runDeviceAuth, runDeviceLogin } from "../../src/lib/device-auth.js";

describe("runDeviceAuth", () => {
  it("returns the session token and mints no key", async () => {
    const calls: string[] = [];
    const fakeFetch = (async (url: string) => {
      calls.push(String(url));
      if (String(url).endsWith("/device/code")) {
        return new Response(
          JSON.stringify({
            device_code: "d",
            user_code: "U",
            verification_uri: "https://x/device",
            expires_in: 900,
            interval: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      if (String(url).endsWith("/device/token")) {
        return new Response(JSON.stringify({ access_token: "sess_tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (String(url).endsWith("/get-session")) {
        return new Response(JSON.stringify({ user: { email: "a@b.co", name: "A" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const res = await runDeviceAuth({
      apiUrl: "https://test.example.com",
      openInBrowser: false,
      deps: { fetchImpl: fakeFetch, sleep: async () => {}, print: () => {} },
    });
    expect(res.sessionToken).toBe("sess_tok");
    // No /api-keys POST happened — runDeviceAuth mints nothing.
    expect(calls.some((u) => u.endsWith("/v1/api-keys"))).toBe(false);
  });
});
```

Also extend the existing `runDeviceLogin` test (or add one) to assert it now ALSO returns `sessionToken`:

```ts
describe("runDeviceLogin returns sessionToken", () => {
  it("includes the session token alongside the minted key", async () => {
    const fakeFetch = (async (url: string) => {
      const u = String(url);
      if (u.endsWith("/device/code"))
        return new Response(
          JSON.stringify({
            device_code: "d",
            user_code: "U",
            verification_uri: "https://x/device",
            expires_in: 900,
            interval: 0,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      if (u.endsWith("/device/token"))
        return new Response(JSON.stringify({ access_token: "sess_tok" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (u.endsWith("/get-session"))
        return new Response(JSON.stringify({ user: { email: "a@b.co" } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      if (u.endsWith("/v1/api-keys"))
        return new Response(JSON.stringify({ key: "relu_new", name: "n", scope: "read" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      throw new Error(`unexpected ${url}`);
    }) as unknown as typeof fetch;

    const res = await runDeviceLogin({
      apiUrl: "https://test.example.com",
      openInBrowser: false,
      deps: { fetchImpl: fakeFetch, sleep: async () => {}, print: () => {} },
    });
    expect(res.token).toBe("relu_new");
    expect(res.sessionToken).toBe("sess_tok");
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bun test tests/unit/device-auth.test.ts`
Expected: FAIL — `runDeviceAuth` is not exported; `runDeviceLogin` result has no `sessionToken`.

- [ ] **Step 3: Refactor `device-auth.ts`.**

Add a `sessionToken` to `DeviceLoginResult`:

```ts
export interface DeviceLoginResult {
  token: string;
  sessionToken: string;
  name?: string;
  scopes?: string[];
  apiUrl: string;
}
```

Add the session-only result + function. Extract the device-code/poll/get-session portion of `runDeviceLogin` into `runDeviceAuth`:

```ts
export interface DeviceAuthResult {
  sessionToken: string;
  user: SessionUser | null;
}

/**
 * Run the RFC 8628 device flow and return the session token only — mints NO key.
 * Used by `releases keys` to (re)establish a session for the management endpoints
 * without polluting the user's key list.
 */
export async function runDeviceAuth(args: DeviceLoginArgs): Promise<DeviceAuthResult> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const print = args.deps?.print ?? ((l: string) => console.log(l));

  const code = await requestDeviceCode(args.apiUrl, fetchImpl);

  print(`\nTo connect the CLI, visit:\n  ${code.verification_uri}`);
  print(`and enter the code:\n  ${code.user_code}\n`);

  const target = code.verification_uri_complete ?? code.verification_uri;
  if (args.openInBrowser && args.deps?.openBrowser) {
    const ok = args.deps.openBrowser(target);
    print(ok ? "Opening your browser..." : `Open this URL manually:\n  ${target}`);
  } else if (args.openInBrowser) {
    print(`Open this URL to continue:\n  ${target}`);
  }

  print("Waiting for authorization...");
  const sessionToken = await pollForToken(args.apiUrl, code.device_code, {
    intervalSeconds: code.interval ?? 5,
    expiresInSeconds: code.expires_in,
    fetchImpl,
    sleep: args.deps?.sleep,
  });

  const user = await getSessionUser(args.apiUrl, sessionToken, fetchImpl);
  if (user) print(`Authorized as ${user.name ?? user.email}.`);
  return { sessionToken, user };
}
```

Rewrite `runDeviceLogin` to compose `runDeviceAuth` + the key mint:

```ts
export async function runDeviceLogin(args: DeviceLoginArgs): Promise<DeviceLoginResult> {
  const fetchImpl = args.deps?.fetchImpl ?? fetch;
  const keyName = args.deps?.keyName ?? "releases-cli";

  const { sessionToken } = await runDeviceAuth(args);
  const created = await createUserApiKey(args.apiUrl, sessionToken, keyName, fetchImpl);

  return {
    token: created.key,
    sessionToken,
    name: created.name ?? keyName,
    scopes: [created.scope ?? "read"],
    apiUrl: args.apiUrl,
  };
}
```

- [ ] **Step 4: Run to verify the tests pass.**

Run: `bun test tests/unit/device-auth.test.ts`
Expected: PASS (new + existing tests).

- [ ] **Step 5: Persist the session token in `login`.**

In `src/cli/commands/login.ts`, the `cred` object now carries the session token:

```ts
const cred: StoredCredential = {
  token: result.token,
  sessionToken: result.sessionToken,
  name: result.name,
  scopes: result.scopes,
  apiUrl: result.apiUrl,
  savedAt: new Date().toISOString(),
};
writeCredential(cred);
```

- [ ] **Step 6: Type-check + full test run.**

Run: `npx tsc --noEmit && bun test tests/unit/device-auth.test.ts tests/unit/auth-login.test.ts`
Expected: PASS. (`auth-login.test.ts` exercises the login command; confirm it still passes with the new field.)

- [ ] **Step 7: Commit.**

```bash
git add src/lib/device-auth.ts src/cli/commands/login.ts tests/unit/device-auth.test.ts
git commit -m "feat(device-auth): extract session-only runDeviceAuth; persist sessionToken at login"
```

---

### Task 6: `getSessionToken` helper with auto-reauth

**Files:**

- Create: `src/lib/session.ts`
- Test: `tests/unit/session.test.ts`

- [ ] **Step 1: Write the failing test.**

Create `tests/unit/session.test.ts`:

```ts
import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeCredential, clearCredential } from "../../src/lib/credentials.js";
import { getSessionToken } from "../../src/lib/session.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rel-sess-"));
  process.env.RELEASES_DATA_DIR = dir;
});
afterEach(() => {
  clearCredential();
  rmSync(dir, { recursive: true, force: true });
});

describe("getSessionToken", () => {
  it("returns the stored session token when present", async () => {
    writeCredential({
      token: "relu_x",
      sessionToken: "sess_stored",
      apiUrl: "https://test.example.com",
      savedAt: new Date().toISOString(),
    });
    let reauthed = false;
    const token = await getSessionToken("https://test.example.com", {
      reauth: async () => {
        reauthed = true;
        return "sess_new";
      },
    });
    expect(token).toBe("sess_stored");
    expect(reauthed).toBe(false);
  });

  it("re-auths and persists when no session is stored", async () => {
    writeCredential({
      token: "relu_x",
      apiUrl: "https://test.example.com",
      savedAt: new Date().toISOString(),
    });
    const token = await getSessionToken("https://test.example.com", {
      reauth: async () => "sess_fresh",
    });
    expect(token).toBe("sess_fresh");
    // persisted onto the existing credential
    const { readCredential } = await import("../../src/lib/credentials.js");
    expect(readCredential()?.sessionToken).toBe("sess_fresh");
    expect(readCredential()?.token).toBe("relu_x"); // relu_ key untouched
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bun test tests/unit/session.test.ts`
Expected: FAIL — `src/lib/session.ts` does not exist.

- [ ] **Step 3: Implement `src/lib/session.ts`.**

```ts
import { hostname } from "node:os";
import { readCredential, writeCredential } from "./credentials.js";
import { runDeviceAuth } from "./device-auth.js";
import { openBrowser } from "./open-browser.js";

/** Injectable re-auth for tests; production runs the real device flow. */
export interface SessionOpts {
  reauth?: (apiUrl: string) => Promise<string>;
}

async function defaultReauth(apiUrl: string): Promise<string> {
  const { sessionToken } = await runDeviceAuth({
    apiUrl,
    openInBrowser: true,
    deps: { openBrowser, keyName: `releases-cli (${hostname()})`, print: (l) => console.log(l) },
  });
  return sessionToken;
}

/** Persist a fresh session token onto the existing credential (or a new one). */
function persistSession(apiUrl: string, sessionToken: string): void {
  const existing = readCredential();
  writeCredential({
    token: existing?.token ?? "",
    sessionToken,
    name: existing?.name,
    scopes: existing?.scopes,
    apiUrl: existing?.apiUrl ?? apiUrl,
    savedAt: new Date().toISOString(),
  });
}

/**
 * Return a session token for the /v1/api-keys management endpoints. Uses the
 * stored token if present; otherwise runs the device flow (minting no key),
 * persists the result, and returns it.
 */
export async function getSessionToken(apiUrl: string, opts: SessionOpts = {}): Promise<string> {
  const stored = readCredential()?.sessionToken;
  if (stored) return stored;
  const reauth = opts.reauth ?? defaultReauth;
  const fresh = await reauth(apiUrl);
  persistSession(apiUrl, fresh);
  return fresh;
}

/** Clear only the stored session token (e.g. after a 401), keeping the relu_ key. */
export function clearSessionToken(): void {
  const existing = readCredential();
  if (!existing) return;
  const { sessionToken: _drop, ...rest } = existing;
  writeCredential({ ...rest, savedAt: new Date().toISOString() });
}
```

- [ ] **Step 4: Run to verify it passes.**

Run: `bun test tests/unit/session.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit.**

```bash
git add src/lib/session.ts tests/unit/session.test.ts
git commit -m "feat(session): getSessionToken helper with device-flow re-auth"
```

---

### Task 7: `keys` command group (create / list / revoke)

**Files:**

- Create: `src/cli/commands/keys.ts`
- Modify: `src/cli/program.ts` (import + register)
- Test: `tests/unit/keys.test.ts`

The verbs call `${apiUrl}/v1/api-keys` with `Authorization: Bearer <sessionToken>`. A shared request helper does the session fetch + single 401-retry. Types come from the published `@buildinternet/releases-api-types@^0.31.0` (pinned in Task 8).

- [ ] **Step 1: Write the failing test.**

Create `tests/unit/keys.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { keysRequest } from "../../src/cli/commands/keys.js";

const BASE = "https://test.example.com";

describe("keysRequest", () => {
  it("sends the session token as a Bearer credential", async () => {
    let seenAuth = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seenAuth = String((init?.headers as Record<string, string>)?.authorization ?? "");
      return new Response(JSON.stringify({ apiKeys: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    await keysRequest(
      BASE,
      "/v1/api-keys",
      { method: "GET" },
      {
        getToken: async () => "sess_tok",
        onReauth: async () => "sess_tok2",
        fetchImpl,
      },
    );
    expect(seenAuth).toBe("Bearer sess_tok");
  });

  it("re-auths and retries once on 401", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      if (call === 1)
        return new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        });
      return new Response(JSON.stringify({ apiKeys: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    let reauthed = false;
    const res = await keysRequest(
      BASE,
      "/v1/api-keys",
      { method: "GET" },
      {
        getToken: async () => "sess_old",
        onReauth: async () => {
          reauthed = true;
          return "sess_new";
        },
        fetchImpl,
      },
    );
    expect(reauthed).toBe(true);
    expect(call).toBe(2);
    expect(res.status).toBe(200);
  });

  it("does not retry more than once (second 401 surfaces)", async () => {
    let call = 0;
    const fetchImpl = (async () => {
      call += 1;
      return new Response("{}", { status: 401, headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    const res = await keysRequest(
      BASE,
      "/v1/api-keys",
      { method: "GET" },
      {
        getToken: async () => "a",
        onReauth: async () => "b",
        fetchImpl,
      },
    );
    expect(call).toBe(2);
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run to verify it fails.**

Run: `bun test tests/unit/keys.test.ts`
Expected: FAIL — `src/cli/commands/keys.ts` / `keysRequest` does not exist.

- [ ] **Step 3: Implement `src/cli/commands/keys.ts`.**

```ts
import { Command } from "commander";
import chalk from "chalk";
import type {
  UserApiKey,
  CreatedUserApiKey,
  ListUserApiKeysResponse,
} from "@buildinternet/releases-api-types";
import { getApiUrl } from "../../lib/mode.js";
import { getSessionToken, clearSessionToken } from "../../lib/session.js";
import { writeJson } from "../../lib/output.js";
import { renderTable } from "../render/table.js";
import { promptConfirm, defaultPromptReader } from "../../lib/confirm.js";

const UA = "releases-cli";

export interface KeysRequestDeps {
  getToken: (apiUrl: string) => Promise<string>;
  onReauth: (apiUrl: string) => Promise<string>;
  fetchImpl?: typeof fetch;
}

/**
 * Session-authed request to the /v1/api-keys management surface. Sends the
 * stored session token as a Bearer credential; on a 401 it re-auths ONCE
 * (forcing the device flow) and retries, then surfaces whatever comes back.
 */
export async function keysRequest(
  apiUrl: string,
  path: string,
  init: RequestInit,
  deps: KeysRequestDeps,
): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let token = await deps.getToken(apiUrl);
  const send = (t: string) =>
    fetchImpl(`${apiUrl}${path}`, {
      ...init,
      headers: { ...(init.headers ?? {}), authorization: `Bearer ${t}`, "user-agent": UA },
    });

  let res = await send(token);
  if (res.status === 401) {
    token = await deps.onReauth(apiUrl);
    res = await send(token);
  }
  return res;
}

/** Production deps: stored token, and a re-auth that clears the stale one first. */
function liveDeps(): KeysRequestDeps {
  return {
    getToken: (apiUrl) => getSessionToken(apiUrl),
    onReauth: async (apiUrl) => {
      clearSessionToken();
      return getSessionToken(apiUrl);
    },
  };
}

async function errMessage(res: Response, fallback: string): Promise<string> {
  try {
    const body = (await res.json()) as { message?: string };
    return body.message || fallback;
  } catch {
    return fallback;
  }
}

export function registerKeysCommand(program: Command): void {
  const keys = program
    .command("keys")
    .description("Manage your user API keys (read-only relu_ keys)");

  keys
    .command("create")
    .description("Create a read-only API key (revealed once)")
    .requiredOption("--name <name>", "Label for the key")
    .option("--expires-in-days <n>", "Expiry in days (1-365)", (v) => parseInt(v, 10))
    .option("--json", "Output as JSON")
    .action(async (opts: { name: string; expiresInDays?: number; json?: boolean }) => {
      const apiUrl = getApiUrl();
      const body: Record<string, unknown> = { name: opts.name, scope: "read" };
      if (opts.expiresInDays !== undefined) body.expiresInDays = opts.expiresInDays;
      const res = await keysRequest(
        apiUrl,
        "/v1/api-keys",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        liveDeps(),
      );
      if (!res.ok) {
        console.error(
          chalk.red(await errMessage(res, `Failed to create key (HTTP ${res.status})`)),
        );
        process.exit(1);
      }
      const created = (await res.json()) as CreatedUserApiKey;
      if (opts.json) {
        await writeJson(created);
        return;
      }
      console.log(
        chalk.green("API key created (read-only). Store it now — it won't be shown again:"),
      );
      console.log(`\n  ${chalk.bold(created.key)}\n`);
      console.log(chalk.dim(`  id: ${created.id}  scope: ${created.scope}`));
    });

  keys
    .command("list")
    .description("List your API keys")
    .option("--json", "Output as JSON")
    .action(async (opts: { json?: boolean }) => {
      const apiUrl = getApiUrl();
      const res = await keysRequest(apiUrl, "/v1/api-keys", { method: "GET" }, liveDeps());
      if (!res.ok) {
        console.error(chalk.red(await errMessage(res, `Failed to list keys (HTTP ${res.status})`)));
        process.exit(1);
      }
      const data = (await res.json()) as ListUserApiKeysResponse;
      if (opts.json) {
        await writeJson(data);
        return;
      }
      if (data.apiKeys.length === 0) {
        console.log(
          chalk.yellow("No API keys. Create one with `releases keys create --name <name>`."),
        );
        return;
      }
      console.log(
        renderTable({
          head: [
            { label: "ID", noTruncate: true },
            { label: "Name" },
            { label: "Scope", noTruncate: true },
            { label: "Prefix", noTruncate: true },
            { label: "Created", noTruncate: true },
            { label: "Expires", noTruncate: true },
          ],
          rows: data.apiKeys.map((k: UserApiKey) => [
            k.id,
            k.name ?? chalk.dim("—"),
            k.scope ?? chalk.dim("—"),
            k.start ?? chalk.dim("—"),
            k.createdAt.slice(0, 10),
            k.expiresAt ? k.expiresAt.slice(0, 10) : chalk.dim("never"),
          ]),
        }),
      );
    });

  keys
    .command("revoke <id>")
    .description("Revoke (delete) an API key by id")
    .option("--yes", "Skip the confirmation prompt")
    .action(async (id: string, opts: { yes?: boolean }) => {
      if (!opts.yes) {
        const ok = await promptConfirm(
          `Type the key id to confirm revoke (${id}): `,
          id,
          defaultPromptReader,
        );
        if (!ok) {
          console.error(chalk.red("Aborted."));
          process.exit(1);
        }
      }
      const apiUrl = getApiUrl();
      const res = await keysRequest(
        apiUrl,
        `/v1/api-keys/${encodeURIComponent(id)}`,
        { method: "DELETE" },
        liveDeps(),
      );
      if (res.status === 404) {
        console.error(chalk.red("No such key (or not owned by you)."));
        process.exit(1);
      }
      if (!res.ok) {
        console.error(
          chalk.red(await errMessage(res, `Failed to revoke key (HTTP ${res.status})`)),
        );
        process.exit(1);
      }
      console.log(chalk.green(`Revoked ${id}.`));
    });
}
```

> Confirm `promptConfirm`'s real signature in `src/lib/confirm.ts` (Step 0 of this task): the snippet above assumes `promptConfirm(question, expected, reader)`. If the actual arg order differs, adapt the call. The verified signature begins `promptConfirm(question: string, expected: string, ...)` — match the third reader arg to the file.

- [ ] **Step 4: Run to verify the unit test passes.**

Run: `bun test tests/unit/keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the command.**

In `src/cli/program.ts`, add the import near the other command imports:

```ts
import { registerKeysCommand } from "./commands/keys.js";
```

And add the registration near `registerLoginCommand(program);` (~line 237):

```ts
registerKeysCommand(program);
```

- [ ] **Step 6: Type-check + smoke the help.**

Run: `npx tsc --noEmit && bun src/index.ts keys --help`
Expected: tsc PASS; help lists `create`, `list`, `revoke`.

- [ ] **Step 7: Commit.**

```bash
git add src/cli/commands/keys.ts src/cli/program.ts tests/unit/keys.test.ts
git commit -m "feat(keys): add 'releases keys' create/list/revoke verbs"
```

---

### Task 8: api-types pin + changeset + full verify

**Files:**

- Modify: `package.json` (the CLI's dependency pin for `@buildinternet/releases-api-types`)
- Create: `.changeset/<name>.md`

- [ ] **Step 1: Bump the api-types pin to the newly published version.**

After Part 1 publishes `@buildinternet/releases-api-types@0.31.0`, in `~/Code/releases-cli/package.json` set the dependency to `"@buildinternet/releases-api-types": "^0.31.0"` (add it if the CLI didn't depend on it yet), then:

Run: `bun install`
Expected: lockfile resolves `@buildinternet/releases-api-types@0.31.0`.

- [ ] **Step 2: Add the changeset.**

Create `.changeset/keys-verbs.md`:

```md
---
"@buildinternet/releases": minor
---

Add `releases keys` verbs (create/list/revoke) for self-serve, read-only user API keys, authenticated via the device-flow session.
```

- [ ] **Step 3: Full type-check, lint, test.**

Run: `npx tsc --noEmit && bun test`
Expected: PASS across the suite. (Watch for the `getApiUrl()` memoization gotcha — all new tests use `https://test.example.com` or inject deps, so they don't poison the shared base.)

- [ ] **Step 4: Commit.**

```bash
git add package.json bun.lock .changeset/keys-verbs.md
git commit -m "chore: pin api-types ^0.31.0 + changeset for keys verbs"
```

- [ ] **Step 5: Open the CLI PR.**

```bash
git push -u origin feat/keys-verbs
gh pr create --repo buildinternet/releases-cli \
  --title "feat: add 'releases keys' verbs (create/list/revoke)" \
  --body-file <(cat <<'EOF'
Phase 4 part 2 of buildinternet/releases#1445. Adds `releases keys create/list/revoke` for self-serve user API keys.

- Persists the device-flow **session token** at login (`StoredCredential.sessionToken`) and reuses it for the session-gated `/v1/api-keys` endpoints; `getSessionToken` re-auths transparently on expiry (the device-auth refactor extracts a session-only `runDeviceAuth` so re-auth mints no stray key).
- `keys create` is **read-only** — no `--scope` flag; the server caps user keys at read (buildinternet/releases#1448).
- Types consumed from the published `@buildinternet/releases-api-types@^0.31.0`.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)
```

---

## Manual smoke test (post-merge, against prod)

After both PRs merge and the CLI publishes:

```bash
releases login                       # device flow; stores relu_ key + session token
releases keys list                   # shows the login-minted key
releases keys create --name probe    # revealed-once read key
releases keys list                   # probe present
releases keys revoke <probe-id> --yes
releases keys list                   # probe gone
```

Expected: all succeed; `keys create` shows `scope: read`. Confirm a bare `relu_` key (no session) cannot reach the management endpoints — only the session does.

---

## Self-Review Notes

- **Spec coverage:** Part 1 types (Task 1) + publish (Task 1 step 2) + web swap (Task 2); Part 2 credential field (Task 4), device-auth refactor + login persist (Task 5), session helper + auto-reauth (Task 6), three verbs + registration (Task 7), changeset + pin (Task 8). Smoke test mirrors the spec's. All spec sections mapped.
- **Read-only constraint:** enforced in Task 7 (`scope: "read"`, no `--scope` flag).
- **No-stray-key guarantee:** Task 5 extracts `runDeviceAuth` (mints nothing); Task 6's re-auth uses it.
- **Type consistency:** `runDeviceAuth`/`DeviceAuthResult`/`getSessionToken`/`clearSessionToken`/`keysRequest`/`KeysRequestDeps` names are used identically across tasks.
- **Gotchas:** `getApiUrl()` memoization noted in Task 8; `promptConfirm` signature flagged for verification in Task 7.
