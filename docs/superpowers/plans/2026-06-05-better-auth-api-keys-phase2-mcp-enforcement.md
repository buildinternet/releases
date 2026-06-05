# Better Auth API Keys — Phase 2 (MCP Enforcement) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `relu_` user keys work through the remote MCP server, metered exactly once per billable tool call, mirroring the REST API.

**Architecture:** The MCP worker authenticates a presented `relu_` key against the API worker's existing `GET /v1/tokens/me` over the `env.API` service binding; the API worker's existing auth middleware verifies + meters it once as a side effect, and returns the resolved scopes. Metering is gated on a JSON-RPC method peek at the single MCP auth boundary (`resolveMcpAuth`) so protocol overhead (`initialize`/`tools/list`/…) is never charged. The lone forwarding path (`search` → `maybeLookup` → `/v1/lookups`) is neutralized by carrying `token: null` on user-key identities, which routes its forward through the root key (no second meter). The MCP worker never instantiates Better Auth.

**Tech Stack:** TypeScript (strict), Bun test, Cloudflare Workers (Hono on the API side, `createMcpHandler` on the MCP side), Better Auth `@better-auth/api-key` (API worker only), D1 + Drizzle.

**Spec:** [`2026-06-05-better-auth-api-keys-phase2-mcp-design.md`](../specs/2026-06-05-better-auth-api-keys-phase2-mcp-design.md)

---

## File Structure

**API worker**

- Modify `workers/api/src/routes/api-tokens.ts` — `GET /tokens/me` handler gains a `relu_` (user-key-shaped `tokenId`) branch returning scopes from the resolved auth context. Add `isUserApiKeyShaped` to the existing core import. (Task 1)

**MCP worker**

- Modify `workers/mcp/src/mcp-agent.ts` — add `USER_API_KEYS_ENABLED?: string` to `Env`. (Task 2)
- Modify `workers/mcp/wrangler.jsonc` — add `"USER_API_KEYS_ENABLED": "false"` to the prod and staging `vars` blocks. (Task 2)
- Modify `workers/mcp/src/auth.ts` — add `isMeteredMcpMethod` (exported), the `relu_` resolution branch (`resolveUserKey` → `/v1/tokens/me`), widen `McpIdentity` token variant to `token: string | null`, add `machineTokenIdForUsage` (exported), a `rateLimited()` 429 response, and thread `metered` through `resolveIdentity`/`resolveMcpAuth`. (Tasks 3, 4, 5)
- Modify `workers/mcp/src/index.ts` — use `machineTokenIdForUsage` to skip `touchLastUsed` for `relu_` keys. (Task 4)

**Docs**

- Modify `docs/architecture/mcp.md` — document `relu_` MCP enforcement + the meter-once invariant. (Task 7)

**Tests** (all under the repo-root `tests/` tree; MCP worker has no in-tree tests)

- `tests/api/api-tokens-route.test.ts` — `/tokens/me` `relu_` branch. (Task 1)
- `tests/unit/mcp-auth.test.ts` — `isMeteredMcpMethod`, `machineTokenIdForUsage`, `relu_` resolution. (Tasks 3, 4, 5)
- `tests/unit/mcp-lookup-gate.test.ts` — `maybeLookup` no-double-meter regression. (Task 6)

---

## Task 1: API worker — `GET /v1/tokens/me` returns scopes for `relu_` identities

Closes the known Phase-1 gap (a valid `relu_` key 401s on `/tokens/me` because the handler queries the `api_tokens` machine lane). A `relu_` identity arrives as `{ kind: "token", tokenId: "relu_<keyId>", scopes }` (set by the API middleware's `resolveAuthUncached`); the handler must return its scopes without a DB lookup.

**Files:**

- Modify: `workers/api/src/routes/api-tokens.ts` (import line ~5-13; handler at `workers/api/src/routes/api-tokens.ts:119-160`)
- Test: `tests/api/api-tokens-route.test.ts` (inside the existing `describe("GET /v1/tokens/me")` block)

- [ ] **Step 1: Write the failing test**

Add this `it(...)` inside the existing `describe("GET /v1/tokens/me", ...)` block in `tests/api/api-tokens-route.test.ts` (it reuses the `callAs` helper already defined in that block):

```ts
it("returns scopes for a relu_ user-key identity without a DB lookup (no 401)", async () => {
  h = createTestDb();
  // A relu_ identity has no api_tokens row; the handler must NOT 401 on it.
  const res = await callAs(h.db, {
    kind: "token",
    tokenId: "relu_someUserKeyId",
    scopes: ["read", "write"],
  })("/tokens/me");
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    kind: string;
    scopes: string[];
    principalType: string;
  };
  expect(body.kind).toBe("token");
  expect(body.scopes).toEqual(["read", "write"]);
  expect(body.principalType).toBe("user");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/api/api-tokens-route.test.ts -t "relu_ user-key identity"`
Expected: FAIL — the response is `401` (handler queries `apiTokens` by `id = "relu_someUserKeyId"`, finds no row, returns 401).

- [ ] **Step 3: Add the import**

In `workers/api/src/routes/api-tokens.ts`, add `isUserApiKeyShaped` to the existing `@buildinternet/releases-core/api-token` import. The block currently reads:

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
```

Change it to:

```ts
import {
  API_SCOPES,
  generateApiToken,
  hashSecret,
  isApiScope,
  isUserApiKeyShaped,
  parseStoredScopes,
  PRINCIPAL_TYPES,
  ROOT_SCOPE,
  type PrincipalType,
} from "@buildinternet/releases-core/api-token";
```

- [ ] **Step 4: Add the `relu_` branch to the handler**

In the `GET /tokens/me` handler, insert the `relu_` branch immediately after the `auth.kind === "root"` block closes and before `const db = createDb(c.env.DB);`. The surrounding code is:

```ts
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
```

Insert between the closing `}` of the root branch and `const db`:

```ts
// User API keys (relu_) live in Better Auth's `apikey` table, not `api_tokens`.
// The middleware already verified + metered the key and resolved its scopes;
// return them directly (no `api_tokens` row exists, so the query below would
// 401). Richer fields (name, remaining, userId) are a Phase 3 enrichment.
if (isUserApiKeyShaped(auth.tokenId)) {
  return c.json({
    kind: "token",
    name: "user-api-key",
    scopes: auth.scopes,
    principalType: "user",
    principalId: null,
    expiresAt: null,
    lastUsedAt: null,
  } satisfies TokenIdentity);
}
```

(`TokenIdentity.name` is typed `string`, so use the literal `"user-api-key"`, not `null`. `kind: "token"` and `principalType: "user"` are already members of the published `TokenIdentity` union — no `@buildinternet/releases-api-types` change is required.)

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test tests/api/api-tokens-route.test.ts -t "relu_ user-key identity"`
Expected: PASS.

- [ ] **Step 6: Run the full route test file (regression)**

Run: `bun test tests/api/api-tokens-route.test.ts`
Expected: PASS (existing root / relk* / 401-on-missing-row tests still green — the `relu*`branch precedes the DB query and only matches`relu\_`-shaped tokenIds).

- [ ] **Step 7: Commit**

```bash
git add workers/api/src/routes/api-tokens.ts tests/api/api-tokens-route.test.ts
git commit -m "feat(auth): /v1/tokens/me returns scopes for relu_ user keys"
```

---

## Task 2: MCP worker — add the `USER_API_KEYS_ENABLED` binding + wrangler vars

Plumbing for the flag the `relu_` branch (Task 5) reads. No behavior yet; verified by type-check. The flag falls back to the wrangler var (`"false"`) when Flagship has no key, so this is inert.

**Files:**

- Modify: `workers/mcp/src/mcp-agent.ts` (the `Env` interface, near `API_TOKENS_DISABLED?: string;`)
- Modify: `workers/mcp/wrangler.jsonc` (prod `vars` block ~line 23; `[env.staging]` `vars` block ~line 102)

- [ ] **Step 1: Add the Env field**

In `workers/mcp/src/mcp-agent.ts`, the `Env` interface has:

```ts
  /**
   * Kill switch for the `relk_` token path — mirrors the API worker. When
   * "true", `relk_` tokens are not verified (treated as anonymous read) so the
   * server falls back to staging-key / root-key auth only. Rollback lever.
   */
  API_TOKENS_DISABLED?: string;
```

Add directly below it:

```ts
  /**
   * Rollout gate for the Better Auth user-API-key (`relu_`) path — mirrors the
   * API worker. When not "true", presented `relu_` keys resolve to anonymous
   * read (the path is inert). Flip on in BOTH Flagship apps at Phase 3 rollout.
   */
  USER_API_KEYS_ENABLED?: string;
```

- [ ] **Step 2: Add the prod wrangler var**

In `workers/mcp/wrangler.jsonc`, the prod `vars` block currently begins:

```jsonc
  "vars": {
    "ENABLE_AI_TOOLS": "false",
    "MEDIA_ORIGIN": "https://media.releases.sh",
```

Add the var (keep the existing entries):

```jsonc
  "vars": {
    "ENABLE_AI_TOOLS": "false",
    "USER_API_KEYS_ENABLED": "false",
    "MEDIA_ORIGIN": "https://media.releases.sh",
```

- [ ] **Step 3: Add the staging wrangler var**

In the `[env.staging]` `vars` block of `workers/mcp/wrangler.jsonc`:

```jsonc
      "vars": {
        "ENABLE_AI_TOOLS": "false",
        "MEDIA_ORIGIN": "https://media.releases.sh",
```

Add the var:

```jsonc
      "vars": {
        "ENABLE_AI_TOOLS": "false",
        "USER_API_KEYS_ENABLED": "false",
        "MEDIA_ORIGIN": "https://media.releases.sh",
```

- [ ] **Step 4: Type-check the MCP worker**

Run: `npx tsc --noEmit -p workers/mcp`
Expected: PASS (no errors; the new optional field compiles).

- [ ] **Step 5: Validate the wrangler config parses**

Run: `bunx wrangler deploy --dry-run --config workers/mcp/wrangler.jsonc 2>&1 | tail -8`
Expected: wrangler reads + parses the JSONC (binding/upload summary). A malformed JSONC edit surfaces as an early config/parse error naming `wrangler.jsonc`; an auth or network error that appears _after_ config parsing is acceptable in this environment and still confirms the edit is well-formed (wrangler parses the config before authenticating). Do not add a hand-rolled JSON parse step — naive comment-stripping corrupts the `https://` URLs in this file.

- [ ] **Step 6: Commit**

```bash
git add workers/mcp/src/mcp-agent.ts workers/mcp/wrangler.jsonc
git commit -m "chore(mcp): add USER_API_KEYS_ENABLED binding + wrangler vars (default off)"
```

---

## Task 3: MCP worker — `isMeteredMcpMethod` billable-method peek

A pure helper that decides whether an inbound MCP POST should meter a presented `relu_` key, by peeking the JSON-RPC method. Allowlist of non-billable methods; default billable (fail-toward-metering). Cloning the request leaves the original stream intact for `createMcpHandler`.

**Files:**

- Modify: `workers/mcp/src/auth.ts`
- Test: `tests/unit/mcp-auth.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/mcp-auth.test.ts`, change the `auth.js` import to also bring in `isMeteredMcpMethod`:

```ts
import { resolveMcpAuth, isMeteredMcpMethod } from "../../workers/mcp/src/auth.js";
```

Then add this `describe` block at the end of the file:

```ts
describe("isMeteredMcpMethod", () => {
  const post = (body: unknown) =>
    new Request("https://mcp.releases.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });

  it("tools/call ⇒ billable", async () => {
    expect(await isMeteredMcpMethod(post({ jsonrpc: "2.0", id: 1, method: "tools/call" }))).toBe(
      true,
    );
  });

  it("protocol-overhead methods ⇒ not billable", async () => {
    for (const m of [
      "initialize",
      "tools/list",
      "resources/list",
      "resources/templates/list",
      "prompts/list",
      "ping",
      "logging/setLevel",
      "completion/complete",
    ]) {
      expect(await isMeteredMcpMethod(post({ method: m }))).toBe(false);
    }
  });

  it("notifications/* ⇒ not billable", async () => {
    expect(await isMeteredMcpMethod(post({ method: "notifications/initialized" }))).toBe(false);
  });

  it("unknown method ⇒ billable (fail-toward-metering)", async () => {
    expect(await isMeteredMcpMethod(post({ method: "tools/weird" }))).toBe(true);
  });

  it("missing/non-string method ⇒ billable", async () => {
    expect(await isMeteredMcpMethod(post({ id: 1 }))).toBe(true);
  });

  it("unparseable body ⇒ billable", async () => {
    const r = new Request("https://mcp.releases.sh/mcp", { method: "POST", body: "{not json" });
    expect(await isMeteredMcpMethod(r)).toBe(true);
  });

  it("non-POST ⇒ not billable", async () => {
    expect(
      await isMeteredMcpMethod(new Request("https://mcp.releases.sh/mcp", { method: "GET" })),
    ).toBe(false);
  });

  it("batch with any billable entry ⇒ billable", async () => {
    expect(
      await isMeteredMcpMethod(post([{ method: "tools/list" }, { method: "tools/call" }])),
    ).toBe(true);
  });

  it("batch of only overhead ⇒ not billable", async () => {
    expect(await isMeteredMcpMethod(post([{ method: "tools/list" }]))).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/mcp-auth.test.ts -t "isMeteredMcpMethod"`
Expected: FAIL — `isMeteredMcpMethod` is not exported (`import` resolves to `undefined`, calls throw).

- [ ] **Step 3: Implement the helper**

In `workers/mcp/src/auth.ts`, add the following just below the `STAGING_KEY_HEADER` constant (top of the module, after the imports):

```ts
/**
 * JSON-RPC methods that are MCP protocol overhead, not billable operations.
 * A presented relu_ key is NOT metered on these.
 */
const NON_BILLABLE_MCP_METHODS = new Set([
  "initialize",
  "tools/list",
  "resources/list",
  "resources/templates/list",
  "prompts/list",
  "ping",
  "logging/setLevel",
  "completion/complete",
]);

function isBillableMethod(method: unknown): boolean {
  if (typeof method !== "string") return true; // unknown/absent → meter (safe)
  if (method.startsWith("notifications/")) return false; // fire-and-forget
  return !NON_BILLABLE_MCP_METHODS.has(method);
}

/**
 * Decide whether an inbound MCP request should meter a presented relu_ user key.
 * Clones + parses the JSON-RPC body and bills everything except an allowlist of
 * protocol-overhead methods; defaults to billable on parse failure or unknown
 * method (fail-toward-metering). Cloning leaves the ORIGINAL request stream
 * intact for `createMcpHandler` downstream.
 */
export async function isMeteredMcpMethod(request: Request): Promise<boolean> {
  if (request.method !== "POST") return false; // GET = SSE stream, never billable
  try {
    const body = (await request.clone().json()) as unknown;
    if (Array.isArray(body)) {
      return body.some((m) => isBillableMethod((m as { method?: unknown })?.method));
    }
    return isBillableMethod((body as { method?: unknown })?.method);
  } catch {
    return true; // parse failure → meter (safe)
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test tests/unit/mcp-auth.test.ts -t "isMeteredMcpMethod"`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add workers/mcp/src/auth.ts tests/unit/mcp-auth.test.ts
git commit -m "feat(mcp): isMeteredMcpMethod — bill tool calls, not protocol overhead"
```

---

## Task 4: MCP worker — widen `McpIdentity`, add `machineTokenIdForUsage`, skip `touchLastUsed` for `relu_`

User-key identities carry no forwardable credential (`token: null`) and are metered by Better Auth (not the `api_tokens` lane), so `index.ts` must not run the machine-lane `last_used` write for them.

**Files:**

- Modify: `workers/mcp/src/auth.ts` (the `McpIdentity` type; a new exported predicate)
- Modify: `workers/mcp/src/index.ts` (the `touchLastUsed` call at `workers/mcp/src/index.ts:35-37`)
- Test: `tests/unit/mcp-auth.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/mcp-auth.test.ts`, extend the `auth.js` import to add `machineTokenIdForUsage`:

```ts
import {
  resolveMcpAuth,
  isMeteredMcpMethod,
  machineTokenIdForUsage,
} from "../../workers/mcp/src/auth.js";
```

Add this `describe` block at the end of the file:

```ts
describe("machineTokenIdForUsage", () => {
  it("relk_ token ⇒ returns the tokenId (record last_used)", () => {
    expect(
      machineTokenIdForUsage({
        kind: "token",
        scopes: ["read"],
        tokenId: "tok_x",
        token: "relk_x",
      }),
    ).toBe("tok_x");
  });

  it("relu_ user key ⇒ null (metered by Better Auth, no api_tokens row)", () => {
    expect(
      machineTokenIdForUsage({ kind: "token", scopes: ["read"], tokenId: "relu_", token: null }),
    ).toBeNull();
  });

  it("root ⇒ null", () => {
    expect(
      machineTokenIdForUsage({ kind: "root", scopes: ["*"], tokenId: null, token: null }),
    ).toBeNull();
  });

  it("anonymous ⇒ null", () => {
    expect(
      machineTokenIdForUsage({ kind: "anonymous", scopes: ["read"], tokenId: null, token: null }),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/mcp-auth.test.ts -t "machineTokenIdForUsage"`
Expected: FAIL — `machineTokenIdForUsage` is not exported.

- [ ] **Step 3: Widen `McpIdentity` and add the import + predicate**

In `workers/mcp/src/auth.ts`, change the core `api-token` import from:

```ts
import { isApiTokenShaped, ROOT_SCOPE } from "@buildinternet/releases-core/api-token";
```

to:

```ts
import {
  isApiTokenShaped,
  isUserApiKeyShaped,
  ROOT_SCOPE,
  USER_API_KEY_PREFIX,
} from "@buildinternet/releases-core/api-token";
```

Widen the `McpIdentity` `token` variant to allow `null` (user keys carry no forwardable credential):

```ts
export type McpIdentity =
  | { kind: "root"; scopes: string[]; tokenId: null; token: null }
  | { kind: "token"; scopes: string[]; tokenId: string; token: string | null }
  | { kind: "anonymous"; scopes: string[]; tokenId: null; token: null };
```

Add this exported predicate just below the `McpIdentity` type:

```ts
/**
 * The `api_tokens` tokenId whose `last_used_at` should be recorded for this
 * identity, or null when there is nothing to record: root / anonymous have no
 * row, and relu_ user keys are metered by Better Auth's `apikey` table (a
 * machine-lane UPDATE would touch zero rows). Returns the id (not a boolean) so
 * the caller gets a non-null `string` without re-narrowing.
 */
export function machineTokenIdForUsage(identity: McpIdentity): string | null {
  return identity.kind === "token" && !isUserApiKeyShaped(identity.tokenId)
    ? identity.tokenId
    : null;
}
```

- [ ] **Step 4: Update `index.ts` to use the predicate**

In `workers/mcp/src/index.ts`, the current usage-recording block is:

```ts
if (identity.kind === "token") {
  ctx.waitUntil(touchLastUsed(createDb(env.DB), identity.tokenId).catch(() => undefined));
}
```

Replace it with:

```ts
const usageTokenId = machineTokenIdForUsage(identity);
if (usageTokenId) {
  ctx.waitUntil(touchLastUsed(createDb(env.DB), usageTokenId).catch(() => undefined));
}
```

And update the `./auth.js` import in `index.ts` to include the predicate. It currently reads:

```ts
import { resolveMcpAuth } from "./auth.js";
```

Change it to:

```ts
import { resolveMcpAuth, machineTokenIdForUsage } from "./auth.js";
```

- [ ] **Step 5: Run the tests + type-check**

Run: `bun test tests/unit/mcp-auth.test.ts -t "machineTokenIdForUsage"`
Expected: PASS.

Run: `npx tsc --noEmit -p workers/mcp`
Expected: PASS (the widened `token: string | null` is compatible with `CreateServerOptions.authToken?: string | null` and `maybeLookup`'s `authToken ?? rootKey` fallback; `index.ts` no longer passes a possibly-null `tokenId` to `touchLastUsed`).

- [ ] **Step 6: Commit**

```bash
git add workers/mcp/src/auth.ts workers/mcp/src/index.ts tests/unit/mcp-auth.test.ts
git commit -m "feat(mcp): widen McpIdentity for null user-key token; skip last_used for relu_"
```

---

## Task 5: MCP worker — the `relu_` resolution branch (verify + meter via `/v1/tokens/me`)

The core of the phase: a `relu_` Bearer on a billable method is authenticated against the API worker's `GET /v1/tokens/me` over `env.API`, which verifies + meters it once and returns its scopes. Non-billable methods, the flag-off case, an invalid key, and a missing binding all resolve to anonymous; a rate-limited key returns HTTP 429.

**Files:**

- Modify: `workers/mcp/src/auth.ts`
- Test: `tests/unit/mcp-auth.test.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/unit/mcp-auth.test.ts`, add these helpers near the top (after the existing `mockSecret` / `req` / `baseEnv` helpers):

```ts
type MeCall = { url: string; auth: string | null; stagingKey: string | null };

/** Stub the API service binding's /v1/tokens/me response. */
function stubMeApi(calls: MeCall[], response: { status: number; scopes?: string[] }): Env["API"] {
  return {
    fetch: async (input: RequestInfo | URL) => {
      const r = input instanceof Request ? input : new Request(input as RequestInfo | URL);
      calls.push({
        url: r.url,
        auth: r.headers.get("Authorization"),
        stagingKey: r.headers.get("X-Releases-Staging-Key"),
      });
      if (response.status === 429) {
        return new Response(JSON.stringify({ error: "rate_limited" }), { status: 429 });
      }
      if (response.status !== 200) {
        return new Response(JSON.stringify({ error: "unauthorized" }), { status: response.status });
      }
      return new Response(
        JSON.stringify({
          kind: "token",
          name: "user-api-key",
          scopes: response.scopes ?? [],
          principalType: "user",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    },
  } as unknown as Env["API"];
}

/** POST request carrying a single JSON-RPC method (default: a billable tools/call). */
function rpcReq(method: string, headers: Record<string, string> = {}): Request {
  return new Request("https://mcp.releases.sh/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: {} }),
  });
}
```

Then add this `describe` block at the end of the file:

```ts
describe("resolveMcpAuth — relu_ user keys", () => {
  const RELU = "relu_testkey000000000000000000000000";
  const enabled = (api: Env["API"], o: Partial<Env> = {}) =>
    baseEnv({ USER_API_KEYS_ENABLED: "true", API: api, ...o });

  it("billable tool call ⇒ verifies via /v1/tokens/me, meters once, token identity (token=null)", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 200, scopes: ["read", "write"] });
    const r = await resolveMcpAuth(
      rpcReq("tools/call", { Authorization: `Bearer ${RELU}` }),
      enabled(api),
    );
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(r.identity).toEqual({
        kind: "token",
        scopes: ["read", "write"],
        tokenId: "relu_",
        token: null,
      });
    expect(calls.length).toBe(1);
    expect(calls[0].url).toContain("/v1/tokens/me");
    expect(calls[0].auth).toBe(`Bearer ${RELU}`);
  });

  it("non-billable method (tools/list) ⇒ anonymous, NOT metered (no /me call)", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 200, scopes: ["read"] });
    const r = await resolveMcpAuth(
      rpcReq("tools/list", { Authorization: `Bearer ${RELU}` }),
      enabled(api),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
    expect(calls.length).toBe(0);
  });

  it("invalid relu_ (401 from /me) ⇒ anonymous read", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 401 });
    const r = await resolveMcpAuth(
      rpcReq("tools/call", { Authorization: `Bearer ${RELU}` }),
      enabled(api),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
    expect(calls.length).toBe(1);
  });

  it("rate-limited relu_ (429 from /me) ⇒ 429 response", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 429 });
    const r = await resolveMcpAuth(
      rpcReq("tools/call", { Authorization: `Bearer ${RELU}` }),
      enabled(api),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.response.status).toBe(429);
  });

  it("flag off ⇒ relu_ inert (anonymous), no /me call", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 200, scopes: ["read"] });
    const r = await resolveMcpAuth(
      rpcReq("tools/call", { Authorization: `Bearer ${RELU}` }),
      baseEnv({ API: api }), // USER_API_KEYS_ENABLED unset → flag() default false
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
    expect(calls.length).toBe(0);
  });

  it("no API binding ⇒ relu_ resolves anonymous (cannot verify)", async () => {
    const r = await resolveMcpAuth(
      rpcReq("tools/call", { Authorization: `Bearer ${RELU}` }),
      baseEnv({ USER_API_KEYS_ENABLED: "true" }),
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.identity.kind).toBe("anonymous");
  });

  it("forwards the staging key to /me when bound", async () => {
    const calls: MeCall[] = [];
    const api = stubMeApi(calls, { status: 200, scopes: ["read"] });
    const r = await resolveMcpAuth(
      rpcReq("tools/call", {
        Authorization: `Bearer ${RELU}`,
        "X-Releases-Staging-Key": "stg-key",
      }),
      enabled(api, { STAGING_ACCESS_KEY: mockSecret("stg-key") }),
    );
    expect(r.ok).toBe(true);
    expect(calls[0].stagingKey).toBe("stg-key");
  });

  it("method peek leaves the original request body readable for createMcpHandler", async () => {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: {} });
    const request = new Request("https://mcp.releases.sh/mcp", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    await resolveMcpAuth(request, baseEnv());
    expect(await request.text()).toBe(body);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test tests/unit/mcp-auth.test.ts -t "relu_ user keys"`
Expected: FAIL — there is no `relu_` branch yet, so a `relu_` Bearer falls through to anonymous; the "billable tool call" / "429" / staging-forward assertions fail and `calls` stays empty.

- [ ] **Step 3: Add imports (`getSecret` is already imported; add `logEvent`)**

In `workers/mcp/src/auth.ts`, add a `logEvent` import below the existing imports:

```ts
import { logEvent } from "@releases/lib/log-event";
```

(`getSecret`, `getSecretWithFallback`, `isUserApiKeyShaped`, `USER_API_KEY_PREFIX`, `FLAGS`, `flag` are already imported — the last four from Task 4.)

- [ ] **Step 4: Add `resolveUserKey` and a `rateLimited()` response helper**

In `workers/mcp/src/auth.ts`, add the `rateLimited()` helper next to the existing `unauthorized()` helper:

```ts
function rateLimited(): Response {
  return new Response(
    JSON.stringify({ error: "rate_limited", message: "API key rate limit exceeded" }),
    { status: 429, headers: { "Content-Type": "application/json" } },
  );
}
```

Add `resolveUserKey` above `resolveIdentity`:

```ts
/**
 * Verify + meter a relu_ user key by authenticating it against the API worker's
 * `GET /v1/tokens/me` over the service binding. The API worker's existing auth
 * middleware verifies and meters the key exactly once; we read back the resolved
 * scopes. `token` is null on success — there is no forwardable credential, and
 * the null routes maybeLookup's `authToken ?? rootKey` fallback through the root
 * key (no second meter). 429 → rate-limited; any other non-2xx (401) or error →
 * anonymous read (fail-open, matching the relk_ path).
 */
async function resolveUserKey(
  presented: string,
  env: Env,
): Promise<McpIdentity | { rateLimited: true }> {
  if (!env.API) return ANONYMOUS; // no binding (local dev) — cannot verify
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${presented}` };
    const stagingKey = (await getSecret(env.STAGING_ACCESS_KEY).catch(() => null)) ?? "";
    if (stagingKey) headers[STAGING_KEY_HEADER] = stagingKey;
    const res = await env.API.fetch(
      new Request("https://internal/v1/tokens/me", { method: "GET", headers }),
    );
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok) return ANONYMOUS; // 401 invalid/unknown/revoked → public read
    const body = (await res.json()) as { scopes?: unknown };
    const scopes = Array.isArray(body.scopes)
      ? body.scopes.filter((s): s is string => typeof s === "string")
      : [];
    if (scopes.length === 0) return ANONYMOUS; // defensive: empty scope never authenticates
    return { kind: "token", scopes, tokenId: USER_API_KEY_PREFIX, token: null };
  } catch (err) {
    logEvent("warn", {
      component: "mcp-auth",
      event: "user-key-introspect-error",
      message: "relu_ introspection failed; treating as anonymous",
      error: err instanceof Error ? err.message : String(err),
    });
    return ANONYMOUS;
  }
}
```

- [ ] **Step 5: Thread `metered` through `resolveIdentity` and add the `relu_` branch**

Change `resolveIdentity`'s signature and add the `relu_` branch at the top of its body (before the `relk_` `isApiTokenShaped` branch). The full updated function:

```ts
async function resolveIdentity(
  presented: string,
  env: Env,
  metered: boolean,
): Promise<McpIdentity | { rateLimited: true }> {
  if (!presented) return ANONYMOUS;
  if (isUserApiKeyShaped(presented)) {
    if (await flag(env.FLAGS, env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled)) return ANONYMOUS;
    if (!(await flag(env.FLAGS, env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled)))
      return ANONYMOUS;
    if (!metered) return ANONYMOUS; // non-billable method (initialize/list) — don't meter
    return resolveUserKey(presented, env);
  }
  if (isApiTokenShaped(presented)) {
    if (await flag(env.FLAGS, env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled)) return ANONYMOUS;
    const res = await verifyApiToken(createDb(env.DB), presented);
    if (res.ok)
      return { kind: "token", scopes: res.scopes, tokenId: res.tokenId, token: presented };
    // An invalid/unknown token is ignored rather than rejected, so public reads
    // stay open; the staging gate below still applies.
    return ANONYMOUS;
  }
  const rootKey = await getSecretWithFallback(env.RELEASES_API_KEY, env.RELEASED_API_KEY).catch(
    () => null,
  );
  if (rootKey && presented === rootKey) {
    return { kind: "root", scopes: [ROOT_SCOPE], tokenId: null, token: null };
  }
  return ANONYMOUS;
}
```

- [ ] **Step 6: Update `resolveMcpAuth` to compute `metered` and surface 429**

Replace the body of `resolveMcpAuth` (keep the staging-gate block unchanged) so it computes `metered`, calls the new `resolveIdentity` signature, and translates the rate-limited sentinel into a 429:

```ts
export async function resolveMcpAuth(request: Request, env: Env): Promise<McpAuthResult> {
  const presented = bearer(request);
  const metered = await isMeteredMcpMethod(request);
  const resolved = await resolveIdentity(presented, env, metered);
  if ("rateLimited" in resolved) return { ok: false, response: rateLimited() };
  const identity = resolved;

  if (env.STAGING_ACCESS_KEY && request.method !== "OPTIONS") {
    const stagingSecret = await getSecret(env.STAGING_ACCESS_KEY).catch(() => null);
    const passes =
      !stagingSecret ||
      request.headers.get(STAGING_KEY_HEADER) === stagingSecret ||
      presented === stagingSecret ||
      identity.kind === "token" ||
      identity.kind === "root";
    if (!passes) return { ok: false, response: unauthorized() };
  }

  return { ok: true, identity };
}
```

- [ ] **Step 7: Run the new tests + the whole file (regression)**

Run: `bun test tests/unit/mcp-auth.test.ts`
Expected: PASS — the new `relu_` block passes, and the pre-existing identity / staging-gate tests stay green (those use bodyless `req()` POSTs → `isMeteredMcpMethod` returns `true` on the parse-failure path, which the `relk_`/root/anonymous branches ignore).

- [ ] **Step 8: Type-check**

Run: `npx tsc --noEmit -p workers/mcp`
Expected: PASS (the `"rateLimited" in resolved` guard narrows the union; `resolveUserKey`/`resolveIdentity` return types line up).

- [ ] **Step 9: Commit**

```bash
git add workers/mcp/src/auth.ts tests/unit/mcp-auth.test.ts
git commit -m "feat(mcp): meter relu_ user keys once per billable tool call via /v1/tokens/me"
```

---

## Task 6: MCP worker — `maybeLookup` no-double-meter regression test

A `relu_` caller's identity carries `token: null`; `index.ts` passes that as `authToken`, so `maybeLookup`'s `authToken ?? rootKey` fallback forwards the **root** key to `/v1/lookups` — the API worker does not re-meter a user key. This behavior already emerges from Tasks 4-5; this task locks it in with a regression test (no production change).

**Files:**

- Test: `tests/unit/mcp-lookup-gate.test.ts`

- [ ] **Step 1: Write the regression test**

In `tests/unit/mcp-lookup-gate.test.ts`, add this `it(...)` inside the existing `describe("search tool", ...)` block. It reuses the file's `makeEnv` / `callSearchTool` helpers. The env's root key resolves through `RELEASES_API_KEY`, so add it to the env for this case via a local variant:

```ts
it("relu_ caller (authToken=null) forwards the ROOT key, never the user key (no second meter)", async () => {
  const calls: ApiCall[] = [];
  const env = {
    ...makeEnv(calls),
    RELEASES_API_KEY: { get: async () => "root-secret" },
  } as Env;
  // A relu_-metered caller reaches createServer with write scope but token=null
  // (set in workers/mcp/src/auth.ts → resolveUserKey). maybeLookup must fall
  // back to the root key, NOT forward a relu_ key (which the API would meter).
  await callSearchTool(env, "search", "acme/some-sdk", {
    authScopes: ["write"],
    authToken: null,
  });
  expect(calls.length).toBe(1);
  expect(calls[0].url).toContain("/v1/lookups");
  expect(calls[0].auth).toBe("Bearer root-secret");
});
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/unit/mcp-lookup-gate.test.ts -t "forwards the ROOT key"`
Expected: PASS — `authToken: null` triggers the `authToken ?? rootKey` fallback to `"root-secret"`. (This is a guard test for an invariant established in Tasks 4-5; it passes on first run by design.)

- [ ] **Step 3: Run the whole file (regression)**

Run: `bun test tests/unit/mcp-lookup-gate.test.ts`
Expected: PASS (the existing confused-deputy tests — caller forwards its own `relk_`, anonymous doesn't fire — stay green).

- [ ] **Step 4: Commit**

```bash
git add tests/unit/mcp-lookup-gate.test.ts
git commit -m "test(mcp): relu_ lookup forward uses root key, not the user key"
```

---

## Task 7: Docs — document `relu_` MCP enforcement in `docs/architecture/mcp.md`

**Files:**

- Modify: `docs/architecture/mcp.md` (the "Authentication & scope enforcement" section, ~lines 17-41)

- [ ] **Step 1: Add a `relu_` bullet to the identity-resolution list**

In `docs/architecture/mcp.md`, the identity-resolution bullet list reads:

```markdown
- A `relk_…` Bearer is verified against D1 via the shared `verifyApiToken` from `@releases/core-internal/api-token-store` — one verification path for both workers. On success the caller carries the token's scopes; an invalid/unknown `relk_` token is **ignored** (resolves to anonymous read) so public reads never 401, exactly like the API worker's public-read path. Gated by `API_TOKENS_DISABLED`.
- The static `RELEASES_API_KEY` presented as Bearer maps to **root** (`["*"]`).
- Anything else (including no credential) is **anonymous**, carrying an implicit `["read"]` scope.
```

Insert a new bullet immediately after the `relk_` bullet (before the static-`RELEASES_API_KEY` bullet):

```markdown
- A `relu_…` Bearer (Better Auth user key) is verified by authenticating it against the API worker's `GET /v1/tokens/me` over the `API` service binding — the MCP worker never instantiates Better Auth. The API worker's middleware verifies **and meters** the key exactly once and returns its scopes. Metering is gated on a JSON-RPC method peek (`isMeteredMcpMethod`): only billable methods (`tools/call`, and anything not in the protocol-overhead allowlist) trigger the verify; `initialize`/`tools/list`/`ping`/`notifications/*`/etc. resolve to anonymous and are never metered. A `429` from `/v1/tokens/me` surfaces as a `429` from the boundary; an invalid key, an unreachable binding, the flag being off, or any error fail-open to anonymous read. Gated by `user-api-keys-enabled` (and `API_TOKENS_DISABLED`); inert in prod until Phase 3.
```

- [ ] **Step 2: Note the user-key exclusion in the `last_used_at` line**

The line after the resolution list reads:

```markdown
A successful token use records `last_used_at` via `touchLastUsed` (throttled to 60s, fire-and-forget through `waitUntil`) so the admin surface audits usage across both workers.
```

Replace it with:

```markdown
A successful `relk_` token use records `last_used_at` via `touchLastUsed` (throttled to 60s, fire-and-forget through `waitUntil`) so the admin surface audits usage across both workers. `relu_` user keys are metered by Better Auth's `apikey` table instead, so the machine-lane write is skipped for them (`machineTokenIdForUsage`).
```

- [ ] **Step 3: Add the meter-once note to the confused-deputy paragraph**

The confused-deputy paragraph ends:

```markdown
**Behavior change:** on-demand GitHub indexing via the public MCP now requires a `write`-scoped token rather than silently running as root for everyone.
```

Append to that paragraph:

```markdown
For a `relu_` caller the identity carries `token: null`, so `maybeLookup` forwards the **root** key (its `authToken ?? rootKey` fallback) rather than the user key — the inbound tool call is already metered once at the boundary, and forwarding the user key would double-count it at `/v1/lookups`.
```

- [ ] **Step 4: Verify the doc renders (no broken markdown)**

Run: `bun run format:check 2>&1 | grep -i "mcp.md" || echo "ok: mcp.md formatted"`
Expected: `ok: mcp.md formatted` (or the file does not appear in the unformatted list). If it appears, run `bun run format` and re-stage.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/mcp.md
git commit -m "docs(mcp): document relu_ user-key enforcement + meter-once invariant"
```

---

## Task 8: Full verification gate

**Files:** none (verification only)

- [ ] **Step 1: Type-check both workers**

Run: `npx tsc --noEmit -p workers/api && npx tsc --noEmit -p workers/mcp`
Expected: PASS (no errors). This is the gate that catches the flag-gated-plugin typing landmine from Phase 1 — it must stay green.

- [ ] **Step 2: Run the affected test suites**

Run:

```bash
bun test tests/api/api-tokens-route.test.ts tests/unit/mcp-auth.test.ts tests/unit/mcp-lookup-gate.test.ts
```

Expected: PASS (all).

- [ ] **Step 3: Run the broader MCP + API token regression set**

Run:

```bash
bun test tests/unit/mcp-scope-enforcement.test.ts tests/unit/mcp-tool-annotations.test.ts tests/api/user-api-key-auth.test.ts tests/api/api-key-plugin.test.ts tests/api/tokens-me-middleware.test.ts
```

Expected: PASS (Phase 1 behavior and MCP scope enforcement unaffected).

- [ ] **Step 4: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: PASS. If `format:check` flags a touched file, run `bun run format`, re-stage, and amend the relevant commit.

- [ ] **Step 5: Final commit (only if formatting produced changes)**

```bash
git add -A
git commit -m "chore(auth): formatting for Phase 2 MCP enforcement"
```

---

## Self-Review

**1. Spec coverage** — every spec section maps to a task:

- §1 meter-once invariant → Tasks 3 (method gate) + 5 (single verify site) + 6 (no double-meter). ✓
- §2 `GET /v1/tokens/me` introspection touchpoint + handler extension → Task 1; the MCP-side call → Task 5. ✓
- §3.1 `isMeteredMcpMethod` → Task 3. ✓
- §3.2 `relu_` resolution branch + flag gates + `token: null` → Task 5 (flag binding plumbing in Task 2). ✓
- §3.3 `McpIdentity` token widening → Task 4. ✓
- §4 error/fail posture (401→anon, 429, fail-open, flag-off) → Task 5 tests. ✓
- §5 `touchLastUsed` skip → Task 4 (`machineTokenIdForUsage`). ✓
- §6 tool classification → exercised by Task 6 (only `search`/`maybeLookup` is special). ✓
- §7 test matrix → Tasks 1, 3, 4, 5, 6 cover cases 1-8. ✓
- §8 files touched → Tasks 1, 2, 4, 5 (+ docs Task 7). ✓
- §9 rollout (flag off; manual Flagship step non-blocking) → Task 2 ships the var `"false"`; flip is out of scope (Phase 3). ✓

**2. Placeholder scan** — no `TBD`/`TODO`/"handle errors"/"similar to". Every code step shows full code; every run step shows the command + expected result. ✓

**3. Type consistency:**

- `machineTokenIdForUsage(identity: McpIdentity): string | null` — defined in Task 4, consumed in Task 4's `index.ts` edit and tested in Task 4. ✓
- `isMeteredMcpMethod(request: Request): Promise<boolean>` — defined/exported in Task 3, consumed in Task 5's `resolveMcpAuth`. ✓
- `resolveIdentity(presented, env, metered): Promise<McpIdentity | { rateLimited: true }>` and `resolveUserKey(...)` share the same return union; `resolveMcpAuth` narrows via `"rateLimited" in resolved`. ✓
- `McpIdentity` token variant `token: string | null` (Task 4) is compatible with `CreateServerOptions.authToken?: string | null` and `maybeLookup`. ✓
- `TokenIdentity` return in Task 1 uses only existing union members (`kind: "token"`, `principalType: "user"`, `name: string`). ✓
- `tokenId: USER_API_KEY_PREFIX` (the bare `"relu_"` marker) in Task 5 matches `machineTokenIdForUsage`'s `isUserApiKeyShaped` check (Task 4) and the `/tokens/me` 200 assertion in Task 5's first test (`tokenId: "relu_"`). ✓

## Execution Handoff

Plan complete. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks.
2. **Inline Execution** — execute tasks in this session with checkpoints.
