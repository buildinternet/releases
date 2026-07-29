# MCP SDK v2 Migration (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate `workers/mcp` from `@modelcontextprotocol/sdk` v1 to the v2 TypeScript SDK so `mcp.releases.sh` speaks MCP spec `2026-07-28`, while 2025-era clients keep working unchanged.

**Architecture:** `workers/mcp` serves MCP through `agents/mcp` (Cloudflare Agents SDK), which already migrated upstream. In `agents@0.20.1`, `createMcpHandler` is the **stateless v2** handler taking an `McpServerFactory`; the sessionful SDK-v1 handler we use today is renamed `createLegacyMcpHandler`. So the cutover is a dependency bump plus a call-site change, not a transport rewrite. The handler's default `legacy: "stateless"` serves 2025-era `initialize` clients from the same factory, and `responseMode: "json"` preserves today's plain-JSON reply shape.

**Tech Stack:** Cloudflare Workers, `agents@^0.20.1`, `@modelcontextprotocol/server@^2.0.0`, `@modelcontextprotocol/client@^2.0.0`, zod 4, Bun test, Drizzle + D1.

**Spec:** `docs/superpowers/specs/2026-07-29-mcp-sdk-v2-design.md`
**Issue:** [releases#2189](https://github.com/buildinternet/releases/issues/2189)

## Global Constraints

- Every task ends green. Run `bun test tests/ workers/mcp` and `bun run check` before each commit. Husky only lints staged files — tests are not a pre-commit gate, so run them yourself.
- `workers/mcp` is a **carved-out workspace** with its own `bun.lock`, excluded from root workspaces. Any dependency edit there requires `cd workers/mcp && bun install` in the same commit, or CI's `--frozen-lockfile` fails.
- `workers/mcp` type-checks via `npx tsc --noEmit` from `workers/mcp/`, not root oxlint.
- Do **not** add a feature flag. This is a dependency migration with no runtime toggle worth a permanent registry entry.
- Do **not** touch `workers/mcp/ui/` — separate carved-out build, Phase 3.
- Do **not** touch better-auth or anything under `workers/api/src/auth` — Phase 2.
- This repo is **public**: no absolute home-dir paths, no personal emails, no real tokens in any committed file.
- Auth ordering in `workers/mcp/src/index.ts` is a security property and must not change: `resolveMcpAuth` → `enforceMcpRateLimit` → `touchLastUsed` → `peekMcpCall`/`emitMcpConsumption` → handler. Nothing constructs an `McpServer` before `resolveMcpAuth` returns ok.
- Commit messages follow conventional commits, scope `mcp`.

## File Structure

**Modified:**
- `workers/mcp/package.json` — dependency swap
- `workers/mcp/bun.lock` — regenerated
- `workers/mcp/src/index.ts` — handler cutover (lines ~99–104)
- `workers/mcp/src/mcp-agent.ts` — import, `withPagination`, ~11 `inputSchema` sites, cache hints
- `workers/mcp/src/follows-tools.ts` — import, 4 `inputSchema` sites
- `workers/mcp/src/whats-changed-tool.ts` — import, 1 `inputSchema` site
- `workers/mcp/src/resources.ts` — import only (`ResourceTemplate` API unchanged)
- `workers/mcp/src/prompts.ts` — imports, `argsSchema` wrapping
- `workers/mcp/server.json` — version bump
- `tests/mcp-test-helpers.ts` — v2 client
- `tests/unit/mcp-{scope-enforcement,follows-tools,tool-annotations,min-importance-filter,lookup-gate}.test.ts` — v2 client imports
- `docs/architecture/mcp.md` — transport section

**Created:**
- `workers/mcp/test/protocol.test.ts` — era coverage driving the real `index.ts` fetch handler

**Untouched (verify, do not edit):** `workers/mcp/src/{auth,rate-limit,landing,well-known,slug-completion,ui-bundles,tools}.ts`, `workers/mcp/test/{consumption,read-cache,rate-limit,stub-read}.test.ts`.

---

### Task 1: Wrap tool input schemas in `z.object()`

Raw `ZodRawShape` `inputSchema` values are a deprecated overload in v2. SDK **v1.29 already accepts `z.object(...)`** (its `registerTool` takes `ZodRawShapeCompat | AnySchema`), so this lands green on current dependencies and shrinks the cutover task. Note this is **tools only** — v1's `registerPrompt` takes `PromptArgsRawShape` and will reject `z.object`, so prompts wait for Task 5.

**Files:**
- Modify: `workers/mcp/src/mcp-agent.ts` (`withPagination` at :209–211; `inputSchema` at :451, :549, :639, :661, :711, :740, :769, :789, :800, :821, :856)
- Modify: `workers/mcp/src/follows-tools.ts` (:131, :172, :205, :238)
- Modify: `workers/mcp/src/whats-changed-tool.ts` (:226)
- Test: `tests/unit/mcp-tool-annotations.test.ts` (existing, extended)

**Interfaces:**
- Consumes: nothing.
- Produces: `withPagination<T extends z.ZodRawShape>(schema: T): z.ZodObject<T & typeof paginationFields>` — Task 3 and Task 5 rely on this returning an object schema, not a shape.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/mcp-tool-annotations.test.ts`:

```ts
describe("tool input schemas", () => {
  it("advertises an object JSON Schema for a no-argument tool", async () => {
    const tools = await listTools(stubEnv());
    const listFollows = tools.find((t) => t.name === "list_follows");
    expect(listFollows?.inputSchema).toMatchObject({ type: "object" });
  });

  it("advertises pagination fields on a paginated tool", async () => {
    const tools = await listTools(stubEnv());
    const listOrgs = tools.find((t) => t.name === "list_organizations");
    expect(Object.keys(listOrgs?.inputSchema.properties ?? {})).toEqual(
      expect.arrayContaining(["page", "limit"]),
    );
  });
});
```

- [ ] **Step 2: Run it and confirm the baseline**

```bash
bun test tests/unit/mcp-tool-annotations.test.ts
```

Expected: PASS. These assert behavior that must survive the refactor — they are a regression net, not a red-green driver. If either fails now, stop and report: the baseline is not what this plan assumes.

- [ ] **Step 3: Convert `withPagination` to return an object schema**

In `workers/mcp/src/mcp-agent.ts`, replace lines 209–211:

```ts
function withPagination<T extends z.ZodRawShape>(schema: T) {
  return z.object({ ...schema, ...paginationFields });
}
```

- [ ] **Step 4: Wrap every remaining tool `inputSchema`**

At each site listed under **Files**, wrap the object literal:

```ts
// before
inputSchema: {
  query: z.string().describe("Search query"),
  …
},

// after
inputSchema: z.object({
  query: z.string().describe("Search query"),
  …
}),
```

Two special cases:
- `follows-tools.ts:205` is `inputSchema: {}` — **delete the property entirely** rather than writing `z.object({})`. v2 treats an absent `inputSchema` as the no-argument case.
- `mcp-agent.ts:789` is `inputSchema: withPagination({})` — leave as-is; `withPagination` now returns the object schema.

Do not change any tool callback body. Parameter destructuring keeps working because the inferred argument type is unchanged.

- [ ] **Step 5: Verify**

```bash
bun test tests/ workers/mcp && bun run check
```

Expected: PASS. Then from `workers/mcp/`: `npx tsc --noEmit` — expected clean.

- [ ] **Step 6: Commit**

```bash
git add workers/mcp/src/mcp-agent.ts workers/mcp/src/follows-tools.ts workers/mcp/src/whats-changed-tool.ts tests/unit/mcp-tool-annotations.test.ts
git commit -m "refactor(mcp): wrap tool input schemas in z.object ahead of SDK v2"
```

---

### Task 2: Cut over to `agents@0.20` + SDK v2

The dependency bump, the import swap, the handler swap, and the test-client swap must land together — `agents@0.20`'s `createMcpHandler` takes a v2 factory, so the moment the package moves, `index.ts` and every `McpServer` import must move with it. Splitting this leaves a non-compiling tree.

**Files:**
- Modify: `workers/mcp/package.json`, `workers/mcp/bun.lock`
- Modify: `workers/mcp/src/index.ts` (:1, :99–104)
- Modify: `workers/mcp/src/{mcp-agent,resources,follows-tools,whats-changed-tool,prompts}.ts` (import lines only)
- Modify: `tests/mcp-test-helpers.ts`
- Modify: `tests/unit/mcp-{scope-enforcement,follows-tools,tool-annotations,min-importance-filter,lookup-gate}.test.ts` (import lines only)
- Create: `workers/mcp/test/protocol.test.ts`

**Interfaces:**
- Consumes: `withPagination` returning an object schema (Task 1).
- Produces:
  - `createServer(env: Env, ctx?: ExecutionContext, opts?: CreateServerOptions): Promise<McpServer>` — signature unchanged, but `McpServer` is now the class from `@modelcontextprotocol/server`. Tasks 3–6 depend on this.
  - `workers/mcp/test/protocol.test.ts` exports nothing; Task 6 appends to it.
  - Test helpers in `workers/mcp/test/protocol.test.ts`: `stubEnv(overrides?: Partial<Env>): Env`, `stubCtx(): ExecutionContext`, `modernRpc(method: string, params?: Record<string, unknown>): object`, `modernRequest(body: unknown, mcpMethod: string, mcpName?: string): Request`.

- [ ] **Step 1: Write the failing test**

Create `workers/mcp/test/protocol.test.ts`:

```ts
/**
 * Wire-era coverage for the stateless v2 handler (#2189). These drive the real
 * `index.ts` fetch handler — not a bare McpServer — so the auth-first ordering
 * and the JSON response mode are asserted, not assumed.
 */
import { describe, it, expect } from "bun:test";
import worker from "../src/index";
import type { Env } from "../src/mcp-agent";

const notCalled = () => {
  throw new Error("binding should not be touched by tools/list");
};

/** Anonymous, prod-shaped env: no STAGING_ACCESS_KEY, no rate limiters, no FLAGS. */
export function stubEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: { prepare: notCalled, batch: notCalled, exec: notCalled } as unknown as Env["DB"],
    RELEASES_INDEX: {} as Env["RELEASES_INDEX"],
    ENTITIES_INDEX: {} as Env["ENTITIES_INDEX"],
    CHANGELOG_CHUNKS_INDEX: {} as Env["CHANGELOG_CHUNKS_INDEX"],
    ...overrides,
  };
}

export function stubCtx(): ExecutionContext {
  return {
    waitUntil() {},
    passThroughOnException() {},
  } as unknown as ExecutionContext;
}

// SEP-2243: the 2026-07-28 wire revision has no `initialize` handshake. Each
// request names its revision and capabilities in reserved `_meta` keys and
// mirrors the method (and, for tools/call, the tool name) in standard headers.
const MODERN_PROTOCOL_VERSION = "2026-07-28";
const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

let nextId = 1;

export function modernRpc(method: string, params?: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: nextId++,
    method,
    params: {
      ...params,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  };
}

export function modernRequest(body: unknown, mcpMethod: string, mcpName?: string): Request {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-method": mcpMethod,
  };
  if (mcpName !== undefined) headers["mcp-name"] = mcpName;
  return new Request("https://mcp.releases.sh/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("modern (2026-07-28) requests", () => {
  it("serves tools/list from the modern envelope, as plain JSON", async () => {
    const res = await worker.fetch(
      modernRequest(modernRpc("tools/list"), "tools/list"),
      stubEnv(),
      stubCtx(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const body = (await res.json()) as { result: { tools: Array<{ name: string }> } };
    expect(body.result.tools.map((t) => t.name)).toEqual(
      expect.arrayContaining(["search", "get_latest_releases", "list_organizations"]),
    );
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test workers/mcp/test/protocol.test.ts
```

Expected: FAIL. On `agents@0.17` the handler is the sessionful SDK-v1 one, which requires an `initialize` handshake and does not understand the `_meta` envelope — expect a JSON-RPC error or a non-200, not the tool list.

- [ ] **Step 3: Swap the dependencies**

In `workers/mcp/package.json`, `dependencies`:

```jsonc
"agents": "^0.20.1",
"@modelcontextprotocol/server": "^2.0.0",
```

Remove `"@modelcontextprotocol/sdk"`. Leave `zod` at `~4.3.6` for now (Task 4). Then:

```bash
cd workers/mcp && bun install
```

`agents@0.20.1` declares `@modelcontextprotocol/{sdk,server,client}` as non-optional peers, so v1 may still appear in the lockfile as a peer. That is expected — what matters is that nothing in `src/` imports it.

Add `@modelcontextprotocol/client` at `^2.0.0` and `@modelcontextprotocol/server` at `^2.0.0` to the **root** `package.json` `devDependencies`, replacing `"@modelcontextprotocol/sdk": "^1.29.0"`, then `bun install` at the root. The root copy is what `tests/` uses.

- [ ] **Step 4: Swap the source imports**

Five one-line edits, no other changes in these files:

```ts
// workers/mcp/src/mcp-agent.ts:2
import { McpServer } from "@modelcontextprotocol/server";

// workers/mcp/src/resources.ts:1
import { ResourceTemplate, type McpServer } from "@modelcontextprotocol/server";

// workers/mcp/src/follows-tools.ts:1
// workers/mcp/src/whats-changed-tool.ts:1
import { type McpServer } from "@modelcontextprotocol/server";

// workers/mcp/src/prompts.ts:1-2 — two imports collapse to one
import { type McpServer, completable } from "@modelcontextprotocol/server";
```

`ResourceTemplate`'s constructor and its `complete` map are unchanged in v2, so `resources.ts` needs nothing further. `completable()` is unchanged. Do not touch `slug-completion.ts`.

- [ ] **Step 5: Cut over the handler**

In `workers/mcp/src/index.ts`, change the import on line 1:

```ts
import { createMcpHandler } from "agents/mcp/server";
```

Then replace lines 99–104 (the `const server = await createServer(...)` block through the `return`):

```ts
  // Stateless v2 handler (#2189). `createServer` is passed as a FACTORY the
  // handler invokes per request — `legacy: "stateless"` (the default) serves
  // 2025-era `initialize` clients from the same factory, so the tool surface
  // can't drift between wire eras. `responseMode: "json"` preserves the
  // plain-JSON replies callers get today; without it the handler answers SSE
  // whenever the Accept header allows one.
  //
  // `route` and `allowedOriginHostnames` are NOT optional for us: the agents
  // wrapper does its own route matching and Origin validation, and its
  // defaults cover localhost and workers.dev only — a custom domain relies on
  // Cloudflare routing unless named here. Omitting them makes the wrapper
  // start rejecting our own callers.
  return createMcpHandler(
    () =>
      createServer(env, ctx, {
        userAgent: request.headers.get("user-agent"),
        authScopes: identity.scopes,
        authToken: identity.token,
        userToken: identity.userToken,
      }),
    {
      route: "/mcp",
      responseMode: "json",
      allowedOriginHostnames: [
        "mcp.releases.sh",
        "mcp-staging.releases.sh",
        "mcp.releases.localhost",
        "localhost",
        "127.0.0.1",
      ],
    },
  )(request, env, ctx);
```

The `handle()` body above this is untouched. `resolveMcpAuth`, the rate limiter, `touchLastUsed`, and `peekMcpCall` all still run first, and `identity` is still in scope.

- [ ] **Step 6: Migrate the test client**

In `tests/mcp-test-helpers.ts`, replace lines 1–3:

```ts
import { McpServer, InMemoryTransport } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
```

The doc comment at :17 still describes the dual-copy situation accurately — update the package name from `@modelcontextprotocol/sdk` to `@modelcontextprotocol/server` and leave the reasoning intact. The `unknown` cast in `createMcpTestClient` stays: `workers/mcp` still installs its own copy.

In each of the five suites (`tests/unit/mcp-scope-enforcement.test.ts:9-10`, `mcp-follows-tools.test.ts:2-3`, `mcp-tool-annotations.test.ts:2-3`, `mcp-min-importance-filter.test.ts:19-20`, `mcp-lookup-gate.test.ts:12-13`), replace the two import lines with:

```ts
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
```

Change **nothing else** in these suites. If an assertion needs changing to pass, stop and report it — that is a behavior change, not a migration, and it needs a decision.

- [ ] **Step 7: Run the tests to verify they pass**

```bash
bun test workers/mcp/test/protocol.test.ts
```

Expected: PASS.

```bash
bun test tests/ workers/mcp && bun run check
```

Expected: PASS, with the five migrated suites green and unmodified beyond their imports. From `workers/mcp/`: `npx tsc --noEmit` — expected clean. If it reports a dual-zod split, re-check in the main checkout before believing it; the worktree gives false positives on exactly this.

Two things this run is specifically proving, beyond "the suites pass":

- **`peekMcpCall` did not consume the body.** It reads the request body to extract billable operations, before the handler ever sees it. The new `protocol.test.ts` cases go through `index.ts`, so a double-read regression shows up as the handler receiving an empty body — a failure there, not in `consumption.test.ts` (which calls `peekMcpCall` directly and would stay green either way).
- **The wrapper's Origin validation accepts our own hostnames.** The tests post to `https://mcp.releases.sh/mcp`; a misconfigured `allowedOriginHostnames` surfaces as a rejection rather than a tool list.

- [ ] **Step 8: Commit**

```bash
git add workers/mcp/package.json workers/mcp/bun.lock package.json bun.lock workers/mcp/src tests/mcp-test-helpers.ts tests/unit workers/mcp/test/protocol.test.ts
git commit -m "feat(mcp): serve MCP 2026-07-28 via the v2 SDK and agents 0.20"
```

---

### Task 3: Cache hints on list results

The 2026-07-28 spec adds `ttlMs`/`cacheScope` to cacheable results. Our tool, prompt, and resource-template catalogs are static per deploy but auth-gated — the caller's scopes decide which tools register — so the correct hint is a generous TTL at `private` scope. `resources/read` deliberately keeps the SDK's `ttlMs: 0` default: those reads hit D1 and return live data.

**Files:**
- Modify: `workers/mcp/src/mcp-agent.ts` (the `new McpServer(...)` options object at :243–259)
- Test: `workers/mcp/test/protocol.test.ts`

**Interfaces:**
- Consumes: `createServer` returning a v2 `McpServer` (Task 2); `stubEnv`/`stubCtx`/`modernRpc`/`modernRequest` from `workers/mcp/test/protocol.test.ts` (Task 2).
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

Append to `workers/mcp/test/protocol.test.ts`:

```ts
describe("cache hints", () => {
  it("advertises a private, hour-long TTL on tools/list", async () => {
    const res = await worker.fetch(
      modernRequest(modernRpc("tools/list"), "tools/list"),
      stubEnv(),
      stubCtx(),
    );
    const body = (await res.json()) as {
      result: { _meta?: Record<string, unknown>; ttlMs?: number; cacheScope?: string };
    };
    // The SDK surfaces the hint on the result envelope; assert on whichever
    // carrier is present rather than pinning the exact key path.
    const carrier = { ...body.result, ...(body.result._meta ?? {}) } as Record<string, unknown>;
    expect(carrier.ttlMs).toBe(3_600_000);
    expect(carrier.cacheScope).toBe("private");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
bun test workers/mcp/test/protocol.test.ts
```

Expected: FAIL — `ttlMs` is `undefined` (or `0`), because no hints are configured yet.

- [ ] **Step 3: Configure the hints**

In `workers/mcp/src/mcp-agent.ts`, above `createServer`:

```ts
/**
 * The catalogs are static per deploy — they only change on a redeploy — but
 * every response is auth-gated: the caller's scopes decide which tools
 * register. Hence `private` rather than `public`. `resources/read` is
 * deliberately absent: those reads hit D1 and must not be cached.
 */
const LIST_CACHE_HINT = { ttlMs: 3_600_000, cacheScope: "private" } as const;
```

Then extend the `new McpServer(...)` options object (keep the existing `capabilities` block and its comment verbatim):

```ts
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
      },
      cacheHints: {
        "tools/list": LIST_CACHE_HINT,
        "prompts/list": LIST_CACHE_HINT,
        "resources/templates/list": LIST_CACHE_HINT,
      },
    },
```

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test tests/ workers/mcp && bun run check
```

Expected: PASS. If Step 1's assertion still fails because the SDK carries the hint somewhere neither branch of `carrier` reaches, inspect the actual response body, fix the **test's** key path to match, and note the real shape in a comment — do not weaken the assertion to a truthiness check.

- [ ] **Step 5: Commit**

```bash
git add workers/mcp/src/mcp-agent.ts workers/mcp/test/protocol.test.ts
git commit -m "feat(mcp): advertise cache hints on list results"
```

---

### Task 4: Relax the zod pin

`workers/mcp` pins `zod: ~4.3.6` only because SDK v1 nested its own copy ([#1367](https://github.com/buildinternet/releases/issues/1367)). v2 declares `zod ^4.2.0`, so the pin should be droppable. Its own task so a revert is clean.

**Files:**
- Modify: `workers/mcp/package.json`, `workers/mcp/bun.lock`

**Interfaces:**
- Consumes: the v2 dependency set (Task 2).
- Produces: nothing.

- [ ] **Step 1: Relax the pin**

In `workers/mcp/package.json`, change `"zod": "~4.3.6"` to `"zod": "^4.4.3"` (matching root), then:

```bash
cd workers/mcp && bun install
```

- [ ] **Step 2: Verify**

```bash
bun test tests/ workers/mcp && bun run check
```

Then from `workers/mcp/`: `npx tsc --noEmit`.

Expected: PASS and clean. **If either fails**, revert `package.json` to `~4.3.6`, re-run `bun install`, and record the exact error in the commit body of the next task — the pin is load-bearing after all and #1367 stays open. Do not spend time fighting it; the pin is not what this migration is for.

- [ ] **Step 3: Verify in the main checkout**

Worktree `tsc` runs on `workers/mcp` are known to falsely report a dual-zod split. Before trusting a **failure** here, re-run `npx tsc --noEmit` from `workers/mcp/` in `~/Code/releases` (the main checkout) on this branch.

- [ ] **Step 4: Commit**

```bash
git add workers/mcp/package.json workers/mcp/bun.lock
git commit -m "chore(mcp): drop the zod pin now that SDK v2 owns its own range"
```

If the pin turned out to be load-bearing, skip this commit entirely and move to Task 5.

---

### Task 5: Wrap prompt argument schemas

Deferred from Task 1 because v1's `registerPrompt` accepts only `PromptArgsRawShape` — `z.object` would not have compiled before the cutover. v2 accepts both; wrapping puts prompts on the non-deprecated overload.

**Files:**
- Modify: `workers/mcp/src/prompts.ts` (`argsSchema` at :36, :71, :114)
- Test: `tests/unit/mcp-tool-annotations.test.ts`

**Interfaces:**
- Consumes: `completable` imported from `@modelcontextprotocol/server` (Task 2).
- Produces: nothing.

- [ ] **Step 1: Write the failing test**

Append to `tests/unit/mcp-tool-annotations.test.ts`:

```ts
describe("prompt arguments", () => {
  it("still advertises completable prompt arguments after the v2 wrap", async () => {
    const server = await createServer(stubEnv());
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    await Promise.all([server.connect(serverT), client.connect(clientT)]);
    const { prompts } = await client.listPrompts();
    const whatsNew = prompts.find((p) => p.name === "whats_new");
    expect(whatsNew?.arguments?.map((a) => a.name)).toEqual(
      expect.arrayContaining(["product", "days"]),
    );
    await client.close();
  });
});
```

- [ ] **Step 2: Run it and confirm the baseline**

```bash
bun test tests/unit/mcp-tool-annotations.test.ts
```

Expected: PASS — a regression net over the raw-shape form, so the wrap in Step 3 is provably behavior-preserving.

- [ ] **Step 3: Wrap the schemas**

At each of the three `argsSchema:` sites in `workers/mcp/src/prompts.ts`, wrap the object literal in `z.object(...)`, leaving every `completable(...)` call and every `.describe(...)` exactly where it is:

```ts
// before
argsSchema: {
  product: completable(z.string().describe("…"), (value) => completeProductSlug(db, value)),
  days: z.string().optional().describe("Look-back window in days (default 30)"),
},

// after
argsSchema: z.object({
  product: completable(z.string().describe("…"), (value) => completeProductSlug(db, value)),
  days: z.string().optional().describe("Look-back window in days (default 30)"),
}),
```

Do not change any prompt callback body or the `parseDays` / `q` helpers.

- [ ] **Step 4: Run the tests to verify they pass**

```bash
bun test tests/ workers/mcp && bun run check
```

Expected: PASS, including the completion assertion.

- [ ] **Step 5: Commit**

```bash
git add workers/mcp/src/prompts.ts tests/unit/mcp-tool-annotations.test.ts
git commit -m "refactor(mcp): wrap prompt argument schemas in z.object"
```

---

### Task 6: Round out wire-era coverage

Task 2 proved the modern era serves `tools/list`. This adds the three cases that protect the contract: a modern `tools/call`, the header requirement, and — most important — that 2025-era clients still work and still get plain JSON rather than SSE.

**Files:**
- Modify: `workers/mcp/test/protocol.test.ts`

**Interfaces:**
- Consumes: `stubEnv`, `stubCtx`, `modernRpc`, `modernRequest` (Task 2).
- Produces: nothing.

- [ ] **Step 1: Write the tests**

Append to `workers/mcp/test/protocol.test.ts`:

```ts
describe("modern-era header requirement", () => {
  it("rejects a modern request missing the Mcp-Method header", async () => {
    const res = await worker.fetch(
      new Request("https://mcp.releases.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(modernRpc("tools/list")),
      }),
      stubEnv(),
      stubCtx(),
    );
    expect(res.status).toBe(400);
  });
});

describe("legacy (2025-era) requests", () => {
  it("still completes the initialize handshake and lists tools, as plain JSON", async () => {
    const env = stubEnv();
    const ctx = stubCtx();
    const legacy = (body: unknown) =>
      new Request("https://mcp.releases.sh/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(body),
      });

    const initRes = await worker.fetch(
      legacy({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "legacy-client", version: "1.0.0" },
        },
      }),
      env,
      ctx,
    );
    expect(initRes.status).toBe(200);
    // Plain JSON, not an SSE stream — this is what responseMode: "json" buys.
    expect(initRes.headers.get("content-type")).toContain("application/json");
    const init = (await initRes.json()) as { result: { serverInfo: { name: string } } };
    expect(init.result.serverInfo.name).toBe("releases");

    const listRes = await worker.fetch(
      legacy({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      env,
      ctx,
    );
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as { result: { tools: Array<{ name: string }> } };
    expect(list.result.tools.map((t) => t.name)).toContain("search");
  });
});
```

- [ ] **Step 2: Run them**

```bash
bun test workers/mcp/test/protocol.test.ts
```

Expected: PASS — all three describe the behavior Task 2 already shipped.

Two failures are informative rather than fatal, and both need a report before proceeding:
- The missing-header case returning something other than 400 means the `agents` wrapper handles the SEP-2243 requirement differently than the raw SDK. Record the actual status and assert that instead.
- The legacy case failing means 2025-era clients broke — that is a **blocking** regression. Stop and report; do not adjust the test to match.

- [ ] **Step 3: Add a modern `tools/call` case**

`search` needs D1, so use a tool that fails cleanly on the stub env and assert the envelope rather than the payload:

```ts
describe("modern tools/call", () => {
  it("routes a modern tools/call through the header + envelope path", async () => {
    const res = await worker.fetch(
      modernRequest(
        modernRpc("tools/call", { name: "list_follows", arguments: {} }),
        "tools/call",
        "list_follows",
      ),
      stubEnv(),
      stubCtx(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result?: unknown; error?: unknown };
    // The tool itself refuses anonymous callers (follows need a user
    // principal) — what matters here is that dispatch reached it at all,
    // i.e. a JSON-RPC result envelope rather than a transport-level error.
    expect(body.result).toBeDefined();
    expect(body.error).toBeUndefined();
  });
});
```

- [ ] **Step 4: Verify**

```bash
bun test tests/ workers/mcp && bun run check
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add workers/mcp/test/protocol.test.ts
git commit -m "test(mcp): cover both wire eras through the fetch handler"
```

---

### Task 7: Docs, registry metadata, and live verification

**Files:**
- Modify: `docs/architecture/mcp.md`
- Modify: `workers/mcp/server.json`

**Interfaces:**
- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Rewrite the transport section of `docs/architecture/mcp.md`**

Read the existing transport section first and preserve its structure and voice. It must end up stating:

- The server speaks **both wire eras** from one `createServer` factory, so the tool surface cannot drift between them.
- **2026-07-28**: no `initialize` handshake; each request carries its protocol version and client capabilities in reserved `_meta` keys (`io.modelcontextprotocol/protocolVersion`, `…/clientCapabilities`) plus the standard `Mcp-Method` / `Mcp-Name` headers (SEP-2243).
- **2025-era**: the classic `initialize` → `tools/*` flow keeps working, served statelessly from the same factory. Clients no longer receive a session id — which cost nothing, because `workers/mcp` binds no Durable Objects and that id never guaranteed isolate affinity.
- Replies are plain JSON (`responseMode: "json"`), not SSE.
- `tools/list`, `prompts/list`, and `resources/templates/list` carry `ttlMs: 3600000` / `cacheScope: "private"` — static per deploy, auth-gated. `resources/read` is uncached.
- `GET`/`DELETE /mcp` remain unserved: no listening stream, no session to close. We do not implement `subscriptions/listen` — that is [#346](https://github.com/buildinternet/releases/issues/346).
- The handler is `agents/mcp/server`'s `createMcpHandler`, and `route` + `allowedOriginHostnames` must be kept in sync with the deployed hostnames.

Per `AGENTS.md`, keep the root `AGENTS.md` MCP entry to one line pointing here — do not expand it.

- [ ] **Step 2: Bump the registry listing**

In `workers/mcp/server.json`, bump `version` to match `workers/mcp/package.json`. Check whether `https://static.modelcontextprotocol.io/schemas/` publishes a schema revision newer than the pinned `2025-12-11`; if so, update the `$schema` pin and re-validate the file parses. If not, leave it.

- [ ] **Step 3: Verify locally against a real client**

```bash
bun run dev:mcp
```

Then in a second shell:

```bash
bun run mcp:inspect:local
```

Confirm in the Inspector: the connection succeeds, `tools/list` returns the full catalog, `prompts/list` shows the three prompts with completable arguments, and at least one tool call returns real data. This is the only step that exercises a real MCP client end-to-end — do not skip it.

- [ ] **Step 4: Full verification**

```bash
bun run check && bun test
```

Expected: PASS. Note the root `test` script runs `workers/api` in its own Bun process — let it finish; a `mock.module` leak from an earlier suite is exactly what that split exists to prevent.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/mcp.md workers/mcp/server.json
git commit -m "docs(mcp): document the 2026-07-28 transport and cache hints"
```

- [ ] **Step 6: Open the PR**

Write the body to a file and pass `--body-file` (never inline). Reference `Closes the Phase 1 checkbox of #2189`, and state explicitly what is deferred: `workers/mcp/ui` (Phase 3), better-auth 1.7 + CIMD (Phase 2), `subscriptions/listen` (#346). Include the verification evidence from Steps 3–4 — actual command output, not a claim that they passed.

Do **not** request a CodeRabbit review by default. This PR does touch the auth-adjacent request path, so it is a defensible candidate — ask before triggering it.

---

## Notes for the implementer

**If `agents@0.20.1` turns out not to expose `responseMode` or `allowedOriginHostnames` as documented**, stop and report before improvising. The fallback is the sunny#774 shape — `isLegacyRequest` branching to a hand-wired `WebStandardStreamableHTTPServerTransport` with `enableJsonResponse: true` — but that is a materially larger design and needs a decision, not a quiet substitution.

**If a migrated test needs its assertions changed to pass**, that is a behavior change, not a migration. Stop and report which assertion and why.

**Do not "fix" the `unknown` cast in `createMcpTestClient`.** It exists because `workers/mcp` is a carved-out workspace with its own SDK copy, so the classes are nominally distinct. That is still true on v2.
