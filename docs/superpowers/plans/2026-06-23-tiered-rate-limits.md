# Tiered API + MCP Rate Limits — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give authenticated free-account principals a higher request quota than anonymous callers, on the Cloudflare rate-limiter that already exists, and emit a per-principal/per-tier consumption signal admins can query later.

**Architecture:** A new third rung (`account`, 300/min) slots between the existing anonymous-IP rung (120/min) and machine-token rung (600/min). Tier selection + quota constants + a KV credential-validation cache live in a shared `packages/lib` module used by both the API and MCP workers. Counters stay on Cloudflare's native Rate Limiting bindings (no D1/KV counters). The limiter emits a structured `rate-limit`/`decision` log event (keyed on a hashed bucket id + tier + outcome) so consumption is reconstructable in Axiom without any schema or hot-path change.

**Tech Stack:** TypeScript (strict), Bun test, Hono (API worker), Cloudflare Workers (`ratelimit` unsafe bindings, KV), Better Auth (`apiKey` plugin), `@releases/lib` workspace packages.

## Global Constraints

- Runtime is Bun; language is TypeScript strict mode. Type-check with `npx tsc --noEmit` (root + each worker).
- Counters MUST stay on Cloudflare native `ratelimit` bindings. Do NOT move rate-limit counting to KV or D1. KV is used ONLY for the credential-validation cache.
- **No new feature flag.** The account rung rides the existing `rate-limit-enabled` / `RATE_LIMIT_ENABLED` gate. The machine rung keeps its existing `TOKEN_RATE_LIMIT_ENABLED` env var.
- Quota ladder (exact): anonymous **120**, account **300**, machine **600**, all `period: 60`. CF constraint: `period` must be `10` or `60`.
- All logs from worker code go through `logEvent()` from `@releases/lib/log-event`. Never log a raw token, email, or (in the consumption stream) a raw IP — hash via `hashSecret`.
- `packages/lib` is runtime-neutral: the shared module MUST NOT import Hono, Better Auth, Drizzle, or `@cloudflare/workers-types` concretely — use structural interfaces (mirror the existing structural `Limiter` type in `rate-limit.ts`).
- This work runs in the `tiered-rate-limits-spec` worktree. If `node_modules` is absent, run `./scripts/setup-worktree.sh` once before type-checking or testing (AGENTS.md).
- Test invocation per AGENTS.md: `packages/` and `tests/`+workers (mcp/discovery/webhooks) run in one process; `workers/api` runs in its own. Use the targeted commands shown in each task.
- Provisioning the real `USER_RATE_LIMITER` namespace id and `CREDENTIAL_CACHE` KV ids in Cloudflare is a deploy-time step (out of scope for code tasks); the plan uses the next free unsafe namespace id `1006` and placeholder KV ids that an operator replaces before deploy. This is called out in Task 4.

---

## File Structure

- `packages/lib/src/rate-limit-tiers.ts` (new) — pure, worker-neutral: quota constants, `RateLimitTier`, `resolveTierEnforcement()`, the KV credential-cache helper `resolveAccountFromCache()`, the `rateLimitConsumerRef()` hasher, and the decision-event payload builder `rateLimitDecisionPayload()`. One responsibility: tier policy + helpers, no I/O of its own beyond the injected cache/limiter.
- `packages/lib/src/rate-limit-tiers.test.ts` (new) — unit tests for the above.
- `packages/lib/package.json` — add the `./rate-limit-tiers` export.
- `workers/api/src/middleware/auth.ts` — add `validateAccountCredential()` (relu\_ verify-for-tier, flag-gated) and export the account-tier helpers the middleware needs.
- `workers/api/src/middleware/rate-limit.ts` — wire the account rung + credential cache + decision events through the shared module.
- `workers/api/src/index.ts` — add `USER_RATE_LIMITER`, `CREDENTIAL_CACHE` to the `Env.Bindings` type.
- `workers/api/wrangler.jsonc` — add the `USER_RATE_LIMITER` unsafe binding + `CREDENTIAL_CACHE` KV namespace.
- `tests/api/rate-limit.test.ts` — extend the existing harness with account-tier + bypass + decision-event cases.
- `workers/mcp/src/rate-limit.ts` (new) — `enforceMcpRateLimit()` mapping `McpIdentity` → tier and enforcing.
- `workers/mcp/src/rate-limit.test.ts` (new) — unit tests for the mapping/enforcement.
- `workers/mcp/src/index.ts` — call `enforceMcpRateLimit()` in `handle()` after auth.
- `workers/mcp/wrangler.jsonc` — add the same `USER_RATE_LIMITER` + `CREDENTIAL_CACHE` (CREDENTIAL_CACHE bound for parity; MCP does not use it — see Task 7 note) + the unsafe block.

---

## Task 1: Shared tier policy — `resolveTierEnforcement()` + quotas

**Files:**

- Create: `packages/lib/src/rate-limit-tiers.ts`
- Test: `packages/lib/src/rate-limit-tiers.test.ts`
- Modify: `packages/lib/package.json` (exports map)

**Interfaces:**

- Produces:
  - `RATE_LIMIT_WINDOW_SECONDS = 60`
  - `TIER_QUOTAS = { anonymous: 120, account: 300, machine: 600 }`
  - `TIER_POLICY = { anonymous: "public", account: "account", machine: "token" }`
  - `type RateLimitTier = "anonymous" | "account" | "machine"`
  - `interface RateLimiter { limit(options: { key: string }): Promise<{ success: boolean }> }`
  - `type RateLimitPrincipal = { tier: "exempt" } | { tier: "machine"; bucketKey: string } | { tier: "account"; bucketKey: string } | { tier: "anonymous"; bucketKey: string }`
  - `interface TierLimiters { anonymous?: RateLimiter; account?: RateLimiter; machine?: RateLimiter }`
  - `interface TierEnforcement { tier: RateLimitTier; limiter?: RateLimiter; key: string; policyName: string; quota: number }`
  - `function resolveTierEnforcement(principal: RateLimitPrincipal, limiters: TierLimiters): TierEnforcement | null`

- [ ] **Step 1: Write the failing test**

Create `packages/lib/src/rate-limit-tiers.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { resolveTierEnforcement, TIER_QUOTAS, type RateLimiter } from "./rate-limit-tiers";

const fakeLimiter = (): RateLimiter => ({
  async limit() {
    return { success: true };
  },
});

describe("resolveTierEnforcement", () => {
  it("returns null for an exempt principal", () => {
    expect(resolveTierEnforcement({ tier: "exempt" }, {})).toBeNull();
  });

  it("maps an account principal to the account limiter, key, and 300 quota", () => {
    const account = fakeLimiter();
    const out = resolveTierEnforcement(
      { tier: "account", bucketKey: "user_abc" },
      { account, anonymous: fakeLimiter(), machine: fakeLimiter() },
    );
    expect(out).toEqual({
      tier: "account",
      limiter: account,
      key: "user_abc",
      policyName: "account",
      quota: TIER_QUOTAS.account,
    });
  });

  it("maps a machine principal to the machine limiter and 600 quota", () => {
    const machine = fakeLimiter();
    const out = resolveTierEnforcement({ tier: "machine", bucketKey: "tok_1" }, { machine });
    expect(out?.quota).toBe(600);
    expect(out?.key).toBe("tok_1");
    expect(out?.policyName).toBe("token");
  });

  it("maps an anonymous principal to the anonymous limiter and 120 quota", () => {
    const anonymous = fakeLimiter();
    const out = resolveTierEnforcement({ tier: "anonymous", bucketKey: "1.2.3.4" }, { anonymous });
    expect(out?.quota).toBe(120);
    expect(out?.key).toBe("1.2.3.4");
    expect(out?.policyName).toBe("public");
  });

  it("returns limiter:undefined when the matching rung's limiter is absent (rung disabled → allow)", () => {
    const out = resolveTierEnforcement({ tier: "account", bucketKey: "u" }, {});
    expect(out?.limiter).toBeUndefined();
    expect(out?.quota).toBe(300);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/lib/src/rate-limit-tiers.test.ts`
Expected: FAIL — `Cannot find module './rate-limit-tiers'`.

- [ ] **Step 3: Write minimal implementation**

Create `packages/lib/src/rate-limit-tiers.ts`:

```typescript
/**
 * Shared rate-limit tier policy for the API and MCP workers. Pure and
 * runtime-neutral — counters live on Cloudflare's native `ratelimit` bindings,
 * passed in as the structural `RateLimiter` type (mirrors the binding shape).
 */

/** CF constraint: a ratelimit binding period is 10 or 60. We use 60 everywhere. */
export const RATE_LIMIT_WINDOW_SECONDS = 60;

/** Quotas mirror `simple.limit` for each binding in the workers' wrangler.jsonc. */
export const TIER_QUOTAS = { anonymous: 120, account: 300, machine: 600 } as const;

/** IETF RateLimit-Policy names advertised to clients per tier. */
export const TIER_POLICY = { anonymous: "public", account: "account", machine: "token" } as const;

export type RateLimitTier = "anonymous" | "account" | "machine";

/** Structural shape of a Cloudflare `ratelimit` unsafe binding. */
export interface RateLimiter {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * A resolved caller, already classified by the worker. `bucketKey` is the
 * rate-limit bucket: `userId` for account, `tokenId` for machine, IP for
 * anonymous. `exempt` covers the root key and the trusted web proxy.
 */
export type RateLimitPrincipal =
  | { tier: "exempt" }
  | { tier: "machine"; bucketKey: string }
  | { tier: "account"; bucketKey: string }
  | { tier: "anonymous"; bucketKey: string };

/** The active limiter binding per rung (undefined when that rung is disabled). */
export interface TierLimiters {
  anonymous?: RateLimiter;
  account?: RateLimiter;
  machine?: RateLimiter;
}

export interface TierEnforcement {
  tier: RateLimitTier;
  /** undefined → this rung's limiter is off/absent → the caller should allow. */
  limiter?: RateLimiter;
  key: string;
  policyName: string;
  quota: number;
}

/**
 * Resolve which limiter + bucket key + quota apply to `principal`. Returns null
 * for exempt callers. A non-null result with `limiter === undefined` means the
 * matching rung is disabled — the caller allows the request (still advertising
 * the policy if it wishes).
 */
export function resolveTierEnforcement(
  principal: RateLimitPrincipal,
  limiters: TierLimiters,
): TierEnforcement | null {
  if (principal.tier === "exempt") return null;
  const tier = principal.tier;
  return {
    tier,
    limiter: limiters[tier],
    key: principal.bucketKey,
    policyName: TIER_POLICY[tier],
    quota: TIER_QUOTAS[tier],
  };
}
```

Add to `packages/lib/package.json` exports map (alphabetical, after `"./prompt-escape"`):

```json
    "./rate-limit-tiers": "./src/rate-limit-tiers.ts",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/lib/src/rate-limit-tiers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/rate-limit-tiers.ts packages/lib/src/rate-limit-tiers.test.ts packages/lib/package.json
git commit -m "feat(rate-limit): shared tier policy resolver + quotas"
```

---

## Task 2: Shared credential-validation cache — `resolveAccountFromCache()`

**Files:**

- Modify: `packages/lib/src/rate-limit-tiers.ts`
- Test: `packages/lib/src/rate-limit-tiers.test.ts`

**Interfaces:**

- Consumes: `hashSecret` from `@buildinternet/releases-core/api-token` (signature `(secret: string) => Promise<string>`, SHA-256 hex).
- Produces:
  - `interface CredentialCache { get(key: string): Promise<string | null>; put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> }`
  - `interface AccountValidation { valid: boolean; userId?: string }`
  - `CREDENTIAL_CACHE_TTL_SECONDS = 60`
  - `function resolveAccountFromCache(opts: { credential: string; cache: CredentialCache | undefined; validate: () => Promise<AccountValidation>; ttlSeconds?: number }): Promise<AccountValidation>`

- [ ] **Step 1: Write the failing test**

Append to `packages/lib/src/rate-limit-tiers.test.ts`:

```typescript
import { resolveAccountFromCache, type CredentialCache } from "./rate-limit-tiers";

function fakeCache(): CredentialCache & { store: Map<string, string>; gets: number } {
  const store = new Map<string, string>();
  return {
    store,
    gets: 0,
    async get(key) {
      this.gets += 1;
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

describe("resolveAccountFromCache", () => {
  it("verifies on a cache miss, then serves the cached result without re-verifying", async () => {
    const cache = fakeCache();
    let verifies = 0;
    const validate = async () => {
      verifies += 1;
      return { valid: true, userId: "user_1" };
    };
    const first = await resolveAccountFromCache({ credential: "relu_abc", cache, validate });
    const second = await resolveAccountFromCache({ credential: "relu_abc", cache, validate });
    expect(first).toEqual({ valid: true, userId: "user_1" });
    expect(second).toEqual({ valid: true, userId: "user_1" });
    expect(verifies).toBe(1); // second call hit the cache
  });

  it("caches a negative result (junk credential) so it is not re-verified", async () => {
    const cache = fakeCache();
    let verifies = 0;
    const validate = async () => {
      verifies += 1;
      return { valid: false };
    };
    await resolveAccountFromCache({ credential: "relu_junk", cache, validate });
    const again = await resolveAccountFromCache({ credential: "relu_junk", cache, validate });
    expect(again.valid).toBe(false);
    expect(verifies).toBe(1);
  });

  it("verifies every call when no cache is provided", async () => {
    let verifies = 0;
    const validate = async () => {
      verifies += 1;
      return { valid: true, userId: "u" };
    };
    await resolveAccountFromCache({ credential: "relu_x", cache: undefined, validate });
    await resolveAccountFromCache({ credential: "relu_x", cache: undefined, validate });
    expect(verifies).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/lib/src/rate-limit-tiers.test.ts`
Expected: FAIL — `resolveAccountFromCache` is not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/lib/src/rate-limit-tiers.ts`:

```typescript
import { hashSecret } from "@buildinternet/releases-core/api-token";

/** Structural subset of a Cloudflare KVNamespace used for validation caching. */
export interface CredentialCache {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

export interface AccountValidation {
  valid: boolean;
  userId?: string;
}

/** Short TTL: bounds the rate-tier revocation lag (auth itself is always live). */
export const CREDENTIAL_CACHE_TTL_SECONDS = 60;

/** Serialized cache value: `1|<userId>` for valid, `0` for invalid. */
function encode(v: AccountValidation): string {
  return v.valid ? `1|${v.userId ?? ""}` : "0";
}
function decode(raw: string): AccountValidation {
  if (raw === "0") return { valid: false };
  const userId = raw.startsWith("1|") ? raw.slice(2) : "";
  return { valid: true, userId: userId || undefined };
}

/**
 * Resolve whether `credential` belongs to a real account, caching the result in
 * KV keyed on a hash of the credential (never the raw credential). On a miss,
 * `validate()` runs once and the result (positive OR negative) is cached for
 * `ttlSeconds`. With no cache, `validate()` runs every call. This bounds the
 * verify/meter cost to at most once per credential per TTL window and blocks the
 * bypass where a junk credential would otherwise mint a fresh account bucket.
 */
export async function resolveAccountFromCache(opts: {
  credential: string;
  cache: CredentialCache | undefined;
  validate: () => Promise<AccountValidation>;
  ttlSeconds?: number;
}): Promise<AccountValidation> {
  const { credential, cache, validate } = opts;
  const ttl = opts.ttlSeconds ?? CREDENTIAL_CACHE_TTL_SECONDS;
  if (!cache) return validate();
  const cacheKey = `ratelimit:cred:${await hashSecret(credential)}`;
  const cached = await cache.get(cacheKey);
  if (cached !== null) return decode(cached);
  const result = await validate();
  await cache.put(cacheKey, encode(result), { expirationTtl: ttl });
  return result;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/lib/src/rate-limit-tiers.test.ts`
Expected: PASS (8 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/rate-limit-tiers.ts packages/lib/src/rate-limit-tiers.test.ts
git commit -m "feat(rate-limit): KV credential-validation cache helper"
```

---

## Task 3: Shared consumption signal — `rateLimitConsumerRef()` + `rateLimitDecisionPayload()`

**Files:**

- Modify: `packages/lib/src/rate-limit-tiers.ts`
- Test: `packages/lib/src/rate-limit-tiers.test.ts`

**Interfaces:**

- Consumes: `hashSecret` (already imported in Task 2).
- Produces:
  - `function rateLimitConsumerRef(bucketKey: string): Promise<string>` — hashed, non-reversible.
  - `interface RateLimitDecision { surface: "api" | "mcp"; tier: RateLimitTier; rateLimited: boolean; consumerRef: string; operation: string }`
  - `function rateLimitDecisionPayload(d: RateLimitDecision): { component: "rate-limit"; event: "decision" } & RateLimitDecision`

- [ ] **Step 1: Write the failing test**

Append to `packages/lib/src/rate-limit-tiers.test.ts`:

```typescript
import { rateLimitConsumerRef, rateLimitDecisionPayload } from "./rate-limit-tiers";

describe("consumption signal", () => {
  it("hashes the bucket key into a stable, non-raw consumerRef", async () => {
    const a = await rateLimitConsumerRef("1.2.3.4");
    const b = await rateLimitConsumerRef("1.2.3.4");
    expect(a).toBe(b); // stable
    expect(a).not.toContain("1.2.3.4"); // never the raw value
    expect(a).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("builds a tagged decision payload", () => {
    const payload = rateLimitDecisionPayload({
      surface: "api",
      tier: "account",
      rateLimited: false,
      consumerRef: "deadbeef",
      operation: "GET orgs",
    });
    expect(payload).toEqual({
      component: "rate-limit",
      event: "decision",
      surface: "api",
      tier: "account",
      rateLimited: false,
      consumerRef: "deadbeef",
      operation: "GET orgs",
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/lib/src/rate-limit-tiers.test.ts`
Expected: FAIL — `rateLimitConsumerRef` / `rateLimitDecisionPayload` not exported.

- [ ] **Step 3: Write minimal implementation**

Append to `packages/lib/src/rate-limit-tiers.ts`:

```typescript
/**
 * Non-reversible per-bucket id for the consumption stream. Hashes the bucket key
 * (userId / tokenId / IP) so admins can group consumption per principal+tier in
 * Axiom without any raw token, email, or IP landing in logs.
 */
export async function rateLimitConsumerRef(bucketKey: string): Promise<string> {
  return hashSecret(`ratelimit:ref:${bucketKey}`);
}

export interface RateLimitDecision {
  surface: "api" | "mcp";
  tier: RateLimitTier;
  rateLimited: boolean;
  consumerRef: string;
  operation: string;
}

/** Build the structured decision event for `logEvent` (component `rate-limit`). */
export function rateLimitDecisionPayload(
  d: RateLimitDecision,
): { component: "rate-limit"; event: "decision" } & RateLimitDecision {
  return { component: "rate-limit", event: "decision", ...d };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/lib/src/rate-limit-tiers.test.ts`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/rate-limit-tiers.ts packages/lib/src/rate-limit-tiers.test.ts
git commit -m "feat(rate-limit): consumption decision-event helpers"
```

---

## Task 4: API bindings + `Env` type + `validateAccountCredential()`

**Files:**

- Modify: `workers/api/wrangler.jsonc` (unsafe bindings + kv_namespaces)
- Modify: `workers/api/src/index.ts` (`Env.Bindings` type)
- Modify: `workers/api/src/middleware/auth.ts` (new `validateAccountCredential`)
- Test: `tests/api/rate-limit.test.ts` (new `validateAccountCredential` unit cases)

**Interfaces:**

- Consumes: `verifyUserKey` (existing in `auth.ts`, returns `{ ok; scopes; keyId; userId }`), `FLAGS`/`flag` (existing), `isUserApiKeyShaped` (existing import).
- Produces: `function validateAccountCredential(c: Context<Env>, presented: string): Promise<{ valid: boolean; userId?: string }>` exported from `auth.ts`.

- [ ] **Step 1: Add the wrangler bindings**

In `workers/api/wrangler.jsonc`, inside `unsafe.bindings`, add after the `TOKEN_RATE_LIMITER` entry (keeping the existing comment style):

```jsonc
      // Per-account cap for authenticated free accounts (relu_ user keys + OAuth
      // JWT users), keyed by userId. Rides RATE_LIMIT_ENABLED (same gate as the
      // per-IP public limiter). Sits between anonymous (120) and machine (600).
      {
        "name": "USER_RATE_LIMITER",
        "type": "ratelimit",
        "namespace_id": "1006",
        "simple": { "limit": 300, "period": 60 },
      },
```

In `workers/api/wrangler.jsonc`, inside `kv_namespaces`, add (replace the placeholder ids with the real namespace before deploy — see Global Constraints):

```jsonc
    {
      "binding": "CREDENTIAL_CACHE",
      "id": "REPLACE_WITH_CREDENTIAL_CACHE_KV_ID",
      "preview_id": "REPLACE_WITH_CREDENTIAL_CACHE_PREVIEW_ID",
    },
```

- [ ] **Step 2: Extend the `Env.Bindings` type**

In `workers/api/src/index.ts`, in the `Env.Bindings` block, add after the `TOKEN_RATE_LIMITER` declaration:

```typescript
    // Per-account rate limiter for authenticated free accounts (relu_ + OAuth
    // JWT users), keyed by userId. Rides RATE_LIMIT_ENABLED (see middleware/rate-limit.ts).
    USER_RATE_LIMITER?: { limit(options: { key: string }): Promise<{ success: boolean }> };
    // KV cache of credential-validation results for the account rate-limit tier
    // (hash(credential) → {valid,userId}, ~60s TTL). Absent → verify every read.
    CREDENTIAL_CACHE?: KVNamespace;
```

- [ ] **Step 3: Write the failing test for `validateAccountCredential`**

Append to `tests/api/rate-limit.test.ts` a new describe block. This test drives the flag-gated relu\_ verify path via an injected Better Auth seam (the same `betterAuth` context seam `verifyUserKey` uses). Use a minimal Hono app that mounts a route which calls the helper:

```typescript
import { validateAccountCredential } from "../../workers/api/src/middleware/auth";

function authApp() {
  const app = new Hono<any>();
  app.get("/probe", async (c) => {
    const presented = (c.req.header("authorization") ?? "").replace("Bearer ", "");
    return c.json(await validateAccountCredential(c as any, presented));
  });
  return app;
}

const fakeBetterAuth = (result: {
  valid: boolean;
  userId?: string | null;
  permissions?: Record<string, string[]> | null;
}) => ({
  api: {
    verifyApiKey: async () => ({
      valid: result.valid,
      key: result.valid
        ? {
            id: "key_1",
            userId: result.userId ?? null,
            permissions: result.permissions ?? { api: ["read"] },
          }
        : null,
    }),
  },
});

describe("validateAccountCredential", () => {
  it("resolves a valid relu_ key to {valid:true,userId} when the flag is on", async () => {
    const app = authApp();
    // Inject the betterAuth seam + flags-on env.
    app.use("*", async (c, next) => {
      c.set("betterAuth", fakeBetterAuth({ valid: true, userId: "user_42" }));
      await next();
    });
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer relu_abc" } },
      { USER_API_KEYS_ENABLED: "true", API_TOKENS_DISABLED: "false" },
    );
    expect(await res.json()).toEqual({ valid: true, userId: "user_42" });
  });

  it("resolves to {valid:false} when the user-keys flag is off (relu_ dark)", async () => {
    const app = authApp();
    app.use("*", async (c, next) => {
      c.set("betterAuth", fakeBetterAuth({ valid: true, userId: "user_42" }));
      await next();
    });
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer relu_abc" } },
      { USER_API_KEYS_ENABLED: "false", API_TOKENS_DISABLED: "false" },
    );
    expect(await res.json()).toEqual({ valid: false });
  });

  it("resolves a junk relu_-shaped string to {valid:false}", async () => {
    const app = authApp();
    app.use("*", async (c, next) => {
      c.set("betterAuth", fakeBetterAuth({ valid: false }));
      await next();
    });
    const res = await app.request(
      "/probe",
      { headers: { authorization: "Bearer relu_junk" } },
      { USER_API_KEYS_ENABLED: "true", API_TOKENS_DISABLED: "false" },
    );
    expect(await res.json()).toEqual({ valid: false });
  });
});
```

Note: the `app.use("*", …)` registration order in Hono runs middleware before the route; ensure the seam middleware is registered before `/probe` by adjusting `authApp()` to register the seam first if needed during implementation.

- [ ] **Step 4: Run test to verify it fails**

Run: `bun test tests/api/rate-limit.test.ts`
Expected: FAIL — `validateAccountCredential` is not exported from `auth.ts`.

- [ ] **Step 5: Implement `validateAccountCredential`**

In `workers/api/src/middleware/auth.ts`, add (after `verifyUserKey`):

```typescript
/**
 * Validate a presented `relu_` user key for the RATE-LIMIT account tier only —
 * never for authorization. Returns `{ valid, userId }`. Flag-gated exactly like
 * the metered lane (`API_TOKENS_DISABLED` kill switch + `USER_API_KEYS_ENABLED`
 * rollout): when either gate is closed the key is treated as not-an-account
 * (`{ valid: false }`), so it falls to the anonymous IP rung — matching today's
 * behavior. The limiter calls this behind a ~60s KV cache, so the underlying
 * `verifyUserKey` (which meters) runs at most once per key per window.
 */
export async function validateAccountCredential(
  c: Context<Env>,
  presented: string,
): Promise<{ valid: boolean; userId?: string }> {
  if (!isUserApiKeyShaped(presented)) return { valid: false };
  if (await flag(c.env.FLAGS, c.env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled))
    return { valid: false };
  if (!(await flag(c.env.FLAGS, c.env.USER_API_KEYS_ENABLED, FLAGS.userApiKeysEnabled)))
    return { valid: false };
  const v = await verifyUserKey(c, presented);
  if (v.ok && v.userId) return { valid: true, userId: v.userId };
  return { valid: false };
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `bun test tests/api/rate-limit.test.ts`
Expected: PASS (existing cases + the 3 new `validateAccountCredential` cases).

- [ ] **Step 7: Type-check the worker**

Run: `cd workers/api && npx tsc --noEmit`
Expected: no errors. (Confirms the `Env.Bindings` additions compile.)

- [ ] **Step 8: Commit**

```bash
git add workers/api/wrangler.jsonc workers/api/src/index.ts workers/api/src/middleware/auth.ts tests/api/rate-limit.test.ts
git commit -m "feat(api): account-tier rate-limit bindings + relu_ tier validation"
```

---

## Task 5: Wire the account rung into `publicRateLimitMiddleware`

**Files:**

- Modify: `workers/api/src/middleware/rate-limit.ts`
- Test: `tests/api/rate-limit.test.ts`

**Interfaces:**

- Consumes: `resolveTierEnforcement`, `resolveAccountFromCache`, `TIER_QUOTAS`, `RateLimitPrincipal` from `@releases/lib/rate-limit-tiers`; `resolveAuthIdentity`, `validateAccountCredential`, `isTrustedProxy`, `SAFE_METHODS` from `./auth.js`; `isUserApiKeyShaped`, `OAUTH_JWT_TOKEN_PREFIX`.
- Produces: updated `publicRateLimitMiddleware` that buckets `oauth_`/`relu_` user principals at the account rung (300, keyed on userId) and `relk_` at the machine rung (600).

- [ ] **Step 1: Write the failing tests**

Append to `tests/api/rate-limit.test.ts`. Extend the local `Env` type and `createApp` already in the file to also accept `USER_RATE_LIMITER`, `CREDENTIAL_CACHE`, and the `betterAuth` seam. Add:

```typescript
describe("account tier", () => {
  it("buckets an OAuth-JWT user at the account limiter keyed on the user id", async () => {
    // resolveAuthIdentity returns kind:"token" tokenId `oauth_<sub>` for a JWT.
    // Stub the JWT verify seam so the bearer resolves to oauth_user_9.
    const account = mockLimiter([true]);
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { authorization: "Bearer eyJ.fake.jwt", "cf-connecting-ip": "9.9.9.9" } },
      {
        RATE_LIMIT_ENABLED: "true",
        USER_RATE_LIMITER: account,
        // oauthJwtKeyResolver seam → verifies to subject "user_9" (see harness note)
        oauthJwtKeyResolver: stubJwtResolver("user_9"),
      },
    );
    expect(res.status).toBe(200);
    expect(account.calls).toEqual(["oauth_user_9"]);
  });

  it("buckets a valid relu_ key at the account limiter keyed on userId (via cache)", async () => {
    const account = mockLimiter([true]);
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { authorization: "Bearer relu_live", "cf-connecting-ip": "9.9.9.9" } },
      {
        RATE_LIMIT_ENABLED: "true",
        USER_API_KEYS_ENABLED: "true",
        USER_RATE_LIMITER: account,
        CREDENTIAL_CACHE: undefined, // exercise the no-cache path → validate directly
        betterAuth: fakeBetterAuth({ valid: true, userId: "user_77" }),
      },
    );
    expect(res.status).toBe(200);
    expect(account.calls).toEqual(["user_77"]);
  });

  it("BYPASS GUARD: a junk relu_ string falls to the per-IP anonymous limiter, never account", async () => {
    const account = mockLimiter([true]);
    const ip = mockLimiter([true]);
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { authorization: "Bearer relu_junk", "cf-connecting-ip": "5.5.5.5" } },
      {
        RATE_LIMIT_ENABLED: "true",
        USER_API_KEYS_ENABLED: "true",
        USER_RATE_LIMITER: account,
        PUBLIC_RATE_LIMITER: ip,
        betterAuth: fakeBetterAuth({ valid: false }),
      },
    );
    expect(res.status).toBe(200);
    expect(account.calls).toEqual([]); // never reached the account bucket
    expect(ip.calls).toEqual(["5.5.5.5"]); // capped by IP instead
  });

  it("keeps relk_ machine tokens on the 600 token limiter", async () => {
    const tokenLimiter = mockLimiter([true]);
    const account = mockLimiter([true]);
    const app = createApp();
    const res = await app.request(
      "/test",
      { headers: { authorization: "Bearer relk_live", "cf-connecting-ip": "9.9.9.9" } },
      {
        TOKEN_RATE_LIMIT_ENABLED: "true",
        TOKEN_RATE_LIMITER: tokenLimiter,
        USER_RATE_LIMITER: account,
        betterAuth: stubMachineToken("tok_relk_1"), // verifyApiToken seam → tokenId tok_relk_1
      },
    );
    expect(res.status).toBe(200);
    expect(account.calls).toEqual([]);
    expect(tokenLimiter.calls).toEqual(["tok_relk_1"]);
  });
});
```

Harness notes for the implementer (add the small stubs near `mockLimiter`):

- `stubJwtResolver(sub)` — returns an `oauthJwtKeyResolver` that makes `verifyPresentedJwt` resolve to `{ subject: sub, scopes: ["read"] }`. If wiring a real jose key is heavy, instead stub at the `resolveAuthIdentity` boundary by injecting a context value the middleware reads; choose whichever seam the existing JWT tests use.
- `stubMachineToken(tokenId)` — a `betterAuth`/DB seam so `verifyApiToken` returns `{ ok: true, tokenId, scopes: ["read"] }`. Mirror the existing token-tier test in this file if one exists; otherwise use the DB seam `createTestDb`.
- `fakeBetterAuth` — already defined in Task 4.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/api/rate-limit.test.ts`
Expected: FAIL — relu\_ currently falls to anonymous (no account bucket); OAuth users hit the token (600) limiter, not `USER_RATE_LIMITER`.

- [ ] **Step 3: Rewrite `publicRateLimitMiddleware`**

Replace the body of `workers/api/src/middleware/rate-limit.ts` with the version below. It delegates tier selection to the shared module and adds the account rung. (The `enforce()` helper and policy-header logic are unchanged from the current file — keep them.)

```typescript
import type { Context, MiddlewareHandler } from "hono";
import type { Env } from "../index.js";
import { FLAGS, flag } from "@releases/lib/flags";
import { logEvent } from "@releases/lib/log-event";
import { OAUTH_JWT_TOKEN_PREFIX } from "@releases/lib/consumption-ref";
import { isUserApiKeyShaped } from "@buildinternet/releases-core/api-token";
import {
  resolveTierEnforcement,
  resolveAccountFromCache,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitPrincipal,
  type TierLimiters,
} from "@releases/lib/rate-limit-tiers";
import {
  SAFE_METHODS,
  isTrustedProxy,
  resolveAuthIdentity,
  validateAccountCredential,
} from "./auth.js";

/** Advertise the IETF RateLimit-Policy structured field for a tier. */
function policyHeader(name: string, quota: number): string {
  return `"${name}";q=${quota};w=${RATE_LIMIT_WINDOW_SECONDS}`;
}

type Limiter = { limit(options: { key: string }): Promise<{ success: boolean }> };

async function enforce(
  c: Context<Env>,
  limiter: Limiter,
  key: string,
  policyName: string,
  quota: number,
): Promise<Response | null> {
  const { success } = await limiter.limit({ key });
  c.header("RateLimit-Policy", policyHeader(policyName, quota));
  if (success) return null;
  c.header("RateLimit", `"${policyName}";r=0;t=${RATE_LIMIT_WINDOW_SECONDS}`);
  c.header("Retry-After", String(RATE_LIMIT_WINDOW_SECONDS));
  return c.json(
    { error: "rate_limited", message: "Too many requests. Please retry shortly." },
    429,
  );
}

function bearer(c: Context<Env>): string {
  const h = c.req.header("Authorization") ?? "";
  return h.startsWith("Bearer ") ? h.slice(7) : "";
}

/**
 * Classify the caller into a rate-limit tier. Root + trusted proxy are exempt.
 * `relk_` machine tokens → machine rung (keyed on tokenId). OAuth-JWT users
 * (`oauth_…`) and valid `relu_` keys → account rung (keyed on userId). Everything
 * else → anonymous (keyed on IP). The `relu_` path verifies behind the KV cache
 * so a junk string can't mint an account bucket (it caches invalid → IP rung).
 */
async function classifyPrincipal(c: Context<Env>): Promise<RateLimitPrincipal> {
  if (await isTrustedProxy(c)) return { tier: "exempt" };
  const identity = await resolveAuthIdentity(c);
  if (identity?.kind === "root") return { tier: "exempt" };
  if (identity?.kind === "token") {
    const id = identity.tokenId;
    if (id.startsWith(OAUTH_JWT_TOKEN_PREFIX)) return { tier: "account", bucketKey: id };
    if (isUserApiKeyShaped(id)) return { tier: "account", bucketKey: id };
    return { tier: "machine", bucketKey: id };
  }
  // Identity unresolved. A relu_ key is read as anonymous by resolveAuthIdentity
  // (meter-skip), so verify it here for tiering, behind the KV cache.
  const presented = bearer(c);
  if (presented && isUserApiKeyShaped(presented)) {
    const account = await resolveAccountFromCache({
      credential: presented,
      cache: c.env.CREDENTIAL_CACHE,
      validate: () => validateAccountCredential(c, presented),
    });
    if (account.valid && account.userId) return { tier: "account", bucketKey: account.userId };
  }
  const ip = c.req.header("cf-connecting-ip") ?? "unknown";
  return { tier: "anonymous", bucketKey: ip };
}

/**
 * Rate limiting for reads. Three rungs on Cloudflare's native limiter: anonymous
 * (per-IP, 120), account (per-userId, 300), machine (per-token, 600). Root + the
 * trusted web proxy are exempt. Each rung is independently gated by its binding +
 * kill switch; with all off this is a no-op.
 */
export const publicRateLimitMiddleware: MiddlewareHandler<Env> = async (c, next) => {
  if (!SAFE_METHODS.has(c.req.method)) return next();

  const ipEnabled = await flag(c.env.FLAGS, c.env.RATE_LIMIT_ENABLED, FLAGS.rateLimitEnabled);
  const limiters: TierLimiters = {
    anonymous: ipEnabled ? c.env.PUBLIC_RATE_LIMITER : undefined,
    account: ipEnabled ? c.env.USER_RATE_LIMITER : undefined,
    machine: c.env.TOKEN_RATE_LIMIT_ENABLED === "true" ? c.env.TOKEN_RATE_LIMITER : undefined,
  };
  if (!limiters.anonymous && !limiters.account && !limiters.machine) return next();

  const principal = await classifyPrincipal(c);
  const plan = resolveTierEnforcement(principal, limiters);
  if (!plan) return next(); // exempt
  if (!plan.limiter) return next(); // this rung disabled → allow

  const rejected = await enforce(c, plan.limiter, plan.key, plan.policyName, plan.quota);
  // Decision-event emission is added in Task 6.
  if (rejected) {
    logEvent("warn", {
      component: "rate-limit",
      event: `${plan.tier}-throttled`,
      bucketKey: plan.tier === "anonymous" ? plan.key : undefined,
    });
    return rejected;
  }
  return next();
};
```

Note: this preserves the existing early-out (all rungs off → `next()`) and the root/proxy exemptions. The `apiRouteFamily` import is used in Task 6; leave it imported.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/api/rate-limit.test.ts`
Expected: PASS — all prior cases plus the 4 account-tier cases.

- [ ] **Step 5: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: no errors. (`apiRouteFamily` is intentionally NOT imported yet — Task 6 adds it with its first use, so this task has no unused import.)

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/middleware/rate-limit.ts tests/api/rate-limit.test.ts
git commit -m "feat(api): enforce account rate-limit rung (300/min) for authenticated users"
```

---

## Task 6: Emit the admin-queryable consumption decision event (API)

**Files:**

- Modify: `workers/api/src/middleware/rate-limit.ts`
- Test: `tests/api/rate-limit.test.ts`

**Interfaces:**

- Consumes: `rateLimitConsumerRef`, `rateLimitDecisionPayload` from `@releases/lib/rate-limit-tiers`; `logEvent`; `apiRouteFamily`.
- Produces: one `logEvent("info", rate-limit/decision)` per limited request (always for account/machine + throttles; sampled for anonymous-allowed).

- [ ] **Step 1: Write the failing test**

Append to `tests/api/rate-limit.test.ts`:

```typescript
import { spyOn } from "bun:test";

describe("consumption decision event", () => {
  it("emits a decision event for an allowed account request with tier + hashed consumerRef", async () => {
    const logs: any[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: string) => {
      try {
        logs.push(JSON.parse(line));
      } catch {
        /* non-JSON line */
      }
    });
    const account = mockLimiter([true]);
    const app = createApp();
    await app.request(
      "/test",
      { headers: { authorization: "Bearer relu_live", "cf-connecting-ip": "9.9.9.9" } },
      {
        RATE_LIMIT_ENABLED: "true",
        USER_API_KEYS_ENABLED: "true",
        USER_RATE_LIMITER: account,
        betterAuth: fakeBetterAuth({ valid: true, userId: "user_77" }),
      },
    );
    spy.mockRestore();
    const decision = logs.find((l) => l.component === "rate-limit" && l.event === "decision");
    expect(decision).toBeDefined();
    expect(decision.tier).toBe("account");
    expect(decision.rateLimited).toBe(false);
    expect(decision.surface).toBe("api");
    expect(decision.consumerRef).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(decision)).not.toContain("user_77"); // hashed, not raw
  });

  it("always emits a decision event when a request is throttled", async () => {
    const logs: any[] = [];
    const spy = spyOn(console, "log").mockImplementation((line: string) => {
      try {
        logs.push(JSON.parse(line));
      } catch {
        /* */
      }
    });
    const account = mockLimiter([false]); // over quota
    const app = createApp();
    await app.request(
      "/test",
      { headers: { authorization: "Bearer relu_live", "cf-connecting-ip": "9.9.9.9" } },
      {
        RATE_LIMIT_ENABLED: "true",
        USER_API_KEYS_ENABLED: "true",
        USER_RATE_LIMITER: account,
        betterAuth: fakeBetterAuth({ valid: true, userId: "user_77" }),
      },
    );
    spy.mockRestore();
    const decision = logs.find((l) => l.component === "rate-limit" && l.event === "decision");
    expect(decision?.rateLimited).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/api/rate-limit.test.ts`
Expected: FAIL — no `rate-limit`/`decision` event is emitted yet.

- [ ] **Step 3: Add the decision emit**

In `workers/api/src/middleware/rate-limit.ts`, update the imports and the enforcement tail. Update the shared-module import:

```typescript
import {
  resolveTierEnforcement,
  resolveAccountFromCache,
  rateLimitConsumerRef,
  rateLimitDecisionPayload,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitPrincipal,
  type RateLimitTier,
  type TierLimiters,
} from "@releases/lib/rate-limit-tiers";
```

And add `apiRouteFamily` to the existing `./auth.js` import (it gets its first use in `emitDecision` below):

```typescript
import {
  SAFE_METHODS,
  isTrustedProxy,
  resolveAuthIdentity,
  validateAccountCredential,
  apiRouteFamily,
} from "./auth.js";
```

Add a sampling helper near the top of the file:

```typescript
/** Anonymous-allowed events are sampled to bound public-read log volume. */
const ANON_SAMPLE_RATE = 0.05;
function sampled(rate: number): boolean {
  const buf = new Uint8Array(1);
  crypto.getRandomValues(buf);
  return buf[0] / 256 < rate;
}

/** Emit the consumption decision event (always for account/machine + throttles). */
async function emitDecision(
  c: Context<Env>,
  tier: RateLimitTier,
  bucketKey: string,
  rateLimited: boolean,
): Promise<void> {
  if (tier === "anonymous" && !rateLimited && !sampled(ANON_SAMPLE_RATE)) return;
  const payload = rateLimitDecisionPayload({
    surface: "api",
    tier,
    rateLimited,
    consumerRef: await rateLimitConsumerRef(bucketKey),
    operation: `${c.req.method} ${apiRouteFamily(c.req.path)}`,
  });
  logEvent("info", payload);
}
```

Replace the enforcement tail of `publicRateLimitMiddleware` (everything after `const plan = …; if (!plan) return next(); if (!plan.limiter) return next();`) with:

```typescript
const { success } = await plan.limiter.limit({ key: plan.key });
c.header("RateLimit-Policy", policyHeader(plan.policyName, plan.quota));
const emit = emitDecision(c, plan.tier, plan.key, !success);
try {
  c.executionCtx.waitUntil(emit);
} catch {
  void emit; // no executionCtx in tests — await below keeps the assertion deterministic
  await emit;
}
if (success) return next();
c.header("RateLimit", `"${plan.policyName}";r=0;t=${RATE_LIMIT_WINDOW_SECONDS}`);
c.header("Retry-After", String(RATE_LIMIT_WINDOW_SECONDS));
return c.json({ error: "rate_limited", message: "Too many requests. Please retry shortly." }, 429);
```

Remove the now-unused `enforce()` helper and the prior `logEvent("warn", …)` throttle blocks (the decision event supersedes them; throttles are captured via `rateLimited: true`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/api/rate-limit.test.ts`
Expected: PASS — including the 2 decision-event cases. The account/machine cases from Task 5 still pass (those don't assert on logs).

- [ ] **Step 5: Type-check**

Run: `cd workers/api && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/middleware/rate-limit.ts tests/api/rate-limit.test.ts
git commit -m "feat(api): emit per-principal rate-limit consumption decision events"
```

---

## Task 7: MCP worker — tier enforcement

**Files:**

- Create: `workers/mcp/src/rate-limit.ts`
- Test: `workers/mcp/src/rate-limit.test.ts`
- Modify: `workers/mcp/src/index.ts` (call enforcement in `handle()`)
- Modify: `workers/mcp/wrangler.jsonc` (bindings)

**Note (why MCP has no credential cache):** `handle()` already calls `resolveMcpAuth()` and obtains a fully-resolved `McpIdentity` _before_ enforcement. There is no "verified-too-late" gap, so MCP maps the resolved identity straight to a tier with no KV verify, and the `CREDENTIAL_CACHE` binding is not bound on the MCP worker.

**Account bucketing contract:** the account rung buckets on the **userId** (per the spec — the account, not the credential, is the unit). OAuth principals bucket on the `<sub>` (the `oauth_` prefix is stripped by `accountBucketKey`), and the API `relu_` path buckets on the resolved `userId`, so a user's OAuth and API-key traffic share one 300/min budget. **MCP `relu_` keys now bucket per-account too (#1729):** `GET /v1/tokens/me` exposes the owning `userId` (a new optional wire field, sourced from `apikey.referenceId`), and `resolveUserKey` threads it onto `McpIdentity.userId` so `mcpPrincipal` keys the account rung on the userId rather than the key id. When an older API omits `userId`, `mcpPrincipal` falls back to `accountBucketKey(tokenId)` — i.e. per-key bucketing, the pre-#1729 behavior — so the change is backward-safe.

**Interfaces:**

- Consumes: `McpIdentity` (from `./auth`), `resolveTierEnforcement`, `rateLimitConsumerRef`, `rateLimitDecisionPayload`, `TierLimiters`, `RateLimitPrincipal` from `@releases/lib/rate-limit-tiers`; `isUserApiKeyShaped`, `OAUTH_JWT_TOKEN_PREFIX`; `logEvent`.
- Produces: `function mcpPrincipal(identity: McpIdentity, ip: string): RateLimitPrincipal`; `function enforceMcpRateLimit(request: Request, env: Env, identity: McpIdentity, ctx: ExecutionContext): Promise<Response | null>` (returns a 429 `Response` when throttled, else `null`).

- [ ] **Step 1: Write the failing test**

Create `workers/mcp/src/rate-limit.test.ts`:

```typescript
import { describe, it, expect } from "bun:test";
import { mcpPrincipal } from "./rate-limit";

const anon = {
  kind: "anonymous",
  scopes: ["read"],
  tokenId: null,
  token: null,
  userToken: null,
} as const;

describe("mcpPrincipal", () => {
  it("maps anonymous identity to the IP bucket", () => {
    expect(mcpPrincipal(anon, "1.1.1.1")).toEqual({ tier: "anonymous", bucketKey: "1.1.1.1" });
  });

  it("maps an OAuth-JWT user token to the account tier", () => {
    const id = {
      kind: "token",
      scopes: ["read"],
      tokenId: "oauth_user_9",
      token: null,
      userToken: "jwt",
    } as const;
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "account", bucketKey: "oauth_user_9" });
  });

  it("maps a relu_ user key to the account tier, bucketed on the owning userId (#1729)", () => {
    const id = {
      kind: "token",
      scopes: ["read"],
      tokenId: "relu_key_3",
      token: null,
      userToken: "relu_x",
      userId: "user_42",
    } as const;
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "account", bucketKey: "user_42" });
  });

  it("maps a relk_ machine token to the machine tier", () => {
    const id = {
      kind: "token",
      scopes: ["read"],
      tokenId: "tok_1",
      token: "relk_x",
      userToken: null,
    } as const;
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "machine", bucketKey: "tok_1" });
  });

  it("maps root to exempt", () => {
    const id = {
      kind: "root",
      scopes: ["*"],
      tokenId: null,
      token: null,
      userToken: null,
    } as const;
    expect(mcpPrincipal(id, "1.1.1.1")).toEqual({ tier: "exempt" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test workers/mcp/src/rate-limit.test.ts`
Expected: FAIL — `./rate-limit` does not exist.

- [ ] **Step 3: Implement the MCP rate-limit module**

Create `workers/mcp/src/rate-limit.ts`:

```typescript
import { logEvent } from "@releases/lib/log-event";
import { flag, FLAGS } from "@releases/lib/flags";
import { OAUTH_JWT_TOKEN_PREFIX } from "@releases/lib/consumption-ref";
import { isUserApiKeyShaped } from "@buildinternet/releases-core/api-token";
import {
  resolveTierEnforcement,
  rateLimitConsumerRef,
  rateLimitDecisionPayload,
  RATE_LIMIT_WINDOW_SECONDS,
  type RateLimitPrincipal,
  type TierLimiters,
} from "@releases/lib/rate-limit-tiers";
import type { McpIdentity } from "./auth";
import type { Env } from "./index"; // adjust to the worker's Env export

/** Classify a resolved MCP identity into a rate-limit tier. */
export function mcpPrincipal(identity: McpIdentity, ip: string): RateLimitPrincipal {
  if (identity.kind === "root") return { tier: "exempt" };
  if (identity.kind === "token") {
    const id = identity.tokenId;
    if (id.startsWith(OAUTH_JWT_TOKEN_PREFIX)) return { tier: "account", bucketKey: id };
    if (isUserApiKeyShaped(identity.userToken ?? "") || isUserApiKeyShaped(id))
      return { tier: "account", bucketKey: id };
    return { tier: "machine", bucketKey: id };
  }
  return { tier: "anonymous", bucketKey: ip };
}

/**
 * Enforce the three-rung limiter for an MCP request. Returns a 429 Response when
 * over quota, else null. No credential cache — the identity is already resolved
 * by resolveMcpAuth before this runs.
 */
export async function enforceMcpRateLimit(
  request: Request,
  env: Env,
  identity: McpIdentity,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const ipEnabled = await flag(env.FLAGS, env.RATE_LIMIT_ENABLED, FLAGS.rateLimitEnabled);
  const limiters: TierLimiters = {
    anonymous: ipEnabled ? env.PUBLIC_RATE_LIMITER : undefined,
    account: ipEnabled ? env.USER_RATE_LIMITER : undefined,
    machine: env.TOKEN_RATE_LIMIT_ENABLED === "true" ? env.TOKEN_RATE_LIMITER : undefined,
  };
  if (!limiters.anonymous && !limiters.account && !limiters.machine) return null;

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const plan = resolveTierEnforcement(mcpPrincipal(identity, ip), limiters);
  if (!plan || !plan.limiter) return null;

  const { success } = await plan.limiter.limit({ key: plan.key });
  const emit = (async () => {
    logEvent(
      "info",
      rateLimitDecisionPayload({
        surface: "mcp",
        tier: plan.tier,
        rateLimited: !success,
        consumerRef: await rateLimitConsumerRef(plan.key),
        operation: "mcp",
      }),
    );
  })();
  try {
    ctx.waitUntil(emit);
  } catch {
    await emit;
  }
  if (success) return null;
  return new Response(
    JSON.stringify({ error: "rate_limited", message: "Too many requests. Please retry shortly." }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        "Retry-After": String(RATE_LIMIT_WINDOW_SECONDS),
        "RateLimit-Policy": `"${plan.policyName}";q=${plan.quota};w=${RATE_LIMIT_WINDOW_SECONDS}`,
      },
    },
  );
}
```

Implementer note: confirm the `Env` import path and that `Env` exposes `PUBLIC_RATE_LIMITER`, `USER_RATE_LIMITER`, `TOKEN_RATE_LIMITER`, `RATE_LIMIT_ENABLED`, `TOKEN_RATE_LIMIT_ENABLED`, `FLAGS`. If the MCP `Env` type lacks these, add them mirroring the API worker's structural limiter type. Add them in this step.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test workers/mcp/src/rate-limit.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Wire it into `handle()`**

In `workers/mcp/src/index.ts`, after `const { identity } = auth;` and before `createServer(...)`, add:

```typescript
const limited = await enforceMcpRateLimit(request, env, identity, ctx);
if (limited) return limited;
```

Add the import at the top: `import { enforceMcpRateLimit } from "./rate-limit";`

- [ ] **Step 6: Add the MCP bindings**

In `workers/mcp/wrangler.jsonc`, add an `unsafe` block (the file has none today) and the `CREDENTIAL_CACHE` KV (after the existing `EMBED_CACHE` entry):

```jsonc
  "unsafe": {
    "bindings": [
      { "name": "PUBLIC_RATE_LIMITER", "type": "ratelimit", "namespace_id": "2001", "simple": { "limit": 120, "period": 60 } },
      { "name": "USER_RATE_LIMITER", "type": "ratelimit", "namespace_id": "2006", "simple": { "limit": 300, "period": 60 } },
      { "name": "TOKEN_RATE_LIMITER", "type": "ratelimit", "namespace_id": "2002", "simple": { "limit": 600, "period": 60 } },
    ],
  },
```

```jsonc
    {
      "binding": "CREDENTIAL_CACHE",
      "id": "REPLACE_WITH_CREDENTIAL_CACHE_KV_ID",
      "preview_id": "REPLACE_WITH_CREDENTIAL_CACHE_PREVIEW_ID",
    },
```

Add `RATE_LIMIT_ENABLED` and `TOKEN_RATE_LIMIT_ENABLED` to the MCP `vars` block to mirror the API defaults:

```jsonc
    "RATE_LIMIT_ENABLED": "false",
    "TOKEN_RATE_LIMIT_ENABLED": "true",
```

Namespace ids `2001/2002/2006` keep MCP's limiter buckets separate from the API worker's `100x` ids. These are placeholders an operator confirms/assigns before deploy.

- [ ] **Step 7: Type-check the MCP worker**

Run: `cd workers/mcp && npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add workers/mcp/src/rate-limit.ts workers/mcp/src/rate-limit.test.ts workers/mcp/src/index.ts workers/mcp/wrangler.jsonc
git commit -m "feat(mcp): three-rung rate limiting + consumption decision events"
```

---

## Task 8: Full regression + docs pointer

**Files:**

- Modify: `docs/architecture/remote-mode.md` (one line under the rate-limiting section)
- Modify: `AGENTS.md` (one conventions line)

- [ ] **Step 1: Run the full affected test surface**

Run: `bun test packages/lib/src/rate-limit-tiers.test.ts && bun test tests/api/rate-limit.test.ts && bun test workers/mcp/src/rate-limit.test.ts`
Expected: all PASS.

- [ ] **Step 2: Type-check root + both workers**

Run: `npx tsc --noEmit && (cd workers/api && npx tsc --noEmit) && (cd workers/mcp && npx tsc --noEmit)`
Expected: no errors.

- [ ] **Step 3: Lint + format**

Run: `bun run lint && bun run format:check`
Expected: clean (run `bun run format` if the check flags the new files).

- [ ] **Step 4: Add docs**

In `docs/architecture/remote-mode.md`, under the rate-limiting section, add:

```markdown
- **Tier ladder:** anonymous per-IP (120/min, `PUBLIC_RATE_LIMITER`), authenticated free account per-userId (300/min, `USER_RATE_LIMITER` — `relu_` keys + OAuth-JWT users), machine per-token (600/min, `TOKEN_RATE_LIMITER`). Account-tier `relu_` verification is cached in `CREDENTIAL_CACHE` (~60s). Every limited request emits a `rate-limit`/`decision` log event (hashed `consumerRef` + `tier` + `rateLimited`) — the admin-queryable consumption stream in Axiom. Shared tier logic: `@releases/lib/rate-limit-tiers`.
```

In `AGENTS.md`, under Conventions, add one line:

```markdown
- **Rate-limit tiers**: three rungs on CF native limiters — anonymous-IP 120 / account-userId 300 / machine-token 600 — selected by the shared `@releases/lib/rate-limit-tiers`; account-tier `relu_` verify is `CREDENTIAL_CACHE`-backed; consumption is the `rate-limit`/`decision` Axiom event. Counters never move to KV/D1. See [remote-mode.md](docs/architecture/remote-mode.md).
```

- [ ] **Step 5: Commit**

```bash
git add docs/architecture/remote-mode.md AGENTS.md
git commit -m "docs: tiered rate-limit ladder + consumption stream"
```

---

## Deploy-time follow-ups (NOT code tasks — operator)

- ~~Provision the `CREDENTIAL_CACHE` KV namespace~~ **DONE on this branch.** A dedicated namespace was provisioned in the Build Internet account (prod `bae0fa6a594448d483176fe90a9a0479`, preview `ac4b692c975a4d9382a847e968243107`) and the binding wired into `workers/api/wrangler.jsonc` only — the API worker is the sole consumer. The MCP worker resolves identity before enforcement, so it has no credential-cache need and intentionally does NOT bind it.
- Rollout: the account + anonymous rungs are gated by `rate-limit-enabled`/`RATE_LIMIT_ENABLED` (default OFF). To begin enforcing, flip the flag in BOTH Flagship apps (`releases-platform{,-staging}`). The machine rung is already on.
- The `relu_` account tier is dark until `user-api-keys-enabled` rolls out; OAuth-JWT users get the 300 tier immediately once `rate-limit-enabled` is on.
