# Cloudflare Flagship Feature-Flag Migration (Tier 1) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the 21 Tier-1 boolean operational flags off plaintext `wrangler.jsonc` vars onto Cloudflare Flagship, so they can be flipped at runtime without a redeploy, while keeping the wrangler var as an automatic fallback.

**Architecture:** One worker-safe helper (`@releases/lib/flags`) holds a flag registry (Flagship key ↔ env-var name ↔ hardcoded default) and a single `flag()` evaluator. Each read site becomes `await flag(env.FLAGS, env.SOME_VAR, FLAGS.someFlag)`: Flagship value if the flag is set → else the wrangler var → else the constant; any eval error collapses to the var. The `flagship` binding is wired in prod + `[env.staging]` (two-app model). Landing the helper + bindings is behaviour-neutral — nothing changes until a flag is created in a Flagship app.

**Tech Stack:** Bun, TypeScript (strict), Cloudflare Workers + Hono, Drizzle, the native Flagship Workers binding (`getBooleanValue`).

**Design spec:** [docs/superpowers/specs/2026-05-30-flagship-feature-flags-design.md](../specs/2026-05-30-flagship-feature-flags-design.md)

**Prod app_id:** `2cf02390-e39a-477a-91c1-571d07b987ef` (`releases-platform`)
**Staging app_id:** `548a95f1-4f8c-402d-8aa2-1b861523d377` (`releases-platform-staging`)

---

## Key refinements vs. the spec (read first)

1. **`flag()` takes the var _value_, not the env object.** Worker `Env`/`Bindings` interfaces hold non-string bindings (`DB`, KV, `FLAGS`), so they are not assignable to `Record<string, string | undefined>`. Passing the typed field (`c.env.CACHE_DISABLED`) avoids a dynamic index into a typed interface and keeps everything type-safe. The registry's `env` field stays for documentation + the registry self-test.
2. **No batch middleware.** Each hot per-request middleware reads a _distinct_ flag, so direct per-site eval is already exactly one eval per flag per request. The spec's `c.set("flags", …)` batch would add an ordering dependency for no eval savings — dropped.
3. **`SEARCH_QUERY_LOG_DISABLED` resolves inside `log-search.ts`** by adding `FLAGS?` to `SearchLogEnv` (callers already pass the whole worker env, so `c.env.FLAGS` flows through with zero caller changes) — cleaner than threading a boolean through five call sites.
4. **Forwarded flags** (`MEDIA_R2_UPLOAD_ENABLED`, `SCRAPE_CHANGE_DETECT_ENABLED`, `WEB_BOT_AUTH_ENABLED`, `EXTRACT_TOOLLOOP_ENABLED`): the env-shaped carrier types (`FetchOneEnv`, `IndexNowEnv`, `SearchLogEnv`) gain `FLAGS?`, and the object-builders that construct them also pass `FLAGS: env.FLAGS`, so the deep decision site can call `flag(env.FLAGS, env.SOME_VAR, …)`.

---

## File map

**Create**

- `packages/lib/src/flags.ts` — `FlagshipBinding` interface, `FlagDef`, `FLAGS` registry, `flag()`.
- `packages/lib/src/flags.test.ts` — unit tests for `flag()` + registry invariants.

**Modify — packaging / types / config (Task 2)**

- `packages/lib/package.json` — add `"./flags"` export.
- `workers/api/src/index.ts` — add `FLAGS?` to `Bindings`.
- `workers/mcp/src/mcp-agent.ts` — add `FLAGS?` to `Env`.
- `workers/discovery/src/types.ts` — add `FLAGS?` to `Env`.
- `workers/api/src/cron/poll-fetch.ts` — add `FLAGS?` to `FetchOneEnv` (and `IndexNowEnv` if separate).
- `packages/search/src/log-search.ts` — add `FLAGS?` to `SearchLogEnv`.
- `workers/api/wrangler.jsonc`, `workers/mcp/wrangler.jsonc`, `workers/discovery/wrangler.jsonc` — add `flagship` binding (prod base + `[env.staging]`).

**Modify — call sites (Tasks 3–6):** listed per task.

**Modify — docs (Task 7):** `AGENTS.md`.

---

## Task 1: Flags helper + registry (TDD)

**Files:**

- Create: `packages/lib/src/flags.ts`
- Test: `packages/lib/src/flags.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/lib/src/flags.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { FLAGS, flag, type FlagshipBinding } from "./flags.ts";

/** Stub binding that always returns `value`, ignoring the default. */
function bindingReturning(value: boolean): FlagshipBinding {
  return { getBooleanValue: async () => value };
}

/** Stub binding that throws on eval. */
const throwingBinding: FlagshipBinding = {
  getBooleanValue: async () => {
    throw new Error("flagship down");
  },
};

describe("flag()", () => {
  it("returns the Flagship value when the binding yields one", async () => {
    // Flagship says true even though the var is unset and default is false.
    expect(await flag(bindingReturning(true), undefined, FLAGS.pollFetchUseWorkflow)).toBe(true);
    expect(await flag(bindingReturning(false), "true", FLAGS.pollFetchUseWorkflow)).toBe(false);
  });

  it("falls back to the var value when the binding is absent", async () => {
    expect(await flag(undefined, "true", FLAGS.pollFetchUseWorkflow)).toBe(true);
    expect(await flag(undefined, "false", FLAGS.pollFetchUseWorkflow)).toBe(false);
  });

  it("falls back to the hardcoded default when both binding and var are absent", async () => {
    expect(await flag(undefined, undefined, FLAGS.pollFetchUseWorkflow)).toBe(false);
  });

  it("collapses an eval error to the var/default fallback", async () => {
    expect(await flag(throwingBinding, "true", FLAGS.pollFetchUseWorkflow)).toBe(true);
    expect(await flag(throwingBinding, undefined, FLAGS.pollFetchUseWorkflow)).toBe(false);
  });

  it('treats any non-"true" string as false (var semantics)', async () => {
    expect(await flag(undefined, "1", FLAGS.pollFetchUseWorkflow)).toBe(false);
    expect(await flag(undefined, "", FLAGS.pollFetchUseWorkflow)).toBe(false);
  });
});

describe("FLAGS registry", () => {
  const defs = Object.values(FLAGS);

  it("has unique, kebab-case keys", () => {
    const keys = defs.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const k of keys) expect(k).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("has unique env names in SCREAMING_SNAKE_CASE", () => {
    const envs = defs.map((d) => d.env);
    expect(new Set(envs).size).toBe(envs.length);
    for (const e of envs) expect(e).toMatch(/^[A-Z0-9]+(_[A-Z0-9]+)*$/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/lib/src/flags.test.ts`
Expected: FAIL — `Cannot find module './flags.ts'`.

- [ ] **Step 3: Write the implementation**

Create `packages/lib/src/flags.ts`:

```ts
/**
 * Worker-safe feature-flag helper backed by Cloudflare Flagship, with a layered
 * fallback to the existing wrangler vars. No `fs`/Node imports — safe in workers.
 *
 * Evaluation order: Flagship value (if the flag exists in the app) → the wrangler
 * var → the hardcoded default. Any binding-missing or eval error collapses to the
 * var/default, so a Flagship outage is strictly "behaves like today", never worse.
 *
 * The helper takes the var *value* (a typed `string | undefined` field) rather
 * than the whole env, because worker `Env` interfaces hold non-string bindings
 * and are not assignable to a string-record.
 */

/** Minimal shape of the native Flagship Workers binding (avoids an npm dep). */
export interface FlagshipBinding {
  getBooleanValue(
    key: string,
    defaultValue: boolean,
    context?: Record<string, unknown>,
  ): Promise<boolean>;
}

export interface FlagDef {
  /** Flagship flag key (kebab-case). MUST exist identically in BOTH apps. */
  readonly key: string;
  /** wrangler-var name that supplies the fallback value (documentation + tests). */
  readonly env: string;
  /** Hardcoded last-resort default when neither Flagship nor the var is set. */
  readonly default: boolean;
}

/**
 * Registry of every Tier-1 flag. Single source of truth: the same `key`s must be
 * created in both the prod and staging Flagship apps before a flag is relied on.
 */
export const FLAGS = {
  pollFetchUseWorkflow: {
    key: "poll-fetch-use-workflow",
    env: "POLL_FETCH_USE_WORKFLOW",
    default: false,
  },
  scrapeAgentUseWorkflow: {
    key: "scrape-agent-use-workflow",
    env: "SCRAPE_AGENT_USE_WORKFLOW",
    default: false,
  },
  onboardUseWorkflow: { key: "onboard-use-workflow", env: "ONBOARD_USE_WORKFLOW", default: false },
  mediaR2UploadEnabled: {
    key: "media-r2-upload-enabled",
    env: "MEDIA_R2_UPLOAD_ENABLED",
    default: false,
  },
  feedEnrichEnabled: { key: "feed-enrich-enabled", env: "FEED_ENRICH_ENABLED", default: false },
  scrapeChangeDetectEnabled: {
    key: "scrape-change-detect-enabled",
    env: "SCRAPE_CHANGE_DETECT_ENABLED",
    default: false,
  },
  webBotAuthEnabled: { key: "web-bot-auth-enabled", env: "WEB_BOT_AUTH_ENABLED", default: false },
  invalidationEnabled: { key: "invalidation-enabled", env: "INVALIDATION_ENABLED", default: false },
  indexnowEnabled: { key: "indexnow-enabled", env: "INDEXNOW_ENABLED", default: false },
  enableAiTools: { key: "enable-ai-tools", env: "ENABLE_AI_TOOLS", default: false },
  maSessionsDisabled: { key: "ma-sessions-disabled", env: "MA_SESSIONS_DISABLED", default: false },
  batchSummarizeEnabled: {
    key: "batch-summarize-enabled",
    env: "BATCH_SUMMARIZE_ENABLED",
    default: false,
  },
  batchOverviewEnabled: {
    key: "batch-overview-enabled",
    env: "BATCH_OVERVIEW_ENABLED",
    default: false,
  },
  recommendationsDisabled: {
    key: "recommendations-disabled",
    env: "RECOMMENDATIONS_DISABLED",
    default: false,
  },
  feedbackDisabled: { key: "feedback-disabled", env: "FEEDBACK_DISABLED", default: false },
  rateLimitEnabled: { key: "rate-limit-enabled", env: "RATE_LIMIT_ENABLED", default: false },
  searchQueryLogDisabled: {
    key: "search-query-log-disabled",
    env: "SEARCH_QUERY_LOG_DISABLED",
    default: false,
  },
  apiTokensDisabled: { key: "api-tokens-disabled", env: "API_TOKENS_DISABLED", default: false },
  cacheDisabled: { key: "cache-disabled", env: "CACHE_DISABLED", default: false },
  indexingDisabled: { key: "indexing-disabled", env: "INDEXING_DISABLED", default: false },
  extractToolLoopEnabled: {
    key: "extract-toolloop-enabled",
    env: "EXTRACT_TOOLLOOP_ENABLED",
    default: false,
  },
} as const satisfies Record<string, FlagDef>;

/** Layered fallback: var value if set, else the hardcoded default. */
function fallbackOf(varValue: string | undefined, def: FlagDef): boolean {
  return varValue === undefined ? def.default : varValue === "true";
}

/**
 * Evaluate a flag. `binding` is `env.FLAGS` (may be undefined outside prod/staging
 * or in tests); `varValue` is the matching wrangler var (e.g. `env.CACHE_DISABLED`).
 * Never throws.
 */
export async function flag(
  binding: FlagshipBinding | undefined,
  varValue: string | undefined,
  def: FlagDef,
): Promise<boolean> {
  const fb = fallbackOf(varValue, def);
  if (!binding) return fb;
  try {
    return await binding.getBooleanValue(def.key, fb, {});
  } catch {
    return fb;
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/lib/src/flags.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Type-check the package**

Run: `cd packages/lib && npx tsc --noEmit && cd ../..`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/lib/src/flags.ts packages/lib/src/flags.test.ts
git commit -m "feat(flags): worker-safe Flagship helper + Tier-1 registry"
```

---

## Task 2: Export, binding types, and wrangler wiring (behaviour-neutral)

No read sites change here, so behaviour is identical until a flag is created in a Flagship app. This task only makes `env.FLAGS` available and typed.

**Files:**

- Modify: `packages/lib/package.json`
- Modify: `workers/api/src/index.ts` (Bindings)
- Modify: `workers/mcp/src/mcp-agent.ts` (Env)
- Modify: `workers/discovery/src/types.ts` (Env)
- Modify: `workers/api/src/cron/poll-fetch.ts` (`FetchOneEnv` / `IndexNowEnv`)
- Modify: `packages/search/src/log-search.ts` (`SearchLogEnv`)
- Modify: `workers/api/wrangler.jsonc`, `workers/mcp/wrangler.jsonc`, `workers/discovery/wrangler.jsonc`

- [ ] **Step 1: Add the package export**

In `packages/lib/package.json`, add the `"./flags"` line to `exports` (alphabetical, after `"./errors"`):

```json
    "./errors": "./src/errors.ts",
    "./flags": "./src/flags.ts",
    "./legacy-env": "./src/legacy-env.ts",
```

- [ ] **Step 2: Add `FLAGS?` to the API worker Bindings**

In `workers/api/src/index.ts`, add an import near the other `@releases/lib` imports:

```ts
import type { FlagshipBinding } from "@releases/lib/flags";
```

Inside the `Bindings: {` block (starts at `workers/api/src/index.ts:48`), add:

```ts
    // Cloudflare Flagship binding (prod + staging apps; absent in local dev /
    // tests → flag() falls back to the wrangler var). See @releases/lib/flags.
    FLAGS?: FlagshipBinding;
```

- [ ] **Step 3: Add `FLAGS?` to the MCP worker Env**

In `workers/mcp/src/mcp-agent.ts`, add the import near the top imports:

```ts
import type { FlagshipBinding } from "@releases/lib/flags";
```

Inside `export interface Env {` (at `workers/mcp/src/mcp-agent.ts:78`), add:

```ts
  FLAGS?: FlagshipBinding;
```

- [ ] **Step 4: Add `FLAGS?` to the discovery worker Env**

In `workers/discovery/src/types.ts`, add the import near the top:

```ts
import type { FlagshipBinding } from "@releases/lib/flags";
```

Inside `export interface Env {` (at `workers/discovery/src/types.ts:55`), add:

```ts
  FLAGS?: FlagshipBinding;
```

- [ ] **Step 5: Add `FLAGS?` to `FetchOneEnv`**

In `workers/api/src/cron/poll-fetch.ts`, find `export interface FetchOneEnv extends IndexNowEnv, AnthropicEnv {` (at `workers/api/src/cron/poll-fetch.ts:630`). Add an import for the type at the top of the file:

```ts
import type { FlagshipBinding } from "@releases/lib/flags";
```

Add inside the `FetchOneEnv` body:

```ts
  FLAGS?: FlagshipBinding;
```

(Locate `IndexNowEnv`’s definition — `grep -rn "interface IndexNowEnv" workers/api/src`. It is the carrier read by `indexnow.ts`/`blockIndexing` callers in the ingest path. If `IndexNowEnv` is a separate interface, add the same `FLAGS?: FlagshipBinding;` field there too so indexnow decision sites that receive `IndexNowEnv` can read it.)

- [ ] **Step 6: Add `FLAGS?` to `SearchLogEnv`**

In `packages/search/src/log-search.ts`, add the import at the top:

```ts
import type { FlagshipBinding } from "@releases/lib/flags";
```

Inside `export interface SearchLogEnv {` (at `packages/search/src/log-search.ts:29`), add after the `SEARCH_QUERY_LOG_DISABLED` field:

```ts
  /** Flagship binding forwarded by the worker; resolves the kill switch live. */
  FLAGS?: FlagshipBinding;
```

(If `packages/search` does not already depend on `@releases/lib`, add `"@releases/lib": "workspace:*"` to `packages/search/package.json` dependencies and run `bun install`.)

- [ ] **Step 7: Add the `flagship` binding to the API worker**

In `workers/api/wrangler.jsonc`, add a top-level `flagship` array as a sibling of `d1_databases` (near `workers/api/wrangler.jsonc:142`):

```jsonc
  "flagship": [{ "binding": "FLAGS", "app_id": "2cf02390-e39a-477a-91c1-571d07b987ef" }],
```

In the `[env.staging]` block, add a `flagship` override as a sibling of the staging `d1_databases` (near `workers/api/wrangler.jsonc:481`):

```jsonc
      "flagship": [{ "binding": "FLAGS", "app_id": "548a95f1-4f8c-402d-8aa2-1b861523d377" }],
```

- [ ] **Step 8: Add the `flagship` binding to the MCP + discovery workers**

In `workers/mcp/wrangler.jsonc`: add the same prod `flagship` array near the other bindings, and the staging override inside that file's `[env.staging]` block (it has one — see `workers/mcp/wrangler.jsonc:99`).

In `workers/discovery/wrangler.jsonc`: add the prod `flagship` array near the other bindings, and the staging override inside its `[env.staging]` block (near `workers/discovery/wrangler.jsonc:132`).

Use prod `app_id` `2cf02390-e39a-477a-91c1-571d07b987ef` in base, staging `app_id` `548a95f1-4f8c-402d-8aa2-1b861523d377` in `[env.staging]`, both binding name `FLAGS`.

- [ ] **Step 9: Install + type-check everything**

Run:

```bash
bun install
npx tsc --noEmit
cd workers/api && npx tsc --noEmit && cd ../..
cd workers/mcp && npx tsc --noEmit && cd ../..
cd workers/discovery && npx tsc --noEmit && cd ../..
bun test packages/lib/src/flags.test.ts
```

Expected: no type errors; flags test still passes. (`FLAGS?` is optional, so no existing code breaks.)

- [ ] **Step 10: Validate wrangler config parses**

Run: `bunx wrangler deploy --dry-run --config workers/api/wrangler.jsonc 2>&1 | tail -5`
Expected: dry-run completes (binding recognized). Repeat for `workers/mcp` and `workers/discovery`.

- [ ] **Step 11: Commit**

```bash
git add packages/lib/package.json packages/search/package.json workers/api/src/index.ts \
  workers/mcp/src/mcp-agent.ts workers/discovery/src/types.ts \
  workers/api/src/cron/poll-fetch.ts packages/search/src/log-search.ts \
  workers/api/wrangler.jsonc workers/mcp/wrangler.jsonc workers/discovery/wrangler.jsonc bun.lock
git commit -m "feat(flags): wire FLAGS binding + types across api/mcp/discovery"
```

---

## Task 3: Convert API per-request middleware (4 hot flags)

Each middleware is already `async`; convert the `=== "true"` read to an `await flag(...)`. Existing behavior tests guard these; the helper preserves semantics (Flagship absent → var → today’s value).

**Files:**

- Modify: `workers/api/src/middleware/cache.ts`
- Modify: `workers/api/src/middleware/auth.ts:41`
- Modify: `workers/api/src/middleware/rate-limit.ts:65`
- Modify: `workers/api/src/middleware/indexing.ts`

- [ ] **Step 1: Convert `cache.ts` (also fixes the truthy-check bug)**

In `workers/api/src/middleware/cache.ts`, update the local `Env` type (line 3) to include the binding + var, and import the helper:

```ts
import type { MiddlewareHandler } from "hono";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";

type Env = { Bindings: { CACHE_DISABLED?: string; FLAGS?: FlagshipBinding } };
```

Replace the guard at line 26:

```ts
// Skip if caching is disabled (Flagship `cache-disabled` → CACHE_DISABLED var).
if (await flag(c.env.FLAGS, c.env.CACHE_DISABLED, FLAGS.cacheDisabled)) return;
```

Note: this also normalizes the prior `if (c.env.CACHE_DISABLED)` truthy check (`"false"` previously disabled the cache); now only `"true"` (or a Flagship `true`) disables it.

- [ ] **Step 2: Convert `auth.ts` (API)**

In `workers/api/src/middleware/auth.ts`, import the helper near the top:

```ts
import { FLAGS, flag } from "@releases/lib/flags";
```

Replace line 41:

```ts
if (await flag(c.env.FLAGS, c.env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled))
  return { kind: "none", skip: false };
```

- [ ] **Step 3: Convert `rate-limit.ts`**

In `workers/api/src/middleware/rate-limit.ts`, import the helper, then replace line 65:

```ts
const ipLimiter = (await flag(c.env.FLAGS, c.env.RATE_LIMIT_ENABLED, FLAGS.rateLimitEnabled))
  ? c.env.PUBLIC_RATE_LIMITER
  : undefined;
```

(Leave `TOKEN_RATE_LIMIT_ENABLED` on line 64 unchanged — it is not a Tier-1 flag.)

- [ ] **Step 4: Convert `indexing.ts`**

In `workers/api/src/middleware/indexing.ts`, import the helper and extend the inline binding type, then replace the guard at line 16:

```ts
import type { MiddlewareHandler } from "hono";
import { FLAGS, flag, type FlagshipBinding } from "@releases/lib/flags";

export function blockIndexing(): MiddlewareHandler<{
  Bindings: { INDEXING_DISABLED?: string; FLAGS?: FlagshipBinding };
}> {
  return async (c, next) => {
    if (!(await flag(c.env.FLAGS, c.env.INDEXING_DISABLED, FLAGS.indexingDisabled))) {
      await next();
      return;
    }
```

- [ ] **Step 5: Type-check + run the API middleware tests**

Run:

```bash
cd workers/api && npx tsc --noEmit && cd ../..
bun test workers/api
```

Expected: no type errors; existing auth/rate-limit/indexing/cache tests pass (no `FLAGS` binding in tests → var fallback → unchanged behavior).

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/middleware/cache.ts workers/api/src/middleware/auth.ts \
  workers/api/src/middleware/rate-limit.ts workers/api/src/middleware/indexing.ts
git commit -m "feat(flags): route API per-request middleware flags through Flagship"
```

---

## Task 4: Convert MCP worker flags

**Files:**

- Modify: `workers/mcp/src/auth.ts:38`
- Modify: `workers/mcp/src/index.ts:10,67`
- Modify: `workers/mcp/src/mcp-agent.ts:816,871`
- Modify: `packages/search/src/log-search.ts:121,214` (shared; covers MCP + API search logging)

- [ ] **Step 1: Convert MCP `auth.ts`**

In `workers/mcp/src/auth.ts`, import the helper and replace line 38:

```ts
if (await flag(env.FLAGS, env.API_TOKENS_DISABLED, FLAGS.apiTokensDisabled)) return ANONYMOUS;
```

Add at the top: `import { FLAGS, flag } from "@releases/lib/flags";`

- [ ] **Step 2: Convert MCP `index.ts`**

In `workers/mcp/src/index.ts`, import the helper. Replace line 10:

```ts
const noIndex = await flag(env.FLAGS, env.INDEXING_DISABLED, FLAGS.indexingDisabled);
```

Replace the guard at line 67:

```ts
if (!(await flag(env.FLAGS, env.INDEXING_DISABLED, FLAGS.indexingDisabled))) return response;
```

(Both already sit in `async` functions — `handle()` at line 8 and `fetch()` at line 65.)

- [ ] **Step 3: Convert `mcp-agent.ts` AI-tools gate**

In `workers/mcp/src/mcp-agent.ts`, import the helper. The two reads at lines 816 and 871 are in the same registration function. Resolve once near the top of that function and reuse:

```ts
  const aiToolsEnabled = await flag(env.FLAGS, env.ENABLE_AI_TOOLS, FLAGS.enableAiTools);
  // …
  if (aiToolsEnabled) {              // was: if (env.ENABLE_AI_TOOLS === "true")
  // …
  registerPrompts(server, db, { aiTools: aiToolsEnabled }); // was: env.ENABLE_AI_TOOLS === "true"
```

(Confirm the enclosing function is `async`; the registration path in `createServer` is. If a read is in a sync helper, hoist the resolved boolean from the nearest async caller and pass it in.)

- [ ] **Step 4: Resolve the search-log kill switch inside `log-search.ts`**

In `packages/search/src/log-search.ts`, import the helper and replace both guards (lines 121 and 214):

```ts
import { FLAGS, flag } from "@releases/lib/flags";
// …
export async function logSearch(env: SearchLogEnv, input: LogSearchInput): Promise<void> {
  if (await flag(env.FLAGS, env.SEARCH_QUERY_LOG_DISABLED, FLAGS.searchQueryLogDisabled)) return;
  // …
}
// …
export async function logMcpSearch(env: SearchLogEnv, input: McpLogSearchInput): Promise<void> {
  if (await flag(env.FLAGS, env.SEARCH_QUERY_LOG_DISABLED, FLAGS.searchQueryLogDisabled)) return;
  // …
}
```

The five callers (`workers/api/src/routes/search.ts:497,534,687,838` and `workers/mcp/src/mcp-agent.ts:325`) pass the worker env unchanged — `c.env.FLAGS` / `env.FLAGS` now flows through automatically. No caller edits needed.

- [ ] **Step 5: Type-check + test**

Run:

```bash
cd workers/mcp && npx tsc --noEmit && cd ../..
cd packages/search && npx tsc --noEmit && cd ../..
bun test workers/mcp packages/search
```

Expected: no type errors; `mcp-scope-enforcement` / `mcp-lookup-gate` and search-log tests pass (they set `SEARCH_QUERY_LOG_DISABLED: "true"` with no `FLAGS` → var fallback → still disabled).

- [ ] **Step 6: Commit**

```bash
git add workers/mcp/src/auth.ts workers/mcp/src/index.ts workers/mcp/src/mcp-agent.ts \
  packages/search/src/log-search.ts
git commit -m "feat(flags): route MCP + search-log kill switches through Flagship"
```

---

## Task 5: Convert API cold/warm flags (routes, workflows, cron, libs)

All of these run in `async` contexts (route handlers, `step.do` bodies, cron functions, worker libs) and have the worker `Env` (or `FetchOneEnv`, now carrying `FLAGS?`) in scope.

**Files & exact edits:**

- [ ] **Step 1: `workers/api/src/index.ts` scheduled handler**

Import the helper at the top: `import { FLAGS, flag } from "@releases/lib/flags";`

Replace each guard (the `env` here is the worker `Env`):

- Line 579: `if (!(await flag(env.FLAGS, env.BATCH_SUMMARIZE_ENABLED, FLAGS.batchSummarizeEnabled))) {`
- Line 631: `if (await flag(env.FLAGS, env.SCRAPE_AGENT_USE_WORKFLOW, FLAGS.scrapeAgentUseWorkflow)) {`
- Line 703: `if (await flag(env.FLAGS, env.POLL_FETCH_USE_WORKFLOW, FLAGS.pollFetchUseWorkflow)) {`
- Line 807: `const changeDetectEnabled = await flag(env.FLAGS, env.SCRAPE_CHANGE_DETECT_ENABLED, FLAGS.scrapeChangeDetectEnabled);`

For the object literals that forward strings into a `FetchOneEnv`-shaped payload (lines ~721, ~730, ~734 build a config object), add `FLAGS: env.FLAGS,` alongside the forwarded string fields so the downstream decision sites can read the binding. (The forwarded string fields may stay; they’re harmless documentation now that decisions use `FLAGS`.)

- [ ] **Step 2: `workers/api/src/workflows/batch-summarize.ts:163` and `batch-overview.ts:146`**

```ts
// batch-summarize.ts:163
if (trigger === "cron" && !(await flag(env.FLAGS, env.BATCH_SUMMARIZE_ENABLED, FLAGS.batchSummarizeEnabled))) {
// batch-overview.ts:146
if (trigger === "cron" && !(await flag(env.FLAGS, env.BATCH_OVERVIEW_ENABLED, FLAGS.batchOverviewEnabled))) {
```

Add the helper import to each file.

- [ ] **Step 3: `workers/api/src/workflows/poll-and-fetch.ts`**

- Line 455: `const changeDetectEnabled = await flag(env.FLAGS, env.SCRAPE_CHANGE_DETECT_ENABLED, FLAGS.scrapeChangeDetectEnabled);`
- In the `FetchOneEnv` builder around lines 163–165 (which forwards `WEB_BOT_AUTH_ENABLED` and `MEDIA_R2_UPLOAD_ENABLED` strings), add `FLAGS: env.FLAGS,` so `fetchOne`’s decision sites can read the binding.

Add the helper import.

- [ ] **Step 4: `workers/api/src/cron/poll-fetch.ts`**

- Line 122: `const changeDetectEnabled = await flag(env.FLAGS, env.SCRAPE_CHANGE_DETECT_ENABLED, FLAGS.scrapeChangeDetectEnabled);`
- Line 1115: `const r2UploadEnabled = (await flag(env.FLAGS, env.MEDIA_R2_UPLOAD_ENABLED, FLAGS.mediaR2UploadEnabled)) && env.MEDIA != null;`
- Line 2358: `if (!(await flag(env.FLAGS, env.FEED_ENRICH_ENABLED, FLAGS.feedEnrichEnabled)) || meta.feedContentDepth !== "summary-only") {`

Add the helper import. (`env` is `FetchOneEnv` here, which has `FLAGS?` after Task 2 Step 5.)

- [ ] **Step 5: `workers/api/src/cron/feed-enrich.ts:235`**

```ts
if (!(await flag(env.FLAGS, env.FEED_ENRICH_ENABLED, FLAGS.feedEnrichEnabled))) return out;
```

Add the helper import. (Confirm `env` type carries `FLAGS?`; if it is a narrow local type, add `FLAGS?: FlagshipBinding` to it.)

- [ ] **Step 6: `workers/api/src/workflows/onboard-source.ts:80` + `routes/sources.ts`**

- `onboard-source.ts:80` builds a `FetchOneEnv`: add `FLAGS: env.FLAGS,` to the object.
- `routes/sources.ts:640` and `:2306` build config objects forwarding `MEDIA_R2_UPLOAD_ENABLED`: add `FLAGS: c.env.FLAGS,`.
- `routes/sources.ts:720`: `const r2UploadEnabled = (await flag(c.env.FLAGS, c.env.MEDIA_R2_UPLOAD_ENABLED, FLAGS.mediaR2UploadEnabled)) && c.env.MEDIA != null;`
- `routes/sources.ts:2511`: `if ((await flag(c.env.FLAGS, c.env.ONBOARD_USE_WORKFLOW, FLAGS.onboardUseWorkflow)) && c.env.ONBOARD_SOURCE_WORKFLOW) {`

Add the helper import to `routes/sources.ts`.

- [ ] **Step 7: `workers/api/src/routes/recommendations.ts:101` + `routes/feedback.ts:51`**

```ts
// recommendations.ts:101
if (await flag(c.env.FLAGS, c.env.RECOMMENDATIONS_DISABLED, FLAGS.recommendationsDisabled)) {
// feedback.ts:51
if (await flag(c.env.FLAGS, c.env.FEEDBACK_DISABLED, FLAGS.feedbackDisabled)) {
```

Add the helper import to each.

- [ ] **Step 8: `workers/api/src/lib/latest-cache.ts:167`, `lib/indexnow.ts:64,144`, `lib/web-bot-auth-fetch.ts:24`**

```ts
// latest-cache.ts:167  (env has FLAGS? — worker Env or extend the local type)
if (!(await flag(env.FLAGS, env.INVALIDATION_ENABLED, FLAGS.invalidationEnabled))) {
// indexnow.ts:64 and :144
if (!(await flag(env.FLAGS, env.INDEXNOW_ENABLED, FLAGS.indexnowEnabled)))
  return logSkip(sourceSlug, "flag_off");
// web-bot-auth-fetch.ts:24
if (!(await flag(env.FLAGS, env.WEB_BOT_AUTH_ENABLED, FLAGS.webBotAuthEnabled))) return fetch;
```

Add the helper import to each. (`indexnow.ts` line 65/145 read `INDEXING_DISABLED` — convert those too with `FLAGS.indexingDisabled` for consistency since the binding is now in scope.) If any of these libs takes a narrow env type without `FLAGS?`, add `FLAGS?: FlagshipBinding` to that type (or to `IndexNowEnv` from Task 2 Step 5).

- [ ] **Step 9: Type-check + full API test suite**

Run:

```bash
cd workers/api && npx tsc --noEmit && cd ../..
bun test workers/api
```

Expected: no type errors; all existing API tests pass.

- [ ] **Step 10: Commit**

```bash
git add workers/api/src
git commit -m "feat(flags): route API cron/workflow/route/lib flags through Flagship"
```

---

## Task 6: Convert discovery worker flags

**Files:**

- Modify: `workers/discovery/src/index.ts:49`
- Modify: `workers/discovery/src/managed-agents-session.ts:47,518`

- [ ] **Step 1: `index.ts` MA kill switch**

In `workers/discovery/src/index.ts`, import the helper and replace line 49 (the enclosing function must be `async` — if `evaluateDisabled` is sync, make it `async` and `await` it at its single call site):

```ts
if (await flag(env.FLAGS, env.MA_SESSIONS_DISABLED, FLAGS.maSessionsDisabled))
  return { disabled: true, via: "env" };
```

- [ ] **Step 2: `managed-agents-session.ts` web-bot-auth (line 47)**

```ts
if (!(await flag(env.FLAGS, env.WEB_BOT_AUTH_ENABLED, FLAGS.webBotAuthEnabled))) return fetch;
```

(If the enclosing helper is sync, hoist resolution to the nearest async caller and pass a boolean.)

- [ ] **Step 3: `managed-agents-session.ts` extract-tool-loop (line 518)**

The string `this.env.EXTRACT_TOOLLOOP_ENABLED` is forwarded into the `scrapeFetch` config. Resolve it to a boolean at this boundary (the surrounding `scrapeHandler` is `async`). Replace the forwarded field:

```ts
                  extractToolLoopEnabled: await flag(
                    this.env.FLAGS,
                    this.env.EXTRACT_TOOLLOOP_ENABLED,
                    FLAGS.extractToolLoopEnabled,
                  ),
```

Then update `scrapeFetch`’s config type so `extractToolLoopEnabled` is typed `boolean` (was `string | undefined`), and update its downstream consumer (the extract path that previously did `=== "true"`) to treat it as a boolean. `grep -rn "extractToolLoopEnabled" workers packages` to find the consumer and adjust the comparison.

Add the helper import to both files: `import { FLAGS, flag } from "@releases/lib/flags";`

- [ ] **Step 4: Type-check + test**

Run:

```bash
cd workers/discovery && npx tsc --noEmit && cd ../..
bun test workers/discovery
```

Expected: no type errors; existing discovery tests pass.

- [ ] **Step 5: Commit**

```bash
git add workers/discovery/src
git commit -m "feat(flags): route discovery MA + extract flags through Flagship"
```

---

## Task 7: Docs + full verification

**Files:**

- Modify: `AGENTS.md`

- [ ] **Step 1: Document the flag system in `AGENTS.md`**

Add a short subsection under **Conventions** (near the other feature-gate notes):

```markdown
- **Feature flags via Cloudflare Flagship (Tier 1).** The Tier-1 boolean kill
  switches / rollout gates are evaluated at runtime through the `FLAGS` Flagship
  binding (apps `releases-platform` / `releases-platform-staging`). The registry
  is `@releases/lib/flags` (`FLAGS` + `flag(binding, varValue, def)`); evaluation
  is Flagship → wrangler var → hardcoded default, fail-open to the var on any
  error. The wrangler `vars` remain as the fallback layer, so a flag absent from a
  Flagship app behaves exactly as the var does today. **Adding a flag:** add a
  `FLAGS` registry entry, convert the read site to `await flag(...)`, and create
  the key in BOTH Flagship apps before relying on it. Numeric tunables and secrets
  are intentionally NOT in Flagship.
```

- [ ] **Step 2: Full repo verification**

Run:

```bash
npx tsc --noEmit
cd workers/api && npx tsc --noEmit && cd ../..
cd workers/mcp && npx tsc --noEmit && cd ../..
cd workers/discovery && npx tsc --noEmit && cd ../..
bun test
bun run lint
bun run format:check
```

Expected: all green. (`bun test` runs the full suite incl. `packages/` in its own process per the monorepo split.)

- [ ] **Step 3: Wrangler dry-run for all three workers**

Run:

```bash
bunx wrangler deploy --dry-run --config workers/api/wrangler.jsonc 2>&1 | tail -3
bunx wrangler deploy --dry-run --config workers/mcp/wrangler.jsonc 2>&1 | tail -3
bunx wrangler deploy --dry-run --config workers/discovery/wrangler.jsonc 2>&1 | tail -3
```

Expected: each dry-run succeeds with the `FLAGS` binding present.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs(flags): document the Flagship Tier-1 flag system"
```

---

## Post-merge activation (operator, not code)

After deploy, the system is var-backed (behaviour-neutral). To go live per flag:

1. In **both** Flagship apps, create the flag key from the registry (e.g.
   `media-r2-upload-enabled`) with a boolean variation matching the current var.
2. Read back via a staging request and confirm parity.
3. Pilot one real flip — recommended `media-r2-upload-enabled` (mid-rollout) or
   `ma-sessions-disabled` (incident kill switch) — and confirm the behavior
   changes without a redeploy.

Each Tier-2 numeric tunable or var removal is future, separate work.

---

## Self-review notes

- **Spec coverage:** helper+registry (Task 1) ✓; two-app binding/env wiring (Task 2) ✓; hot per-request flags (Task 3) ✓; MCP + cross-package search-log (Task 4) ✓; cold/warm API flags incl. forwarded `FetchOneEnv` cases (Task 5) ✓; discovery incl. `EXTRACT_TOOLLOOP_ENABLED` string→boolean (Task 6) ✓; `CACHE_DISABLED` normalization (Task 3 Step 1) ✓; docs + verification (Task 7) ✓. All 21 registry flags map to a converted read site.
- **Type consistency:** `flag(binding, varValue, def)` signature is used identically everywhere; `FlagshipBinding` imported as a type; `FLAGS?` added to every env carrier a decision site reads (`Bindings`, MCP `Env`, discovery `Env`, `FetchOneEnv`, `IndexNowEnv`, `SearchLogEnv`).
- **Known verification points flagged inline** (not placeholders): `IndexNowEnv` separate-interface check (T2.S5), `packages/search` dep on `@releases/lib` (T2.S6), sync→async hoist for `mcp-agent` registration / discovery `evaluateDisabled` / web-bot helper, and the `extractToolLoopEnabled` downstream consumer (T6.S3). Each names the exact grep to confirm and the exact edit.
