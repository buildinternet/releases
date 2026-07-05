# CLI Auth — Token Storage & `releases auth` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a `releases` CLI user store a token they already hold (verified against the server) via a new `releases auth` command namespace, backed by a read-gated `GET /v1/tokens/me` introspection endpoint.

**Architecture:** Phase A adds the self-introspection endpoint to the API worker (`workers/api/`), gated to _any valid identity_ (read scope) rather than admin, plus a `TokenIdentity` wire type. Phase B adds the CLI side in the separate `releases-cli` repo: a `0600` credential file, an env-over-file resolver, the `auth login/logout/status/token` commands, and a hybrid scope pre-flight on the `admin` subtree. The two phases are independently testable (CLI tests stub `fetch`); Phase A ships first so the CLI's verify call has a live endpoint.

**Tech Stack:** Bun, TypeScript (strict), Hono (API worker), Drizzle/D1, commander (CLI), `bun test`, chalk.

**Spec:** `docs/superpowers/specs/2026-05-20-cli-auth-token-storage-design.md`

---

## Conventions for every task

- **Repos & working dirs:** Phase A tasks run in the **monorepo worktree** (cwd `~/Code/releases/.claude/worktrees/cli-auth-token-storage`, branch `worktree-cli-auth-token-storage`). Phase B tasks run in the **CLI repo** (cwd `~/Code/releases-cli`, on a new branch created in Task B0). Never `cd` between them within one task.
- **Every commit ends with the trailer** `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` — shown in each commit command as a second `-m`.
- **TDD:** write the failing test, run it red, implement, run it green, commit.
- Do **not** push or open PRs unless the user asks. Commit to the branch only.

---

## File Structure

### Phase A — monorepo (`workers/api/`, `packages/api-types/`)

| File                                     | Change             | Responsibility                                                                                              |
| ---------------------------------------- | ------------------ | ----------------------------------------------------------------------------------------------------------- |
| `packages/api-types/src/api-types.ts`    | modify (append)    | `TokenIdentity` wire shape returned by `/v1/tokens/me`.                                                     |
| `workers/api/src/middleware/auth.ts`     | modify (append)    | `requireReadAuthMiddleware` (read-gated) + `tokensAuthMiddleware` (split gate for the `/tokens` namespace). |
| `workers/api/src/routes/api-tokens.ts`   | modify (add route) | `GET /tokens/me` self-introspection handler.                                                                |
| `workers/api/src/index.ts`               | modify (loop)      | Wire `tokensAuthMiddleware` for the `tokens` admin namespace.                                               |
| `tests/api/tokens-me-middleware.test.ts` | create             | Gating: read token reaches `/me`, anonymous → 401, admin route still admin.                                 |
| `tests/api/api-tokens-route.test.ts`     | modify (append)    | `/me` handler projection for root + token identities.                                                       |

### Phase B — CLI (`~/Code/releases-cli`)

| File                                 | Change | Responsibility                                                                                                                     |
| ------------------------------------ | ------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/lib/credentials.ts`             | create | Read/write/clear the `0600` credential file.                                                                                       |
| `src/lib/prompt-hidden.ts`           | create | Masked (echo-off) TTY reader for the interactive token prompt.                                                                     |
| `src/lib/preflight.ts`               | create | Pure `preflightScopeWarning()` for the admin subtree.                                                                              |
| `src/lib/mode.ts`                    | modify | `resolveCredential()` (env > file > none), `isAuthenticated()` (+ `isAdminMode` alias), `getApiKey()`, relaxed `validateConfig()`. |
| `src/cli/commands/auth.ts`           | create | `auth login/logout/status/token` + `verifyToken` + `printAuthStatus`.                                                              |
| `src/cli/commands/whoami.ts`         | modify | Delegate to `printAuthStatus` (back-compat alias).                                                                                 |
| `src/cli/program.ts`                 | modify | Register `auth`; admin gate uses `isAuthenticated()` + scope pre-flight.                                                           |
| `src/index.ts`                       | modify | `gateAdminArgv` uses `isAuthenticated()`.                                                                                          |
| `tests/unit/credentials.test.ts`     | create | File round-trip, perms, corrupt/missing.                                                                                           |
| `tests/unit/mode-credential.test.ts` | create | Resolver precedence, `isAuthenticated`, `getApiKey`.                                                                               |
| `tests/unit/auth-login.test.ts`      | create | `verifyToken` + `resolveTokenInput` branches.                                                                                      |
| `tests/unit/preflight.test.ts`       | create | `preflightScopeWarning` decisions.                                                                                                 |
| `tests/cli/auth.test.ts`             | create | End-to-end login/status/token/logout against a local stub server.                                                                  |
| `.changeset/<slug>.md`               | create | Minor bump for the new `auth` commands.                                                                                            |
| `README.md`                          | modify | Document `releases auth`.                                                                                                          |

---

# Phase A — API worker

## Task A1: `TokenIdentity` wire type

**Files:**

- Modify: `packages/api-types/src/api-types.ts` (append at end of file, after the last interface)

- [ ] **Step 1: Append the interface**

Add to the very end of `packages/api-types/src/api-types.ts`:

```ts
/**
 * Identity returned by `GET /v1/tokens/me` — the caller introspecting its own
 * credential. `kind: "root"` is the static break-glass key (synthetic identity,
 * no DB row); `kind: "token"` is a DB-backed `relk_` token.
 */
export interface TokenIdentity {
  kind: "root" | "token";
  /** Display label; "root" for the static key, "local-dev" when no secret is bound. */
  name: string;
  /** e.g. ["read","write"] or ["*"] for root. */
  scopes: string[];
  principalType: "internal" | "agent" | "user";
  principalId?: string | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}
```

- [ ] **Step 2: Typecheck the worker (consumer compiles the type)**

Run: `cd workers/api && npx tsc --noEmit && cd -`
Expected: PASS (no new errors). The type isn't imported yet, so this just confirms the addition parses.

- [ ] **Step 3: Commit**

```bash
git add packages/api-types/src/api-types.ts
git commit -m "feat(api-types): TokenIdentity shape for /v1/tokens/me" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task A2: read-scope + tokens-namespace auth middleware

**Files:**

- Modify: `workers/api/src/middleware/auth.ts` (append two exports after `publicReadAuthMiddleware`, before `recordAuth`)
- Test: `tests/api/tokens-me-middleware.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/api/tokens-me-middleware.test.ts`:

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { Hono, type MiddlewareHandler } from "hono";
import { createTestDb, type TestDatabase } from "../db-helper.js";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";

const { tokensAuthMiddleware } =
  (await import("../../workers/api/src/middleware/auth.js")) as unknown as {
    tokensAuthMiddleware: MiddlewareHandler;
  };

function mockSecret(value: string) {
  return { get: () => Promise.resolve(value) };
}

let h: TestDatabase | null = null;
afterEach(() => h?.cleanup());

async function seed(db: TestDatabase["db"], scopes: string[]) {
  const { token, lookupId, secret } = generateApiToken();
  db.insert(apiTokens)
    .values({
      id: `tok_${lookupId}`,
      lookupId,
      tokenHash: await hashSecret(secret),
      name: "t",
      scopes: JSON.stringify(scopes),
    })
    .run();
  return token;
}

function app(db: TestDatabase["db"]) {
  const a = new Hono();
  a.use("*", tokensAuthMiddleware);
  // /tokens/me must be reachable by any valid identity (read+).
  a.get("/tokens/me", (c) => c.json({ ok: true }));
  // Any other token route is admin-only.
  a.get("/tokens/abc", (c) => c.json({ ok: true }));
  return (path: string, token?: string) =>
    a.request(path, token ? { headers: { Authorization: `Bearer ${token}` } } : {}, {
      DB: db,
      RELEASED_API_KEY: mockSecret("root-secret"),
    });
}

describe("tokensAuthMiddleware", () => {
  it("read-only token reaches GET /tokens/me", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    expect((await app(h.db)("/tokens/me", token)).status).toBe(200);
  });

  it("anonymous request to /tokens/me is 401", async () => {
    h = createTestDb();
    expect((await app(h.db)("/tokens/me")).status).toBe(401);
  });

  it("read-only token is 403 on a non-me token route (still admin)", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["read"]);
    expect((await app(h.db)("/tokens/abc", token)).status).toBe(403);
  });

  it("admin token reaches a non-me token route", async () => {
    h = createTestDb();
    const token = await seed(h.db, ["admin"]);
    expect((await app(h.db)("/tokens/abc", token)).status).toBe(200);
  });

  it("static root key reaches /tokens/me", async () => {
    h = createTestDb();
    expect((await app(h.db)("/tokens/me", "root-secret")).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test tests/api/tokens-me-middleware.test.ts`
Expected: FAIL — `tokensAuthMiddleware` is `undefined` (not exported yet).

- [ ] **Step 3: Implement the middleware**

In `workers/api/src/middleware/auth.ts`, add immediately after the `publicReadAuthMiddleware` export (around line 107, before the `recordAuth` function):

```ts
/**
 * Requires any valid identity (`read` scope or higher); anonymous/invalid → 401.
 * Used for self-introspection (`GET /v1/tokens/me`), reachable by a read-only
 * token but not by an anonymous caller.
 */
export const requireReadAuthMiddleware: MiddlewareHandler<Env> = createAuthMiddleware({
  allowPublicReads: false,
  requiredScope: "read",
});

/**
 * Auth for the `/v1/tokens` namespace. `GET /v1/tokens/me` is self-introspection
 * (any valid identity, read+); every other token route is admin-only. One
 * wrapper guarantees exactly one auth path runs per request — the generic
 * adminRoutes loop in index.ts would otherwise blanket-admin-gate `/me` too.
 */
export const tokensAuthMiddleware: MiddlewareHandler<Env> = (c, next) => {
  if (c.req.method === "GET" && c.req.path.endsWith("/tokens/me")) {
    return requireReadAuthMiddleware(c, next);
  }
  return authMiddleware(c, next);
};
```

(`MiddlewareHandler` and `Env` are already imported at the top of the file.)

- [ ] **Step 4: Run it green**

Run: `bun test tests/api/tokens-me-middleware.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/middleware/auth.ts tests/api/tokens-me-middleware.test.ts
git commit -m "feat(api): read-gated tokensAuthMiddleware for /v1/tokens/me carve-out" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task A3: `GET /tokens/me` handler

**Files:**

- Modify: `workers/api/src/routes/api-tokens.ts` (add imports + route before the `/tokens/:id` GET)
- Test: `tests/api/api-tokens-route.test.ts` (append a `describe`)

- [ ] **Step 1: Write the failing test**

Append to `tests/api/api-tokens-route.test.ts`:

```ts
describe("GET /v1/tokens/me", () => {
  // Helper that injects a specific identity, mirroring how the real middleware
  // attaches `auth` to the context.
  function callAs(db: TestDatabase["db"], auth: AuthContext) {
    const a = new Hono<{ Variables: { auth?: AuthContext } }>();
    a.use("*", async (c, next) => {
      c.set("auth", auth);
      await next();
    });
    a.route("/", apiTokenRoutes);
    return (path: string) => a.request(path, {}, { DB: db });
  }

  it("returns synthetic root identity for the static key", async () => {
    h = createTestDb();
    const res = await callAs(h.db, { kind: "root", scopes: ["*"] })("/tokens/me");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; name: string; scopes: string[] };
    expect(body.kind).toBe("root");
    expect(body.name).toBe("root");
    expect(body.scopes).toEqual(["*"]);
  });

  it("returns the token's identity (name + scopes) without leaking the hash", async () => {
    h = createTestDb();
    h.db
      .insert(apiTokens)
      .values({
        id: "tok_me",
        lookupId: "lookupme0001",
        tokenHash: "c".repeat(64),
        name: "laptop",
        scopes: '["read","write"]',
        principalType: "user",
      })
      .run();
    const res = await callAs(h.db, { kind: "token", tokenId: "tok_me", scopes: ["read", "write"] })(
      "/tokens/me",
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("c".repeat(64)); // no hash leak
    const body = (await res.json()) as {
      kind: string;
      name: string;
      scopes: string[];
      principalType: string;
    };
    expect(body.kind).toBe("token");
    expect(body.name).toBe("laptop");
    expect(body.scopes).toEqual(["read", "write"]);
    expect(body.principalType).toBe("user");
  });

  it("401 when the token's row no longer exists", async () => {
    h = createTestDb();
    const res = await callAs(h.db, { kind: "token", tokenId: "tok_gone", scopes: ["read"] })(
      "/tokens/me",
    );
    expect(res.status).toBe(401);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test tests/api/api-tokens-route.test.ts`
Expected: FAIL — `/tokens/me` is matched by `/tokens/:id` (returns 404 "token not found" for id "me") or otherwise doesn't return the identity shape.

- [ ] **Step 3: Implement the route**

In `workers/api/src/routes/api-tokens.ts`:

Add `ROOT_SCOPE` to the existing `@buildinternet/releases-core/api-token` import and add the api-types import near the top:

```ts
import {
  API_SCOPES,
  generateApiToken,
  hashSecret,
  isApiScope,
  parseStoredScopes,
  PRINCIPAL_TYPES,
  ROOT_SCOPE,
  type PrincipalType,
} from "@buildinternet/releases-core/api-token";
import type { TokenIdentity } from "@buildinternet/releases-api-types";
```

Then register the `/tokens/me` route **immediately before** the existing `apiTokenRoutes.get("/tokens/:id", …)` handler (static route first so it can't be shadowed by the `:id` param):

```ts
apiTokenRoutes.get("/tokens/me", async (c) => {
  const auth = c.get("auth");
  // Local dev: no RELEASED_API_KEY secret bound → the auth middleware skips and
  // attaches no identity. Treat as the implicit local root so login works
  // against a local worker.
  if (!auth) {
    return c.json({
      kind: "root",
      name: "local-dev",
      scopes: [ROOT_SCOPE],
      principalType: "internal",
      principalId: null,
      expiresAt: null,
      lastUsedAt: null,
    } satisfies TokenIdentity);
  }
  if (auth.kind === "root") {
    return c.json({
      kind: "root",
      name: "root",
      scopes: auth.scopes,
      principalType: "internal",
      principalId: null,
      expiresAt: null,
      lastUsedAt: null,
    } satisfies TokenIdentity);
  }
  const db = createDb(c.env.DB);
  const row = await db.select().from(apiTokens).where(eq(apiTokens.id, auth.tokenId)).get();
  if (!row) return c.json({ error: "unauthorized", message: "Invalid or missing API key" }, 401);
  return c.json({
    kind: "token",
    name: row.name,
    scopes: parseStoredScopes(row.scopes),
    principalType: row.principalType,
    principalId: row.principalId,
    expiresAt: row.expiresAt,
    lastUsedAt: row.lastUsedAt,
  } satisfies TokenIdentity);
});
```

- [ ] **Step 4: Run it green**

Run: `bun test tests/api/api-tokens-route.test.ts`
Expected: PASS (all existing + 3 new).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/api-tokens.ts tests/api/api-tokens-route.test.ts
git commit -m "feat(api): GET /v1/tokens/me self-introspection handler" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task A4: wire `tokensAuthMiddleware` in index.ts

**Files:**

- Modify: `workers/api/src/index.ts` (import + the adminRoutes auth loop at lines ~268–271)

- [ ] **Step 1: Add the import**

In `workers/api/src/index.ts`, update the auth-middleware import (line 4):

```ts
import {
  authMiddleware,
  publicReadAuthMiddleware,
  tokensAuthMiddleware,
} from "./middleware/auth.js";
```

- [ ] **Step 2: Branch the middleware in the adminRoutes loop**

Replace the existing loop (lines ~268–271):

```ts
for (const r of adminRoutes) {
  v1.use(`/${r}`, authMiddleware, dbHealthCheck);
  v1.use(`/${r}/*`, authMiddleware, dbHealthCheck);
}
```

with:

```ts
for (const r of adminRoutes) {
  // /tokens needs a split gate: read for /tokens/me self-introspection, admin
  // for the rest. Every other admin namespace stays admin-only.
  const mw = r === "tokens" ? tokensAuthMiddleware : authMiddleware;
  v1.use(`/${r}`, mw, dbHealthCheck);
  v1.use(`/${r}/*`, mw, dbHealthCheck);
}
```

(The `adminCors` loop below is unchanged — `/tokens/me` keeping the first-party CORS profile is harmless; the CLI sends no `Origin`.)

- [ ] **Step 3: Typecheck both roots and run the full suite**

Run: `npx tsc --noEmit && cd workers/api && npx tsc --noEmit && cd -`
Expected: PASS.

Run: `bun test tests/api/`
Expected: PASS (no regressions; A2 + A3 tests green).

- [ ] **Step 4: Commit**

```bash
git add workers/api/src/index.ts
git commit -m "feat(api): mount tokensAuthMiddleware for the tokens namespace" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Lint + format the worktree**

Run: `bun run lint && bun run format:check`
Expected: PASS. If `format:check` fails, run `bun run format` and amend the relevant commit.

---

## Task A5: deploy Phase A to staging and smoke

**Files:** none (deploy + manual verification)

- [ ] **Step 1: Deploy the API worker to staging**

Per repo convention (branch deploys via GHA dispatch — see memory), prefer:

Run: `gh workflow run deploy-workers.yml --ref worktree-cli-auth-token-storage -f worker=api -f environment=staging`

(Or, locally against staging if authed: `bunx wrangler deploy --env staging --config workers/api/wrangler.jsonc`.)

- [ ] **Step 2: Smoke `/v1/tokens/me`**

Staging requires the staging access key header. The prod admin token from root `.env` (`RELEASES_API_KEY_ADMIN`) is for the **prod** host. For staging use a staging token + the staging access key:

```bash
# Anonymous → 401 (with the staging access key present to clear the gate)
curl -s -o /dev/null -w "%{http_code}\n" \
  -H "X-Releases-Staging-Key: $STAGING_ACCESS_KEY" \
  https://api-staging.releases.sh/v1/tokens/me
# Expected: 401

# Valid token → 200 with identity JSON
curl -s -H "X-Releases-Staging-Key: $STAGING_ACCESS_KEY" \
  -H "Authorization: Bearer <a-relk-token>" \
  https://api-staging.releases.sh/v1/tokens/me
# Expected: {"kind":"token","name":...,"scopes":[...]}
```

Expected: anonymous → `401`; valid token → `200` with `{ kind, name, scopes }`.

> Phase A is additive and safe to promote to prod independently (the endpoint is new; nothing else changes). Confirm the prod smoke with the prod admin token before relying on the CLI against prod.

---

# Phase B — CLI (`~/Code/releases-cli`)

> All Phase B tasks run with cwd `~/Code/releases-cli`. Test runner is `bun test`; typecheck is `tsc --noEmit` (`bun run typecheck`); lint is `oxlint` (`bun run lint`).

## Task B0: branch the CLI repo

- [ ] **Step 1: Create a branch**

```bash
cd ~/Code/releases-cli
git checkout -b feat/auth-token-storage
git status
```

Expected: clean tree on `feat/auth-token-storage`.

---

## Task B1: credential file storage

**Files:**

- Create: `src/lib/credentials.ts`
- Test: `tests/unit/credentials.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/credentials.test.ts`:

```ts
import { describe, it, expect, afterAll } from "bun:test";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rel-creds-"));
process.env.RELEASED_DATA_DIR = dir;

const { readCredential, writeCredential, clearCredential } =
  await import("../../src/lib/credentials.js");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("credentials", () => {
  it("round-trips a credential and stores it 0600", () => {
    writeCredential({
      token: "relk_abc_def",
      name: "laptop",
      scopes: ["read", "write"],
      apiUrl: "https://api.releases.sh",
      savedAt: "2026-05-20T00:00:00.000Z",
    });
    const read = readCredential();
    expect(read?.token).toBe("relk_abc_def");
    expect(read?.scopes).toEqual(["read", "write"]);
    const mode = statSync(join(dir, "credentials")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("returns null on a corrupt file", () => {
    writeFileSync(join(dir, "credentials"), "{ not json");
    expect(readCredential()).toBeNull();
  });

  it("clear removes the file and reports it", () => {
    writeCredential({ token: "relk_x_y", apiUrl: "u", savedAt: "t" });
    expect(clearCredential()).toBe(true);
    expect(readCredential()).toBeNull();
    expect(clearCredential()).toBe(false);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test tests/unit/credentials.test.ts`
Expected: FAIL — cannot resolve `../../src/lib/credentials.js`.

- [ ] **Step 3: Implement**

Create `src/lib/credentials.ts`:

```ts
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getDataDir } from "@releases/lib/config";

export interface StoredCredential {
  token: string;
  name?: string;
  scopes?: string[];
  /** API URL the token was verified against (prod/staging tokens don't cross DBs). */
  apiUrl: string;
  savedAt: string;
}

function credentialPath(): string {
  return join(getDataDir(), "credentials");
}

export function readCredential(): StoredCredential | null {
  const path = credentialPath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredCredential;
    if (typeof parsed?.token !== "string" || !parsed.token) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function writeCredential(cred: StoredCredential): void {
  const path = credentialPath();
  mkdirSync(dirname(path), { recursive: true });
  // Atomic write: temp file + rename so a crash never leaves a partial file.
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(cred, null, 2), { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/** Remove the stored credential. Returns true if a file was actually removed. */
export function clearCredential(): boolean {
  const path = credentialPath();
  if (!existsSync(path)) return false;
  rmSync(path);
  return true;
}
```

- [ ] **Step 4: Run it green**

Run: `bun test tests/unit/credentials.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/credentials.ts tests/unit/credentials.test.ts
git commit -m "feat(cli): 0600 credential file storage" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task B2: masked TTY prompt

**Files:**

- Create: `src/lib/prompt-hidden.ts`
- Test: `tests/unit/prompt-hidden.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/prompt-hidden.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { hiddenPromptReader } from "../../src/lib/prompt-hidden.js";

describe("hiddenPromptReader", () => {
  it("returns null when stdin is not a TTY", async () => {
    // In the test runner stdin is not a TTY.
    expect(await hiddenPromptReader("token: ")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test tests/unit/prompt-hidden.test.ts`
Expected: FAIL — cannot resolve module.

- [ ] **Step 3: Implement**

Create `src/lib/prompt-hidden.ts`:

```ts
import { createInterface } from "node:readline";
import { Writable } from "node:stream";
import type { PromptReader } from "./confirm.js";

/**
 * Reads a single line from the TTY without echoing keystrokes. Returns null when
 * stdin is not a TTY (so callers fall back to --token / stdin). Mirrors the
 * injectable-reader pattern in confirm.ts.
 */
export const hiddenPromptReader: PromptReader = async (question) => {
  if (!process.stdin.isTTY) return null;
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stderr.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output: out, terminal: true });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(question, (a) => resolve(a));
      muted = true; // mute echo right after the prompt text is written
    });
    process.stderr.write("\n");
    return answer;
  } finally {
    rl.close();
  }
};
```

- [ ] **Step 4: Run it green**

Run: `bun test tests/unit/prompt-hidden.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/prompt-hidden.ts tests/unit/prompt-hidden.test.ts
git commit -m "feat(cli): masked TTY reader for token entry" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task B3: credential resolution in mode.ts

**Files:**

- Modify: `src/lib/mode.ts` (full rewrite of the module)
- Test: `tests/unit/mode-credential.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/mode-credential.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rel-mode-"));
process.env.RELEASED_DATA_DIR = dir;

const { writeCredential, clearCredential } = await import("../../src/lib/credentials.js");
const { resolveCredential, isAuthenticated, getApiKey } = await import("../../src/lib/mode.js");

afterAll(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  delete process.env.RELEASED_API_KEY;
  clearCredential();
});

describe("resolveCredential precedence", () => {
  it("none when nothing is configured", () => {
    const c = resolveCredential();
    expect(c.token).toBeNull();
    expect(c.source).toBe("none");
    expect(isAuthenticated()).toBe(false);
  });

  it("uses the stored file when present", () => {
    writeCredential({
      token: "relk_file_tok",
      name: "laptop",
      scopes: ["read"],
      apiUrl: "https://api.releases.sh",
      savedAt: "t",
    });
    const c = resolveCredential();
    expect(c.source).toBe("file");
    expect(c.token).toBe("relk_file_tok");
    expect(c.scopes).toEqual(["read"]);
    expect(getApiKey()).toBe("relk_file_tok");
  });

  it("env var wins over the stored file", () => {
    writeCredential({ token: "relk_file_tok", apiUrl: "u", savedAt: "t" });
    process.env.RELEASED_API_KEY = "env-key";
    const c = resolveCredential();
    expect(c.source).toBe("env");
    expect(c.token).toBe("env-key");
  });

  it("getApiKey throws when unauthenticated", () => {
    expect(() => getApiKey()).toThrow();
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test tests/unit/mode-credential.test.ts`
Expected: FAIL — `resolveCredential` is not exported by mode.ts.

- [ ] **Step 3: Implement (rewrite mode.ts)**

Replace the entire contents of `src/lib/mode.ts`:

```ts
import { logger } from "@releases/lib/logger";
import { readCredential } from "./credentials.js";

const DEFAULT_API_URL = "https://api.releases.sh";

let _apiUrl: string | null = null;

export interface ResolvedCredential {
  token: string | null;
  source: "env" | "file" | "none";
  scopes?: string[];
  name?: string;
  apiUrl?: string;
}

/** Resolve the active credential: explicit env var wins, then the stored file. */
export function resolveCredential(): ResolvedCredential {
  const envKey = process.env.RELEASED_API_KEY;
  if (envKey) return { token: envKey, source: "env" };
  const stored = readCredential();
  if (stored) {
    return {
      token: stored.token,
      source: "file",
      scopes: stored.scopes,
      name: stored.name,
      apiUrl: stored.apiUrl,
    };
  }
  return { token: null, source: "none" };
}

/** True when any credential resolves (env var or stored file). */
export function isAuthenticated(): boolean {
  return resolveCredential().token !== null;
}

/** Back-compat alias — historically "admin mode" meant "a credential is present". */
export const isAdminMode = isAuthenticated;

export function getApiUrl(): string {
  if (!_apiUrl) {
    const url = process.env.RELEASED_API_URL || DEFAULT_API_URL;
    _apiUrl = url.replace(/\/$/, "");
  }
  return _apiUrl;
}

export function getApiKey(): string {
  const { token } = resolveCredential();
  if (!token) {
    throw new Error("Not authenticated. Run `releases auth login` or set RELEASED_API_KEY.");
  }
  return token;
}

/**
 * Call at CLI startup. With stored credentials, a custom RELEASED_API_URL is no
 * longer fatal (you may be about to `releases auth login`, or doing anonymous
 * reads) — it downgrades to a warning. Also warns when a stored token was
 * verified against a different environment than the active URL.
 */
export function validateConfig(): void {
  const cred = resolveCredential();
  if (process.env.RELEASED_API_URL && cred.source === "none") {
    logger.warn(
      "RELEASED_API_URL is set but no API token is configured. Requests will be unauthenticated — run `releases auth login` to authenticate.",
    );
  }
  if (cred.source === "file" && cred.apiUrl && cred.apiUrl !== getApiUrl()) {
    logger.warn(
      `Stored token was verified against ${cred.apiUrl}, but the active API URL is ${getApiUrl()}. It may not be accepted.`,
    );
  }
}
```

> If `tsc` reports `logger.warn` does not exist, the CLI logger lacks a `warn` level — use `logger.error` for both warnings instead and re-run typecheck.

- [ ] **Step 4: Run it green**

Run: `bun test tests/unit/mode-credential.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Typecheck (catches the logger.warn question + the isAdminMode alias)**

Run: `bun run typecheck`
Expected: PASS. `client.ts`, `whoami.ts`, and `program.ts` import `isAdminMode`/`getApiKey` — they still resolve (alias + same signature).

- [ ] **Step 6: Commit**

```bash
git add src/lib/mode.ts tests/unit/mode-credential.test.ts
git commit -m "feat(cli): resolveCredential (env>file) + relaxed validateConfig" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task B4: `auth` command namespace

**Files:**

- Create: `src/cli/commands/auth.ts`
- Test: `tests/unit/auth-login.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/auth-login.test.ts`:

```ts
import { describe, it, expect } from "bun:test";
import { verifyToken, resolveTokenInput } from "../../src/cli/commands/auth.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("verifyToken", () => {
  it("returns the identity on 200", async () => {
    const fetchFn = (async () =>
      jsonResponse({ kind: "token", name: "laptop", scopes: ["read", "write"] })) as typeof fetch;
    const id = await verifyToken("relk_x_y", "https://api.releases.sh", fetchFn);
    expect(id.name).toBe("laptop");
    expect(id.scopes).toEqual(["read", "write"]);
  });

  it("throws on 401", async () => {
    const fetchFn = (async () => jsonResponse({ error: "unauthorized" }, 401)) as typeof fetch;
    await expect(verifyToken("relk_bad", "https://api.releases.sh", fetchFn)).rejects.toThrow(
      /rejected/i,
    );
  });

  it("throws on 500", async () => {
    const fetchFn = (async () => jsonResponse({}, 500)) as typeof fetch;
    await expect(verifyToken("relk_x_y", "https://api.releases.sh", fetchFn)).rejects.toThrow(
      /500/,
    );
  });
});

describe("resolveTokenInput", () => {
  it("returns a provided --token value (trimmed)", async () => {
    const reader = async () => "should-not-be-used";
    expect(await resolveTokenInput("  relk_a_b  ", reader)).toBe("relk_a_b");
  });

  it("uses the reader when no --token and a value comes back", async () => {
    const reader = async () => "  relk_from_prompt ";
    expect(await resolveTokenInput(undefined, reader)).toBe("relk_from_prompt");
  });

  it("throws when no --token and not a TTY (reader returns null)", async () => {
    const reader = async () => null;
    await expect(resolveTokenInput(undefined, reader)).rejects.toThrow(/No token/i);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test tests/unit/auth-login.test.ts`
Expected: FAIL — cannot resolve `auth.js` / exports missing.

- [ ] **Step 3: Implement**

Create `src/cli/commands/auth.ts`:

```ts
import { Command } from "commander";
import chalk from "chalk";
import { join } from "node:path";
import { getDataDir } from "@releases/lib/config";
import { getApiUrl, resolveCredential } from "../../lib/mode.js";
import { writeCredential, clearCredential, type StoredCredential } from "../../lib/credentials.js";
import { hiddenPromptReader } from "../../lib/prompt-hidden.js";
import type { PromptReader } from "../../lib/confirm.js";
import { writeJson } from "../../lib/output.js";
import { RELEASES_CLI_UA } from "../../lib/user-agent.js";

export interface TokenIdentity {
  kind: "root" | "token";
  name: string;
  scopes: string[];
  principalType?: string;
  principalId?: string | null;
  expiresAt?: string | null;
  lastUsedAt?: string | null;
}

/** Verify a token against GET /v1/tokens/me. Throws a friendly Error on failure. */
export async function verifyToken(
  token: string,
  apiUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<TokenIdentity> {
  const res = await fetchFn(`${apiUrl}/v1/tokens/me`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": RELEASES_CLI_UA },
  });
  if (res.status === 401) throw new Error("Token rejected by the server (401).");
  if (!res.ok) throw new Error(`Server returned ${res.status} verifying the token.`);
  return (await res.json()) as TokenIdentity;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8").trim();
}

/** Resolve the token from --token (value or "-"), stdin, or an interactive prompt. */
export async function resolveTokenInput(
  optToken: string | undefined,
  reader: PromptReader,
): Promise<string> {
  if (optToken === "-") return readStdin();
  if (optToken) return optToken.trim();
  const entered = await reader("Paste your API token: ");
  if (entered === null) {
    throw new Error("No token provided. Pass --token <token> (or '-' to read from stdin).");
  }
  return entered.trim();
}

/** Shared status renderer used by `auth status` and `whoami`. */
export async function printAuthStatus(opts: { json?: boolean; verify?: boolean }): Promise<void> {
  const cred = resolveCredential();
  const apiUrl = getApiUrl();
  let identity: TokenIdentity | null = null;
  let verifyError: string | null = null;
  // Env-sourced tokens have no stored metadata, so verify to learn name/scopes.
  if (cred.token && (opts.verify || cred.source === "env")) {
    try {
      identity = await verifyToken(cred.token, apiUrl);
    } catch (err) {
      verifyError = (err as Error).message;
    }
  }
  const scopes = identity?.scopes ?? cred.scopes ?? null;
  const name = identity?.name ?? cred.name ?? null;

  if (opts.json) {
    await writeJson({
      authenticated: cred.token !== null,
      source: cred.source,
      apiUrl,
      name,
      scopes,
      verified: identity !== null,
      verifyError,
    });
    return;
  }

  const label = (k: string) => chalk.dim(k.padEnd(10));
  console.log(chalk.bold("releases auth\n"));
  console.log(
    `${label("Status")}${cred.token ? chalk.green("authenticated") : chalk.red("not authenticated")}`,
  );
  console.log(`${label("Source")}${cred.source === "none" ? chalk.dim("—") : cred.source}`);
  console.log(`${label("API URL")}${apiUrl}`);
  console.log(`${label("Name")}${name ?? chalk.dim("—")}`);
  console.log(`${label("Scopes")}${scopes ? scopes.join(", ") : chalk.dim("—")}`);
  if (verifyError) console.log(`${label("Verify")}${chalk.red(verifyError)}`);
  else if (identity) console.log(`${label("Verify")}${chalk.green("✓ live")}`);
}

export function registerAuthCommand(parent: Command): void {
  const auth = parent.command("auth").description("Manage CLI authentication");

  auth
    .command("login")
    .description("Verify and store an API token")
    .option("--token <token>", "Token value, or '-' to read from stdin")
    .action(async (opts: { token?: string }) => {
      let token: string;
      try {
        token = await resolveTokenInput(opts.token, hiddenPromptReader);
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
      if (!token) {
        console.error(chalk.red("No token provided."));
        process.exit(1);
      }
      const apiUrl = getApiUrl();
      let identity: TokenIdentity;
      try {
        identity = await verifyToken(token, apiUrl);
      } catch (err) {
        console.error(chalk.red(`✗ ${(err as Error).message} Not saved.`));
        process.exit(1);
      }
      const cred: StoredCredential = {
        token,
        name: identity.name,
        scopes: identity.scopes,
        apiUrl,
        savedAt: new Date().toISOString(),
      };
      writeCredential(cred);
      console.log(
        `${chalk.green("✓")} Verified — ${chalk.bold(identity.name)} ${chalk.dim(
          `(scopes: ${identity.scopes.join(", ")})`,
        )}`,
      );
      console.log(chalk.dim(`  Saved to ${join(getDataDir(), "credentials")}`));
    });

  auth
    .command("logout")
    .description("Remove the stored API token")
    .action(() => {
      const removed = clearCredential();
      if (process.env.RELEASED_API_KEY) {
        console.log(
          chalk.yellow(
            "Removed any stored token, but RELEASED_API_KEY is still set in your environment.",
          ),
        );
      } else if (removed) {
        console.log(`${chalk.green("✓")} Logged out (stored token removed).`);
      } else {
        console.log(chalk.dim("No stored token to remove."));
      }
    });

  auth
    .command("status")
    .description("Show authentication status")
    .option("--json", "Output as JSON")
    .option("--verify", "Re-check the token against the API")
    .action(async (opts: { json?: boolean; verify?: boolean }) => {
      await printAuthStatus(opts);
    });

  auth
    .command("token")
    .description("Print the current API token (for scripts)")
    .action(() => {
      const { token } = resolveCredential();
      if (!token) {
        console.error(
          chalk.red("Not authenticated. Run `releases auth login` or set RELEASED_API_KEY."),
        );
        process.exit(1);
      }
      process.stdout.write(`${token}\n`);
    });
}
```

- [ ] **Step 4: Run it green**

Run: `bun test tests/unit/auth-login.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/cli/commands/auth.ts tests/unit/auth-login.test.ts
git commit -m "feat(cli): auth login/logout/status/token commands" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task B5: register `auth` + admin scope pre-flight

**Files:**

- Create: `src/lib/preflight.ts`
- Test: `tests/unit/preflight.test.ts`
- Modify: `src/cli/program.ts`

- [ ] **Step 1: Write the failing test for the pure helper**

Create `tests/unit/preflight.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "rel-pf-"));
process.env.RELEASED_DATA_DIR = dir;

const { writeCredential, clearCredential } = await import("../../src/lib/credentials.js");
const { preflightScopeWarning } = await import("../../src/lib/preflight.js");

afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  delete process.env.RELEASED_API_KEY;
  clearCredential();
});

describe("preflightScopeWarning", () => {
  it("warns for a file token without write scope", () => {
    writeCredential({ token: "relk_a_b", scopes: ["read"], apiUrl: "u", savedAt: "t" });
    expect(preflightScopeWarning()).toMatch(/read/);
  });

  it("no warning when the file token has write", () => {
    writeCredential({ token: "relk_a_b", scopes: ["read", "write"], apiUrl: "u", savedAt: "t" });
    expect(preflightScopeWarning()).toBeNull();
  });

  it("no warning for env-sourced tokens (scopes unknown)", () => {
    process.env.RELEASED_API_KEY = "env-key";
    expect(preflightScopeWarning()).toBeNull();
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test tests/unit/preflight.test.ts`
Expected: FAIL — cannot resolve `preflight.js`.

- [ ] **Step 3: Implement the helper**

Create `src/lib/preflight.ts`:

```ts
import { scopeSatisfies } from "@buildinternet/releases-core/api-token";
import { resolveCredential } from "./mode.js";

/**
 * Coarse pre-flight check for the admin subtree. Returns a warning string when a
 * file-sourced token's cached scopes don't satisfy `write` (so an admin command
 * is likely to 403), or null. Env-sourced tokens have unknown scopes → no
 * warning; the server stays authoritative either way.
 */
export function preflightScopeWarning(): string | null {
  const cred = resolveCredential();
  if (cred.source === "file" && cred.scopes && !scopeSatisfies(cred.scopes, "write")) {
    return `Your stored token's scopes (${cred.scopes.join(", ")}) may not cover this command. Trying anyway…`;
  }
  return null;
}
```

- [ ] **Step 4: Run it green**

Run: `bun test tests/unit/preflight.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire `auth` registration + admin gate in program.ts**

In `src/cli/program.ts`:

Add imports near the other command imports:

```ts
import { registerAuthCommand } from "./commands/auth.js";
import { isAuthenticated } from "../lib/mode.js";
import { preflightScopeWarning } from "../lib/preflight.js";
```

(If `isAdminMode` is already imported, keep it — but the gate logic below switches to `isAuthenticated`.)

Add a shared admin-gate helper near `adminKeyError` (around line 54):

```ts
function adminGate(): void {
  if (!isAuthenticated()) adminKeyError("admin");
  const warn = preflightScopeWarning();
  if (warn) console.error(chalk.yellow(`⚠ ${warn}`));
}
```

Replace the body of `gateAdminSubtree`'s preAction hook (around line 68–73):

```ts
function gateAdminSubtree(root: Command): void {
  for (const sub of root.commands) {
    sub.hook("preAction", () => {
      adminGate();
    });
    gateAdminSubtree(sub);
  }
}
```

Update the root-program preAction hook (around line 148) to:

```ts
.hook("preAction", (_thisCommand, actionCommand) => {
  if (actionCommand.name() !== "admin" && isWithinAdminCommand(actionCommand)) {
    adminGate();
  }
})
```

Update the `admin` command preAction hook (around line 194) to:

```ts
.hook("preAction", (_thisCommand, actionCommand) => {
  if (actionCommand.name() !== "admin") {
    adminGate();
  }
})
```

Register the auth command alongside `registerWhoamiCommand(program)` (around line 185):

```ts
registerAuthCommand(program);
```

- [ ] **Step 6: Typecheck**

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/preflight.ts tests/unit/preflight.test.ts src/cli/program.ts
git commit -m "feat(cli): register auth namespace + hybrid scope pre-flight" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task B6: `whoami` delegates to `auth status`

**Files:**

- Modify: `src/cli/commands/whoami.ts`

- [ ] **Step 1: Inspect any whoami test**

Run: `rg -l "whoami" tests/ ; rg -n "registerWhoamiCommand|collectWhoami|redactApiKey" src tests`
Note which tests assert whoami's output shape — they will need their expectations aligned to `printAuthStatus` (Status/Source/API URL/Name/Scopes lines, or `--json` keys `authenticated`/`source`/`scopes`).

- [ ] **Step 2: Delegate the action**

In `src/cli/commands/whoami.ts`, import the shared renderer and replace the command's `.action(...)` body so it delegates (keep the command name, description, and `--json`; map `--check` → `--verify`):

```ts
import { printAuthStatus } from "./auth.js";
```

```ts
export function registerWhoamiCommand(parent: Command): void {
  parent
    .command("whoami")
    .description("Show current CLI auth status (alias for `auth status`)")
    .option("--json", "Output as JSON")
    .option("--check", "Probe the API to verify the token")
    .action(async (opts: { json?: boolean; check?: boolean }) => {
      await printAuthStatus({ json: opts.json, verify: opts.check });
    });
}
```

Leave the existing exported helpers (`redactApiKey`, `collectWhoami`, `WhoamiStatus`) in place if other modules/tests import them; if nothing imports them after this change (confirm with the Step 1 grep), delete them to avoid dead code.

- [ ] **Step 3: Align/update whoami tests**

Update any test found in Step 1 so its assertions match `printAuthStatus` output. Run: `bun test tests/` and fix expectations until green.

- [ ] **Step 4: Typecheck + commit**

Run: `bun run typecheck`
Expected: PASS.

```bash
git add src/cli/commands/whoami.ts tests/
git commit -m "refactor(cli): whoami delegates to auth status" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task B7: `gateAdminArgv` honors stored credentials

**Files:**

- Modify: `src/index.ts`
- Test: `tests/cli/auth.test.ts` (created here; covers gate + full flow)

- [ ] **Step 1: Write the failing end-to-end test**

Create `tests/cli/auth.test.ts`:

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli } from "../utils.js";

let server: ReturnType<typeof Bun.serve> | null = null;
let baseUrl = "";
let dataDir = "";

beforeAll(() => {
  dataDir = mkdtempSync(join(tmpdir(), "rel-authcli-"));
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/v1/tokens/me") {
        const auth = req.headers.get("authorization") ?? "";
        if (auth !== "Bearer relk_good_token") return new Response("{}", { status: 401 });
        return Response.json({ kind: "token", name: "laptop", scopes: ["read", "write"] });
      }
      // Stand-in for an admin read so `admin source list` doesn't network-fail.
      return Response.json({ sources: [] });
    },
  });
  baseUrl = `http://localhost:${server.port}`;
});

afterAll(() => {
  server?.stop(true);
  rmSync(dataDir, { recursive: true, force: true });
});

const env = () => ({ RELEASED_API_KEY: "", RELEASED_API_URL: baseUrl, RELEASED_DATA_DIR: dataDir });

describe("releases auth (e2e)", () => {
  it("login --token verifies and stores the credential", () => {
    const r = runCli(["auth", "login", "--token", "relk_good_token"], { env: env() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/Verified/);
    expect(existsSync(join(dataDir, "credentials"))).toBe(true);
  });

  it("token prints the stored token", () => {
    const r = runCli(["auth", "token"], { env: env() });
    expect(r.exitCode).toBe(0);
    expect(r.stdout.trim()).toBe("relk_good_token");
  });

  it("status --json reports authenticated + file source", () => {
    const r = runCli(["auth", "status", "--json"], { env: env() });
    const body = JSON.parse(r.stdout) as {
      authenticated: boolean;
      source: string;
      scopes: string[];
    };
    expect(body.authenticated).toBe(true);
    expect(body.source).toBe("file");
    expect(body.scopes).toEqual(["read", "write"]);
  });

  it("login rejects a bad token without saving", () => {
    const bad = mkdtempSync(join(tmpdir(), "rel-authbad-"));
    const r = runCli(["auth", "login", "--token", "relk_bad"], {
      env: { RELEASED_API_KEY: "", RELEASED_API_URL: baseUrl, RELEASED_DATA_DIR: bad },
    });
    expect(r.exitCode).toBe(1);
    expect(existsSync(join(bad, "credentials"))).toBe(false);
    rmSync(bad, { recursive: true, force: true });
  });

  it("an admin command is allowed with a stored write-capable token", () => {
    const r = runCli(["admin", "source", "list"], { env: env() });
    // Not blocked by the admin-key gate (stored token present).
    expect(r.stderr).not.toMatch(/requires an API key/);
  });

  it("logout removes the stored token", () => {
    const r = runCli(["auth", "logout"], { env: env() });
    expect(r.exitCode).toBe(0);
    expect(existsSync(join(dataDir, "credentials"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test tests/cli/auth.test.ts`
Expected: FAIL — the `admin source list` case fails because `gateAdminArgv` checks `process.env.RELEASED_API_KEY` (unset here) and exits with "requires an API key", even though a stored token exists.

- [ ] **Step 3: Update `gateAdminArgv`**

In `src/index.ts`, add the import and swap the env check:

```ts
import { validateConfig, isAuthenticated } from "./lib/mode.js";
```

Change inside `gateAdminArgv` (line 46) from:

```ts
if (process.env.RELEASED_API_KEY) return;
```

to:

```ts
if (isAuthenticated()) return;
```

- [ ] **Step 4: Run it green**

Run: `bun test tests/cli/auth.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/index.ts tests/cli/auth.test.ts
git commit -m "feat(cli): gateAdminArgv honors stored credentials" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task B8: changeset + README

**Files:**

- Create: `.changeset/cli-auth-token-storage.md`
- Modify: `README.md`

- [ ] **Step 1: Add the changeset**

Create `.changeset/cli-auth-token-storage.md`:

```md
---
"@buildinternet/releases": minor
---

Add `releases auth` commands (`login`, `logout`, `status`, `token`) to store a verified API token in `~/.releases/credentials` (0600). `whoami` now aliases `auth status`. Tokens are verified against `GET /v1/tokens/me` before saving; the env var `RELEASED_API_KEY` still takes precedence.
```

- [ ] **Step 2: Document in README**

Add an "Authentication" section to `README.md` documenting:

- `releases auth login [--token <t>|-]` (interactive prompt, `--token`, or stdin), verifies + stores.
- `releases auth status [--json] [--verify]`, `releases auth token`, `releases auth logout`.
- Precedence: `RELEASED_API_KEY` env var overrides the stored file.
- Where it's stored (`~/.releases/credentials`, `0600`).

- [ ] **Step 3: Commit**

```bash
git add .changeset/cli-auth-token-storage.md README.md
git commit -m "docs(cli): document releases auth + add changeset" \
  -m "Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>"
```

---

## Task B9: full CLI verification

**Files:** none (verification)

- [ ] **Step 1: Run the whole CLI suite + gates**

Run: `bun test && bun run typecheck && bun run lint`
Expected: PASS. If a formatter is configured (`format:check`), run it too and fix.

- [ ] **Step 2: Manual smoke against staging (optional but recommended)**

With Phase A deployed to staging and a `relk_` token in hand:

```bash
RELEASED_API_URL=https://api-staging.releases.sh RELEASED_API_KEY= \
  bun src/index.ts auth login --token <relk_token>
# Expected: ✓ Verified — "<name>" (scopes: …)  /  Saved to ~/.releases/credentials
RELEASED_API_KEY= bun src/index.ts auth status
RELEASED_API_KEY= bun src/index.ts auth logout
```

> Note: staging also requires the staging access key on every request; if the verify call 401s with the access-key gate rather than the token, that's the staging gate, not the token path — test against prod once Phase A is promoted, or add the staging key plumbing out of band.

---

## Self-Review

**1. Spec coverage**

| Spec section                                                                                                                             | Task(s)                                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Part 1 — `GET /v1/tokens/me`, read-gated, `TokenIdentity`, synthetic root, gating wrinkle                                                | A1, A2, A3, A4                                                         |
| Part 2 — `0600` credential file, atomic write, read/write/clear                                                                          | B1                                                                     |
| Part 3 — `resolveCredential` precedence, `isAuthenticated`/`isAdminMode` alias, `getApiKey`, relaxed `validateConfig` + mismatch warning | B3                                                                     |
| Part 4 — `auth login/logout/status/token`, masked prompt, `--token`/stdin, verify-before-persist, `whoami` alias                         | B2, B4, B6                                                             |
| Part 5 — admin gate → `isAuthenticated`, coarse write-tier pre-flight, env tokens no warning                                             | B5, B7                                                                 |
| Part 6 — token never logged (only `auth token` emits), `0600`, verify-before-persist                                                     | B1, B4 (verifyToken never logs the token; no `logger` call carries it) |
| Testing matrix (CLI + API)                                                                                                               | B1, B3, B4, B5, B7 + A2, A3                                            |
| Non-goal: `--web` reserved-not-registered                                                                                                | Not implemented (documented in spec); no `--web` flag added            |

**2. Placeholder scan:** No "TBD"/"add error handling"/"similar to Task N". The only conditional instructions are concrete and bounded (logger.warn fallback in B3 Step 3; whoami test alignment in B6 Steps 1/3) — each names the exact action.

**3. Type consistency:**

- `TokenIdentity` — defined in api-types (A1) for the worker; redefined locally in the CLI `auth.ts` (B4) on purpose to avoid coupling to a published api-types bump. Field names match (`kind`/`name`/`scopes`/`principalType`).
- `StoredCredential` — defined in B1, imported in B4 (`writeCredential` arg) and returned by `readCredential` (B1). Consistent fields: `token`, `name?`, `scopes?`, `apiUrl`, `savedAt`.
- `ResolvedCredential` — defined in B3, consumed in B4 (`resolveCredential().token/.source/.scopes`), B5 (`.source`/`.scopes`). Consistent.
- `resolveTokenInput`, `verifyToken`, `printAuthStatus`, `preflightScopeWarning`, `isAuthenticated`, `getApiKey` — names identical across definition and call sites.
- API: `requireReadAuthMiddleware`, `tokensAuthMiddleware` defined in A2, imported in A4; route `/tokens/me` (A3) matches the wrapper's `endsWith("/tokens/me")` check (A2).

---

## Execution Handoff

After this plan is saved, choose an execution approach (see the skill's handoff).
