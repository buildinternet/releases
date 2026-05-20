# MCP Scope Enforcement (Scoped API Tokens — Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the remote MCP worker verify the caller's `relk_` API token, derive scopes, gate write/AI tools + the on-demand GitHub lookup on `write`, and fix the confused deputy by forwarding the caller's own credential (never the static root key) on the `/v1/lookups` fallback.

**Architecture:** Extract the existing `verifyApiToken`/`touchLastUsed` D1 verification out of `workers/api/src/middleware/token-store.ts` into `@releases/core-internal/api-token-store` so both workers share one verification path. The MCP worker resolves identity at the HTTP boundary (`index.ts`, where the inbound `Authorization` header is visible) and threads `authScopes` + raw `authToken` into `createServer` — the only place tool handlers can read per-request auth, since `createMcpHandler` does not expose request headers to handlers. Public reads stay anonymous (implicit `read`); only the privileged paths require `write`.

**Tech Stack:** Cloudflare Workers, Hono (API), `@modelcontextprotocol/sdk` (MCP), Drizzle over D1, `@buildinternet/releases-core/api-token` (pure helpers), Bun test + `InMemoryTransport` for MCP tests.

---

## Design decisions (locked)

1. **Anonymous MCP reads stay open.** No token ⇒ implicit `["read"]` scope. The token machinery only governs elevating to `write`/AI tools and the on-demand lookup. Reads are public exactly like the API worker's public-read GETs. `API_TOKENS_DISABLED=true` does not change read openness — it only disables the relk-token path (rollback to "lookup uses root for everyone").
2. **Confused-deputy fix = forward the caller's own token.** `maybeLookup` only fires when the caller's scopes satisfy `write`, and forwards the caller's `relk_` token (or, for a static-root caller, the root key — root using root is not a confused deputy). Anonymous/read callers never trigger the root-privileged indexer. **Visible prod behavior change:** on-demand GitHub lookup via the public MCP now requires a `write`-scoped token instead of silently borrowing root for everyone.
3. **Single verification path, shared module.** `verifyApiToken`/`touchLastUsed` move to `@releases/core-internal/api-token-store` (DB-coupled ⇒ core-internal, not pure `core`). The API worker's `token-store.ts` becomes a thin re-export so its importers and tests are untouched.
4. **Bearer disambiguation by shape.** `relk_`-prefixed Bearer ⇒ DB-token path; anything else ⇒ static-key / staging-key path. No credential is eligible for both.
5. **Staging gate gains a token bridge.** A valid staging-DB `relk_` token (or the static root key) also satisfies the staging access gate, so an Anthropic managed agent can authenticate to `mcp-staging` with a Bearer token instead of the shared staging key. The existing `X-Releases-Staging-Key` header and `Authorization: Bearer <staging-key>` forms keep working unchanged.
6. **Per-tool scope map.** Read tools (the 11 public tools) require nothing beyond the implicit `read`. AI tools (`summarize_changes`, `compare_products`, gated behind `ENABLE_AI_TOOLS`) require `write`. The lookup sub-action inside `search` requires `write`.

## File Structure

- **Create** `packages/core-internal/src/api-token-store.ts` — shared `verifyApiToken`/`touchLastUsed`/`TokenVerifyResult`, db typed as `DrizzleD1Database<any>`.
- **Modify** `packages/core-internal/package.json` — add `"./api-token-store"` export.
- **Modify** `workers/api/src/middleware/token-store.ts` — collapse to a re-export of the shared module.
- **Create** `workers/mcp/src/auth.ts` — `resolveMcpAuth(request, env)` (identity + staging gate) and `McpIdentity` type.
- **Modify** `workers/mcp/src/index.ts` — replace `checkStagingKey` with `resolveMcpAuth`; thread scopes/token into `createServer`; `touchLastUsed` via `waitUntil`.
- **Modify** `workers/mcp/src/mcp-agent.ts` — `Env.API_TOKENS_DISABLED`; `CreateServerOptions.authScopes`/`authToken`; `requireScope` wrapper + `scopeError`; gate AI tools; rewrite `maybeLookup`.
- **Modify** `workers/mcp/src/tools.ts` — add `isError?: boolean` to `ToolResult`.
- **Create** `tests/unit/mcp-auth.test.ts` — `resolveMcpAuth` matrix (anonymous/token/root/invalid/disabled + staging gate).
- **Create** `tests/unit/mcp-scope-enforcement.test.ts` — read tools work anonymously; AI tools 403-equivalent under read; pass under write.
- **Modify** `tests/unit/mcp-lookup-gate.test.ts` — lookup fires only with `write` scope; forwarded Authorization carries the caller's token, not root.
- **Modify** `AGENTS.md` + `docs/architecture/mcp.md` — document MCP enforcement (Phase 2 → shipped).

---

## Task 1: Extract shared token verification into core-internal

**Files:**

- Create: `packages/core-internal/src/api-token-store.ts`
- Modify: `packages/core-internal/package.json`
- Modify: `workers/api/src/middleware/token-store.ts`
- Test: existing `tests/api/token-store.test.ts`, `tests/api/auth-tokens.test.ts` (must stay green; imports unchanged)

- [ ] **Step 1: Create the shared module** (move the body verbatim from the current `workers/api/src/middleware/token-store.ts`, retyping the db param)

```ts
// packages/core-internal/src/api-token-store.ts
/**
 * Worker-shared verification for opaque `relk_…` API tokens. Lives in
 * core-internal (not pure `core`) because it reads D1 via drizzle. Both the API
 * worker (workers/api/src/middleware/token-store.ts re-exports this) and the
 * MCP worker (workers/mcp/src/auth.ts) call it, so there is one verification
 * path — see docs/superpowers/specs/2026-05-20-scoped-api-tokens-design.md.
 */
import { and, eq, isNull, lt, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { apiTokens } from "@buildinternet/releases-core/schema";
import {
  constantTimeEqual,
  DUMMY_TOKEN_HASH,
  hashSecret,
  parseApiToken,
  parseStoredScopes,
} from "@buildinternet/releases-core/api-token";

/** Loose drizzle handle — D1 in workers, bun:sqlite in tests. */
type AnyDb = DrizzleD1Database<any>;

export type TokenVerifyResult = { ok: true; tokenId: string; scopes: string[] } | { ok: false };

/** How long after a successful auth before we rewrite last_used_at again. */
const LAST_USED_THROTTLE_MS = 60_000;

/**
 * Validate a presented `relk_…` token against the DB. Runs a constant-time hash
 * comparison on every path (including not-found / malformed) so timing and the
 * returned shape are uniform — no enumeration oracle. Returns scopes on success.
 */
export async function verifyApiToken(
  db: AnyDb,
  raw: string,
  now: Date = new Date(),
): Promise<TokenVerifyResult> {
  const parsed = parseApiToken(raw);
  // Always hash so timing doesn't branch on parse success.
  const presentedHash = await hashSecret(parsed?.secret ?? "");

  if (!parsed) {
    constantTimeEqual(presentedHash, DUMMY_TOKEN_HASH);
    return { ok: false };
  }

  const row = await db
    .select()
    .from(apiTokens)
    .where(eq(apiTokens.lookupId, parsed.lookupId))
    .get();

  if (!row) {
    constantTimeEqual(presentedHash, DUMMY_TOKEN_HASH);
    return { ok: false };
  }

  if (!constantTimeEqual(presentedHash, row.tokenHash)) return { ok: false };
  if (!row.active) return { ok: false };
  // Revoked tokens never validate — independent of `active` so a future code
  // path that records a revocation without flipping `active` can't be bypassed.
  if (row.revokedAt) return { ok: false };
  if (row.expiresAt && row.expiresAt <= now.toISOString()) return { ok: false };

  // A minted token always carries at least one scope (mint/PATCH enforce it),
  // so empty/unparseable scopes signal a corrupted row — deny rather than admit
  // a powerless-but-authenticated identity (which would still bypass rate limits).
  const scopes = parseStoredScopes(row.scopes);
  if (scopes.length === 0) return { ok: false };
  return { ok: true, tokenId: row.id, scopes };
}

/**
 * Record last-used, throttled: only rewrites if the previous value is null or
 * older than the throttle window. Single conditional UPDATE — safe to call
 * fire-and-forget via waitUntil on the hot path.
 */
export async function touchLastUsed(
  db: AnyDb,
  tokenId: string,
  now: Date = new Date(),
): Promise<void> {
  const cutoff = new Date(now.getTime() - LAST_USED_THROTTLE_MS).toISOString();
  await db
    .update(apiTokens)
    .set({ lastUsedAt: now.toISOString() })
    .where(
      and(
        eq(apiTokens.id, tokenId),
        or(isNull(apiTokens.lastUsedAt), lt(apiTokens.lastUsedAt, cutoff)),
      ),
    );
}
```

- [ ] **Step 2: Add the export** to `packages/core-internal/package.json` (insert after the `"./release-upsert"` line, keep JSON valid):

```json
    "./api-token-store": "./src/api-token-store.ts",
```

- [ ] **Step 3: Collapse the API worker's token-store to a re-export**

```ts
// workers/api/src/middleware/token-store.ts
/**
 * The implementation moved to @releases/core-internal/api-token-store so the
 * MCP worker shares one verification path (scoped API tokens — Phase 2). This
 * re-export keeps existing importers (auth.ts, tests) on the same specifier.
 */
export {
  verifyApiToken,
  touchLastUsed,
  type TokenVerifyResult,
} from "@releases/core-internal/api-token-store";
```

- [ ] **Step 4: Run the API token tests + worker tsc**

Run: `bun test tests/api/token-store.test.ts tests/api/auth-tokens.test.ts`
Expected: PASS (all existing assertions; the re-export is transparent).

Run: `cd workers/api && npx tsc --noEmit`
Expected: clean (createDb's `D1Db` is assignable to `DrizzleD1Database<any>`).

- [ ] **Step 5: Commit**

```bash
git add packages/core-internal/src/api-token-store.ts packages/core-internal/package.json workers/api/src/middleware/token-store.ts
git commit -m "refactor: extract api-token verification into @releases/core-internal/api-token-store"
```

---

## Task 2: MCP boundary auth resolution (`workers/mcp/src/auth.ts`)

**Files:**

- Create: `workers/mcp/src/auth.ts`
- Modify: `workers/mcp/src/mcp-agent.ts` (add `API_TOKENS_DISABLED?: string` to `Env`)
- Test: `tests/unit/mcp-auth.test.ts`

- [ ] **Step 1: Add `API_TOKENS_DISABLED` to the MCP `Env`** (in `workers/mcp/src/mcp-agent.ts`, alongside the other optional string flags, e.g. after `SEARCH_QUERY_LOG_DISABLED`):

```ts
  /** Kill switch for the relk_ token path — mirrors the API worker. When
   * "true", relk_ tokens are not verified (treated as anonymous read). */
  API_TOKENS_DISABLED?: string;
```

- [ ] **Step 2: Write the failing test** `tests/unit/mcp-auth.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "@buildinternet/releases-core/schema";
import { apiTokens } from "@buildinternet/releases-core/schema";
import { generateApiToken, hashSecret } from "@buildinternet/releases-core/api-token";
import { applyMigrations, makeD1Shim } from "../db-helper.js";
import { resolveMcpAuth } from "../../workers/mcp/src/auth.js";
import type { Env } from "../../workers/mcp/src/mcp-agent.js";

const mockSecret = (v: string) => ({ get: () => Promise.resolve(v) });

let sqlite: Database;
let seedDb: ReturnType<typeof drizzle<typeof schema>>;

async function seed(scopes: string[], extra: Record<string, unknown> = {}): Promise<string> {
  const { token, lookupId, secret } = generateApiToken();
  seedDb
    .insert(apiTokens)
    .values({
      id: (extra.id as string) ?? `tok_${lookupId}`,
      lookupId,
      tokenHash: await hashSecret(secret),
      name: "t",
      scopes: JSON.stringify(scopes),
      ...extra,
    } as typeof apiTokens.$inferInsert)
    .run();
  return token;
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://mcp.releases.sh/mcp", { method: "POST", headers });
}

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: makeD1Shim(sqlite),
    RELEASED_API_KEY: mockSecret("root-secret"),
    ...overrides,
  } as unknown as Env;
}

beforeAll(() => {
  sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
  // Bare D1 drizzle handle over the same sqlite for sync seeding.
  seedDb = drizzle(makeD1Shim(sqlite), { schema }) as unknown as ReturnType<
    typeof drizzle<typeof schema>
  >;
});
afterAll(() => sqlite.close());

describe("resolveMcpAuth — identity (prod, no staging gate)", () => {
  it("no credential ⇒ anonymous read", async () => {
    const r = await resolveMcpAuth(req(), baseEnv());
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.identity).toMatchObject({ kind: "anonymous", scopes: ["read"], token: null });
  });

  it("valid write token ⇒ token identity with its scopes + raw token", async () => {
    const token = await seed(["read", "write"], { id: "tok_w" });
    const r = await resolveMcpAuth(req({ Authorization: `Bearer ${token}` }), baseEnv());
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.identity).toEqual({
        kind: "token",
        scopes: ["read", "write"],
        tokenId: "tok_w",
        token,
      });
  });

  it("invalid relk token ⇒ anonymous (reads stay public, never 401)", async () => {
    const bogus = generateApiToken().token; // unknown lookupId
    const r = await resolveMcpAuth(req({ Authorization: `Bearer ${bogus}` }), baseEnv());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
  });

  it("static root key ⇒ root identity, wildcard scope, no raw token", async () => {
    const r = await resolveMcpAuth(req({ Authorization: "Bearer root-secret" }), baseEnv());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toMatchObject({ kind: "root", scopes: ["*"], token: null });
  });

  it("API_TOKENS_DISABLED ⇒ relk token treated as anonymous", async () => {
    const token = await seed(["write"], { id: "tok_disabled" });
    const r = await resolveMcpAuth(
      req({ Authorization: `Bearer ${token}` }),
      baseEnv({ API_TOKENS_DISABLED: "true" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
  });
});

describe("resolveMcpAuth — staging gate", () => {
  const staging = (o: Partial<Env> = {}) =>
    baseEnv({ STAGING_ACCESS_KEY: mockSecret("stg-key"), ...o });

  it("rejects anonymous when staging gate is bound", async () => {
    const r = await resolveMcpAuth(req(), staging());
    expect(r.ok).toBe(false);
  });

  it("passes with X-Releases-Staging-Key", async () => {
    const r = await resolveMcpAuth(req({ "X-Releases-Staging-Key": "stg-key" }), staging());
    expect(r.ok).toBe(true);
  });

  it("passes with Bearer staging-key (managed-agent legacy)", async () => {
    const r = await resolveMcpAuth(req({ Authorization: "Bearer stg-key" }), staging());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous"); // staging key opens the gate, identity stays read
  });

  it("passes with a valid staging-DB relk token (token bridge)", async () => {
    const token = await seed(["read"], { id: "tok_stg" });
    const r = await resolveMcpAuth(req({ Authorization: `Bearer ${token}` }), staging());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity).toMatchObject({ kind: "token", tokenId: "tok_stg" });
  });

  it("lets OPTIONS through the gate (CORS preflight)", async () => {
    const r = await resolveMcpAuth(
      new Request("https://mcp.releases.sh/mcp", { method: "OPTIONS" }),
      staging(),
    );
    expect(r.ok).toBe(true);
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `bun test tests/unit/mcp-auth.test.ts`
Expected: FAIL — `Cannot find module ".../workers/mcp/src/auth.js"` / `resolveMcpAuth is not a function`.

- [ ] **Step 4: Implement `workers/mcp/src/auth.ts`**

```ts
import { getSecret } from "@releases/lib/secrets";
import { isApiTokenShaped } from "@buildinternet/releases-core/api-token";
import { verifyApiToken } from "@releases/core-internal/api-token-store";
import { createDb } from "./db.js";
import type { Env } from "./mcp-agent.js";

/** Custom header carrying the staging shared secret. Mirrors workers/api. */
const STAGING_KEY_HEADER = "X-Releases-Staging-Key";

/**
 * Resolved caller identity, attached to the MCP server per request. Mirrors the
 * API worker's AuthContext, plus the raw `token` so the lookup fallback can
 * forward the caller's own credential instead of borrowing the root key.
 */
export type McpIdentity =
  | { kind: "root"; scopes: string[]; tokenId: null; token: null }
  | { kind: "token"; scopes: string[]; tokenId: string; token: string }
  | { kind: "anonymous"; scopes: string[]; tokenId: null; token: null };

export type McpAuthResult = { ok: false; response: Response } | { ok: true; identity: McpIdentity };

const ANONYMOUS: McpIdentity = { kind: "anonymous", scopes: ["read"], tokenId: null, token: null };

function bearer(request: Request): string {
  const header = request.headers.get("Authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

/**
 * Resolve a presented credential to an identity. `relk_…` Bearer → DB-token
 * path (verified against D1); the static RELEASED_API_KEY → root; anything else
 * (including an invalid/unknown relk token) → anonymous read. No credential is
 * eligible for both paths.
 */
async function resolveIdentity(request: Request, env: Env): Promise<McpIdentity> {
  const presented = bearer(request);
  if (presented && isApiTokenShaped(presented)) {
    if (env.API_TOKENS_DISABLED === "true") return ANONYMOUS;
    const res = await verifyApiToken(createDb(env.DB), presented);
    if (res.ok)
      return { kind: "token", scopes: res.scopes, tokenId: res.tokenId, token: presented };
    return ANONYMOUS; // invalid token is ignored — reads stay public, like the API worker
  }
  const rootKey = await getSecret(env.RELEASED_API_KEY).catch(() => null);
  if (rootKey && presented && presented === rootKey) {
    return { kind: "root", scopes: ["*"], tokenId: null, token: null };
  }
  return ANONYMOUS;
}

function unauthorized(): Response {
  return new Response(
    JSON.stringify({ error: "unauthorized", message: "Missing or invalid staging access key" }),
    { status: 401, headers: { "Content-Type": "application/json" } },
  );
}

/**
 * Resolve identity and enforce the staging access gate. In prod (no
 * STAGING_ACCESS_KEY bound) the gate is skipped and identity flows through. In
 * staging the gate accepts: the `X-Releases-Staging-Key` header, a Bearer
 * staging-key, a valid staging-DB relk token, or the static root key — so a
 * managed agent can authenticate with a Bearer token instead of the shared key.
 */
export async function resolveMcpAuth(request: Request, env: Env): Promise<McpAuthResult> {
  const identity = await resolveIdentity(request, env);

  if (env.STAGING_ACCESS_KEY && request.method !== "OPTIONS") {
    const stagingSecret = await getSecret(env.STAGING_ACCESS_KEY).catch(() => null);
    if (stagingSecret) {
      const passes =
        request.headers.get(STAGING_KEY_HEADER) === stagingSecret ||
        bearer(request) === stagingSecret ||
        identity.kind === "token" ||
        identity.kind === "root";
      if (!passes) return { ok: false, response: unauthorized() };
    }
  }

  return { ok: true, identity };
}
```

- [ ] **Step 5: Run the test to confirm it passes**

Run: `bun test tests/unit/mcp-auth.test.ts`
Expected: PASS (all 11 cases).

- [ ] **Step 6: Commit**

```bash
git add workers/mcp/src/auth.ts workers/mcp/src/mcp-agent.ts tests/unit/mcp-auth.test.ts
git commit -m "feat(mcp): boundary auth resolution + staging-gate token bridge"
```

---

## Task 3: Per-tool scope enforcement + confused-deputy fix (`mcp-agent.ts`)

**Files:**

- Modify: `workers/mcp/src/tools.ts` (add `isError?` to `ToolResult`)
- Modify: `workers/mcp/src/mcp-agent.ts`
- Test: `tests/unit/mcp-scope-enforcement.test.ts`, update `tests/unit/mcp-lookup-gate.test.ts`

- [ ] **Step 1: Add `isError` to `ToolResult`** (`workers/mcp/src/tools.ts`, inside the `ToolResult` type after `structuredContent`):

```ts
  /** Set true to signal a tool-level failure (e.g. insufficient scope) without
   * a protocol error — the host surfaces the text to the model. */
  isError?: boolean;
```

- [ ] **Step 2: Write the failing test** `tests/unit/mcp-scope-enforcement.test.ts`

```ts
import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { Database } from "bun:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer, type Env } from "../../workers/mcp/src/mcp-agent.js";
import { applyMigrations, makeD1Shim } from "../db-helper.js";

let sqlite: Database;
beforeAll(() => {
  sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys=ON");
  applyMigrations(sqlite);
});
afterAll(() => sqlite.close());

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: makeD1Shim(sqlite),
    ANTHROPIC_API_KEY: { get: async () => "" },
    RELEASES_INDEX: {} as Env["RELEASES_INDEX"],
    ENTITIES_INDEX: {} as Env["ENTITIES_INDEX"],
    CHANGELOG_CHUNKS_INDEX: {} as Env["CHANGELOG_CHUNKS_INDEX"],
    SEARCH_QUERY_LOG_DISABLED: "true",
    ...overrides,
  } as unknown as Env;
}

async function callTool(
  env: Env,
  opts: { authScopes?: string[]; authToken?: string | null },
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError?: boolean; content: Array<{ type: string; text?: string }> }> {
  const server = createServer(env, undefined, opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const res = (await client.callTool({ name, arguments: args })) as {
    isError?: boolean;
    content: Array<{ type: string; text?: string }>;
  };
  await client.close();
  return res;
}

describe("MCP scope enforcement", () => {
  it("read tools work for an anonymous (default read) caller", async () => {
    const res = await callTool(makeEnv(), {}, "list_organizations", {});
    expect(res.isError).toBeFalsy();
  });

  it("AI tools reject a read-only caller with insufficient_scope", async () => {
    const env = makeEnv({ ENABLE_AI_TOOLS: "true" });
    const res = await callTool(env, { authScopes: ["read"] }, "summarize_changes", {
      product: "vercel/next-js",
    });
    expect(res.isError).toBe(true);
    expect(res.content[0]?.text ?? "").toContain("insufficient_scope");
  });

  it("AI tools do NOT short-circuit on scope for a write caller (gets past the guard)", async () => {
    // With write scope the guard passes; the handler then runs and fails on the
    // empty Anthropic key / missing product — the point is it is NOT the scope
    // error, proving the guard let it through.
    const env = makeEnv({ ENABLE_AI_TOOLS: "true" });
    const res = await callTool(env, { authScopes: ["write"] }, "summarize_changes", {
      product: "vercel/next-js",
    });
    const text = res.content[0]?.text ?? "";
    expect(text).not.toContain("insufficient_scope");
  });
});
```

- [ ] **Step 3: Run it to confirm it fails**

Run: `bun test tests/unit/mcp-scope-enforcement.test.ts`
Expected: FAIL — AI tool returns its normal (non-scope) output for a read caller because no guard exists yet.

- [ ] **Step 4: Implement the scope wrapper + guards in `mcp-agent.ts`**

4a. Add imports at the top (extend the existing `@buildinternet/releases-core/api-token` import — there is none yet, add a new line near the other core imports):

```ts
import { scopeSatisfies, type ApiScope } from "@buildinternet/releases-core/api-token";
```

4b. Extend `CreateServerOptions`:

```ts
  /** Caller scopes resolved at the HTTP boundary (workers/mcp/src/auth.ts).
   * Defaults to ["read"] — anonymous public reads. */
  authScopes?: string[];
  /** Raw `relk_…` token of the caller, forwarded to the API on the on-demand
   * lookup so the privileged indexer runs as the caller, not as root. */
  authToken?: string | null;
```

4c. Near the top of `createServer`, after `const db = createDb(env.DB);`:

```ts
const authScopes = opts?.authScopes ?? ["read"];
const authToken = opts?.authToken ?? null;

/** Tool-level scope failure surfaced to the model (not a protocol error). */
function scopeError(required: ApiScope): ToolResult {
  return {
    content: [
      {
        type: "text",
        text: `insufficient_scope: this MCP tool requires a '${required}'-scoped API token. Present one via Authorization: Bearer relk_…`,
      },
    ],
    isError: true,
  };
}

/** Wrap a tool handler so it returns a scope error unless the caller's scopes
 * satisfy `required`. Outermost wrapper — runs before any DB/AI work. */
function requireScope<T>(
  required: ApiScope,
  handler: (params: T) => Promise<ToolResult>,
): (params: T) => Promise<ToolResult> {
  return async (params: T) =>
    scopeSatisfies(authScopes, required) ? handler(params) : scopeError(required);
}
```

4d. Gate the two AI tools — wrap their existing `withMedia(...)` handlers with `requireScope("write", …)`:

```ts
      requireScope(
        "write",
        withMedia(async (params) => {
          const anthropic = await getAnthropic();
          return summarizeChanges(db, params, anthropic);
        }),
      ),
```

```ts
      requireScope(
        "write",
        withMedia(async (params) => {
          const anthropic = await getAnthropic();
          return compareProducts(db, params, anthropic);
        }),
      ),
```

4e. Rewrite `maybeLookup` (replace the header-building block) so it gates on `write` and forwards the caller's token:

```ts
async function maybeLookup(out: SearchToolReturn, query: string): Promise<void> {
  if (!env.API) return;
  const coord = parseCoordinate(query);
  if (!coord) return;
  // Confused-deputy fix (scoped API tokens, Phase 2): the on-demand indexer
  // is a write. Only fire it when the caller carries `write`, and forward the
  // caller's OWN credential — never lend the static root key to an
  // unauthenticated/under-scoped MCP client. A static-root caller (authToken
  // null, scopes ["*"]) forwards the root key, which is root acting as root.
  if (!scopeSatisfies(authScopes, "write")) return;
  const forwardToken = authToken ?? (await getSecret(env.RELEASED_API_KEY).catch(() => null)) ?? "";
  if (!forwardToken) return;
  try {
    const headers: Record<string, string> = {
      "content-type": "application/json",
      Authorization: `Bearer ${forwardToken}`,
    };
    // Service-binding requests still flow through the API worker's middleware
    // pipeline, which includes the staging access gate. Attach the staging
    // key when bound (no-op in prod/local where the binding is absent).
    const stagingKey = (await getSecret(env.STAGING_ACCESS_KEY).catch(() => null)) ?? "";
    if (stagingKey) headers["X-Releases-Staging-Key"] = stagingKey;
    const res = await env.API.fetch(
      new Request("https://internal/v1/lookups", {
        method: "POST",
        headers,
        body: JSON.stringify({
          provider: coord.provider,
          coordinate: `${coord.org}/${coord.repo}`,
        }),
      }),
    );
    if (!res.ok) {
      logEvent("error", {
        component: "mcp-lookup",
        event: "fallback-non-ok",
        httpStatus: res.status,
      });
      return;
    }
    const lookup = (await res.json()) as LookupResultPayload;
    const rail = renderLookupRail(lookup);
    const block = out.result.content[0];
    if (rail && block?.type === "text") {
      block.text = block.text ? `${block.text}\n\n${rail}` : rail;
    }
  } catch (err) {
    logEvent("error", { component: "mcp-lookup", event: "fallback-failed", err });
  }
}
```

- [ ] **Step 5: Run the scope test to confirm it passes**

Run: `bun test tests/unit/mcp-scope-enforcement.test.ts`
Expected: PASS.

- [ ] **Step 6: Update `tests/unit/mcp-lookup-gate.test.ts`** — the lookup is now write-gated, so callers must present write scope; assert the forwarded credential is the caller's token, not root.

Replace the stub builder + `callSearchTool` so headers are captured and a write token is threaded:

```ts
// Capture both URL and forwarded Authorization to prove the confused-deputy fix.
function buildStubApi(calls: Array<{ url: string; auth: string | null }>): Env["API"] {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const request = input instanceof Request ? input : new Request(input as RequestInfo | URL);
      calls.push({ url: request.url, auth: request.headers.get("Authorization") });
      return new Response(JSON.stringify(STUB_LOOKUP), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  } as unknown as Env["API"];
}

async function callSearchTool(
  env: Env,
  toolName: "search",
  query: string,
  opts: { authScopes?: string[]; authToken?: string | null } = {},
): Promise<unknown> {
  const server = createServer(env, undefined, opts);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const result = await client.callTool({ name: toolName, arguments: { query } });
  await client.close();
  return result;
}
```

Update the existing positive case to pass a write token + assert forwarded auth, and add a read-skip case:

```ts
describe("search tool", () => {
  const WRITE_OPTS = {
    authScopes: ["write"],
    authToken: "relk_clienttoken00_clientsecret0000000000000000",
  };

  it("fires the lookup for a write caller and forwards the caller's token (not root)", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    const result = await callSearchTool(makeEnv(calls), "search", "acme/some-sdk", WRITE_OPTS);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/v1/lookups");
    expect(calls[0].auth).toBe(`Bearer ${WRITE_OPTS.authToken}`);
    const text = firstText(result);
    expect(text).toContain("On-demand lookup");
    expect(text).toContain("Repo not found on GitHub");
  });

  it("does NOT fire the lookup for an anonymous/read caller (confused-deputy closed)", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    await callSearchTool(makeEnv(calls), "search", "acme/some-sdk"); // default read scope
    expect(calls.length).toBe(0);
  });

  it("does NOT call API.fetch when query is not a coordinate", async () => {
    const calls: Array<{ url: string; auth: string | null }> = [];
    await callSearchTool(makeEnv(calls), "search", "some plain query", WRITE_OPTS);
    expect(calls.length).toBe(0);
  });

  it("does NOT call API.fetch when API binding is absent", async () => {
    const env = makeEnv([]);
    delete (env as Partial<Env>).API;
    await expect(callSearchTool(env, "search", "acme/some-sdk", WRITE_OPTS)).resolves.toBeDefined();
  });
});
```

Note: `makeEnv` currently takes `apiCalls: string[]` — update its signature to `Array<{ url: string; auth: string | null }>` and pass it to `buildStubApi`. The `delete API` case can pass `[]`.

- [ ] **Step 7: Run the lookup-gate test to confirm it passes**

Run: `bun test tests/unit/mcp-lookup-gate.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add workers/mcp/src/tools.ts workers/mcp/src/mcp-agent.ts tests/unit/mcp-scope-enforcement.test.ts tests/unit/mcp-lookup-gate.test.ts
git commit -m "feat(mcp): scope-gate write/AI tools + forward caller token on lookup (confused-deputy fix)"
```

---

## Task 4: Wire the boundary into `index.ts`

**Files:**

- Modify: `workers/mcp/src/index.ts`

- [ ] **Step 1: Replace `checkStagingKey` with `resolveMcpAuth`.** New `index.ts` top + `handle`:

```ts
import { createMcpHandler } from "agents/mcp";
import { isHtmlRequest, renderLandingPage } from "./landing.js";
import { createServer, type Env } from "./mcp-agent.js";
import { resolveMcpAuth } from "./auth.js";
import { touchLastUsed } from "@releases/core-internal/api-token-store";
import { createDb } from "./db.js";

async function handle(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const url = new URL(request.url);
  const noIndex = env.INDEXING_DISABLED === "true";

  if (noIndex && request.method === "GET" && url.pathname === "/robots.txt") {
    return new Response("User-agent: *\nDisallow: /\n", {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  }

  // Resolve the caller's identity (relk_ token → scopes, static key → root,
  // else anonymous read) and enforce the staging access gate in one pass.
  const auth = await resolveMcpAuth(request, env);
  if (!auth.ok) return auth.response;
  const { identity } = auth;
  // Record token usage (throttled, fire-and-forget) so the admin surface can
  // audit last-used across both workers.
  if (identity.kind === "token") {
    ctx.waitUntil(touchLastUsed(createDb(env.DB), identity.tokenId).catch(() => undefined));
  }

  if (url.pathname === "/" && request.method === "GET") {
    if (isHtmlRequest(request)) {
      const isLocal = url.hostname === "localhost" || url.hostname === "127.0.0.1";
      const scheme = isLocal ? url.protocol.replace(":", "") : "https";
      const mcpUrl = `${scheme}://${url.host}/mcp`;
      return new Response(renderLandingPage(mcpUrl), {
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "public, max-age=300",
        },
      });
    }
    return Response.json({
      name: "Releases MCP Server",
      description: "Changelog registry — search releases, compare products, and get AI summaries",
      mcp_endpoint: "/mcp",
    });
  }

  const server = createServer(env, ctx, {
    userAgent: request.headers.get("user-agent"),
    authScopes: identity.scopes,
    authToken: identity.token,
  });
  return createMcpHandler(server)(request, env, ctx);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext) {
    const response = await handle(request, env, ctx);
    if (env.INDEXING_DISABLED !== "true") return response;
    const tagged = new Response(response.body, response);
    tagged.headers.set("X-Robots-Tag", "noindex, nofollow");
    return tagged;
  },
} satisfies ExportedHandler<Env>;
```

(Delete the now-unused `STAGING_KEY_HEADER`, `checkStagingKey`, and `getSecret` import — all moved to `auth.ts`.)

- [ ] **Step 2: MCP worker type-check + bundle resolution check**

Run: `cd workers/mcp && npx tsc --noEmit`
Expected: clean.

Run: `cd workers/mcp && npx wrangler deploy --dry-run --outdir /tmp/mcp-dryrun`
Expected: bundles successfully — proves `@releases/core-internal/api-token-store` resolves through the workspace symlink at build time (not just tsc paths). If it fails to resolve, fall back to a relative import `../../packages/core-internal/src/api-token-store.ts` consistent with the wrangler `@releases → ../../src` alias, or add an `alias` entry; re-run.

- [ ] **Step 3: Commit**

```bash
git add workers/mcp/src/index.ts
git commit -m "feat(mcp): enforce token auth at the request boundary, thread scopes into tools"
```

---

## Task 5: Docs + full gate

**Files:**

- Modify: `AGENTS.md` (scoped-tokens line), `docs/architecture/mcp.md`

- [ ] **Step 1: Update `AGENTS.md`** — replace the trailing `MCP enforcement is Phase 2.` in the scoped-API-tokens bullet with:

```md
MCP enforcement (Phase 2, shipped): the MCP worker resolves the caller's `relk_` token at the request boundary via the shared `@releases/core-internal/api-token-store`, derives scopes, and gates write/AI tools + the on-demand `/v1/lookups` fallback on `write`. The lookup forwards the caller's own token (a static-root caller forwards root) instead of borrowing the root key — closing the confused deputy. Anonymous MCP reads stay open (implicit `read`); `API_TOKENS_DISABLED` rolls the token path back. In staging a valid relk token also satisfies the access gate.
```

- [ ] **Step 2: Add an MCP-auth section to `docs/architecture/mcp.md`** documenting: boundary resolution, the per-tool scope map (read tools open, AI tools + lookup require write), the confused-deputy fix, the staging-gate token bridge, and `API_TOKENS_DISABLED`. (Match the doc's existing heading style.)

- [ ] **Step 3: Run the full gate**

Run: `bun test`
Expected: PASS (all suites, including the three MCP unit tests and the unchanged API token tests).

Run: `bun run lint`
Expected: clean.

Run: `bun run format:check`
Expected: clean (run `bun run format` if it flags the new files, then re-check).

Run: `npx tsc --noEmit` (root) and `cd workers/api && npx tsc --noEmit` and `cd workers/mcp && npx tsc --noEmit`
Expected: all clean.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md docs/architecture/mcp.md
git commit -m "docs: MCP scope enforcement (scoped API tokens Phase 2)"
```

---

## Task 6: Staging deploy + smoke

- [ ] **Step 1: Deploy MCP to staging**

```bash
bunx wrangler deploy --env staging --config workers/mcp/wrangler.jsonc
```

- [ ] **Step 2: Smoke — read tool with the staging key alone (anonymous read still works through the gate)**, then mint a staging `write` token via the API and confirm a coordinate search fires the lookup, while a `read` token does not. (Use `mcp-staging.releases.sh`; staging mints tokens against `released-db-staging` via `POST /v1/tokens` with the staging access key + a root/admin credential.)

Expected: read tools return data with just the staging key; coordinate search with a `write` token appends the on-demand lookup rail; with a `read` token it does not.

- [ ] **Step 3: Report results.** If green, the change is ready for a prod PR (no new migration — `api_tokens` is already applied to prod + staging).

---

## Self-Review

- **Spec coverage:** Deliverable 1 (authenticate by relk token, derive scopes, per-tool gate, behind `API_TOKENS_DISABLED`) → Tasks 2–4. Deliverable 2 (confused deputy) → Task 3 `maybeLookup`. Shared verify module → Task 1. Bearer-shape disambiguation → `resolveIdentity`. Staging managed-agent flow preserved + token bridge → Task 2 staging gate + tests. Uniform-failure property → inherited unchanged from the shared `verifyApiToken` (the API token tests in Task 1 still assert it). `last_used_at` throttle reuse → Task 4 `touchLastUsed` via `waitUntil`.
- **Placeholder scan:** none — every code step carries full source.
- **Type consistency:** `McpIdentity.token` (raw string | null) feeds `CreateServerOptions.authToken` feeds `maybeLookup`'s `forwardToken`. `authScopes: string[]` feeds `scopeSatisfies(authScopes, required)`. `ToolResult.isError?` is consumed by the MCP client in both new tests. `verifyApiToken(db: DrizzleD1Database<any>)` accepts the API worker's `D1Db`, the MCP `createDb` handle, and the bun:sqlite test handle.
- **Risk noted:** Task 4 Step 2 explicitly verifies the core-internal import resolves under wrangler's bundler (not only tsc), with a fallback.
