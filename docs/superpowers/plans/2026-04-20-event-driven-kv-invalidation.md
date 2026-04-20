# Event-driven KV invalidation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Purge the cached `/v1/releases/latest` default KV entry after a release publishes, so homepage and CLI tail-pollers see new releases in ≤1s instead of up to 300s.

**Architecture:** Inline helper `invalidateLatestCache` added to `workers/api/src/lib/latest-cache.ts`. Called fire-and-forget via `ctx.waitUntil` from the two existing `publishReleaseEvents` sites (batch ingest in `sources.ts`, cron `fetchOne` in `poll-fetch.ts`). Gated behind `INVALIDATION_ENABLED`. No new Worker, no new queue. TTL (300s) remains the safety net.

**Tech Stack:** Cloudflare Workers (Hono), KV (`LATEST_CACHE`), Bun test (`bun:test`), Drizzle + bun:sqlite for test fixtures.

**Spec:** `docs/superpowers/specs/2026-04-20-event-driven-kv-invalidation-design.md`

---

## File Structure

**Modify:**

- `workers/api/src/lib/latest-cache.ts` — extend `LatestCacheBinding` with `delete`; add `InvalidationEnv` interface and `invalidateLatestCache` helper; cross-reference `ALLOWLISTED_CACHE_KEYS`.
- `workers/api/src/index.ts` — add `INVALIDATION_ENABLED?: string` to `Env.Bindings`.
- `workers/api/src/cron/poll-fetch.ts` — add `LATEST_CACHE?` and `INVALIDATION_ENABLED?` to `FetchOneEnv`; call the helper alongside `publishReleaseEvents`.
- `workers/api/src/routes/sources.ts` — call the helper alongside the existing `publishReleaseEvents` in the batch-ingest path.
- `workers/api/wrangler.jsonc` — add `"INVALIDATION_ENABLED": "false"` var.

**Create:**

- `workers/api/test/latest-cache.test.ts` — unit tests for `invalidateLatestCache`.

**No other files touched.** The helper is a single responsibility (purge one key); tests cover the five branches (flag off, no binding, no releases, KV ok, KV throws). No refactoring of existing code.

---

## Task 1: Add `delete` to `LatestCacheBinding` and write failing tests for `invalidateLatestCache`

**Files:**

- Modify: `workers/api/src/lib/latest-cache.ts:8-15` (extend interface)
- Create: `workers/api/test/latest-cache.test.ts`

- [ ] **Step 1: Extend `LatestCacheBinding` with `delete`**

Edit `workers/api/src/lib/latest-cache.ts` lines 8–15. Replace the interface:

```ts
export interface LatestCacheBinding {
  get(key: string, type: "json"): Promise<unknown>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
```

- [ ] **Step 2: Write the failing unit tests**

Create `workers/api/test/latest-cache.test.ts`:

```ts
import { describe, it, expect, mock, beforeEach } from "bun:test";
import { invalidateLatestCache } from "../src/lib/latest-cache.js";

type KvStub = {
  get: ReturnType<typeof mock>;
  put: ReturnType<typeof mock>;
  delete: ReturnType<typeof mock>;
};

function mkKv(overrides: Partial<KvStub> = {}): KvStub {
  return {
    get: mock(async () => null),
    put: mock(async () => undefined),
    delete: mock(async () => undefined),
    ...overrides,
  };
}

let logs: string[] = [];
const origConsoleInfo = console.info;
const origConsoleWarn = console.warn;
beforeEach(() => {
  logs = [];
  console.info = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

function restoreConsole() {
  console.info = origConsoleInfo;
  console.warn = origConsoleWarn;
}

describe("invalidateLatestCache", () => {
  it("skips with reason=flag_off when INVALIDATION_ENABLED is unset", async () => {
    const kv = mkKv();
    await invalidateLatestCache({ LATEST_CACHE: kv }, { nReleases: 3, sourceId: "src_abc" });
    expect(kv.delete).not.toHaveBeenCalled();
    expect(
      logs.some(
        (l) =>
          l.includes("[invalidation]") &&
          l.includes("action=skipped") &&
          l.includes("reason=flag_off"),
      ),
    ).toBe(true);
    restoreConsole();
  });

  it("skips with reason=flag_off when INVALIDATION_ENABLED is 'false'", async () => {
    const kv = mkKv();
    await invalidateLatestCache(
      { LATEST_CACHE: kv, INVALIDATION_ENABLED: "false" },
      { nReleases: 3, sourceId: "src_abc" },
    );
    expect(kv.delete).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("reason=flag_off"))).toBe(true);
    restoreConsole();
  });

  it("skips with reason=no_releases when nReleases is 0", async () => {
    const kv = mkKv();
    await invalidateLatestCache(
      { LATEST_CACHE: kv, INVALIDATION_ENABLED: "true" },
      { nReleases: 0, sourceId: "src_abc" },
    );
    expect(kv.delete).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("reason=no_releases"))).toBe(true);
    restoreConsole();
  });

  it("skips with reason=no_binding when LATEST_CACHE is undefined", async () => {
    await invalidateLatestCache(
      { INVALIDATION_ENABLED: "true" },
      { nReleases: 2, sourceId: "src_abc" },
    );
    expect(logs.some((l) => l.includes("reason=no_binding"))).toBe(true);
    restoreConsole();
  });

  it("purges the default key when flag is on and binding present", async () => {
    const kv = mkKv();
    await invalidateLatestCache(
      { LATEST_CACHE: kv, INVALIDATION_ENABLED: "true" },
      { nReleases: 5, sourceId: "src_abc" },
    );
    expect(kv.delete).toHaveBeenCalledTimes(1);
    expect(kv.delete).toHaveBeenCalledWith("latest:v1:count=10");
    expect(logs.some((l) => l.includes("action=purged") && l.includes("ok=true"))).toBe(true);
    restoreConsole();
  });

  it("swallows KV.delete errors and logs ok=false", async () => {
    const kv = mkKv({
      delete: mock(async () => {
        throw new Error("kv down");
      }),
    });
    await expect(
      invalidateLatestCache(
        { LATEST_CACHE: kv, INVALIDATION_ENABLED: "true" },
        { nReleases: 2, sourceId: "src_abc" },
      ),
    ).resolves.toBeUndefined();
    expect(
      logs.some(
        (l) => l.includes("action=purged") && l.includes("ok=false") && l.includes("reason=error"),
      ),
    ).toBe(true);
    restoreConsole();
  });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run:

```bash
cd workers/api && bun test test/latest-cache.test.ts
```

Expected: all six tests FAIL with "invalidateLatestCache is not a function" (or import error).

- [ ] **Step 4: Commit the failing tests + interface change**

```bash
git add workers/api/src/lib/latest-cache.ts workers/api/test/latest-cache.test.ts
git commit -m "test: add failing tests for invalidateLatestCache helper"
```

---

## Task 2: Implement `invalidateLatestCache` to make tests pass

**Files:**

- Modify: `workers/api/src/lib/latest-cache.ts` (append helper + cross-reference comment)

- [ ] **Step 1: Add the `InvalidationEnv` interface and helper**

Append to `workers/api/src/lib/latest-cache.ts` (after the existing `withLatestCache` function):

```ts
/**
 * Environment slice used by `invalidateLatestCache`. Keep in sync with the
 * API worker's `Env.Bindings` and the `FetchOneEnv` used from the cron.
 */
export interface InvalidationEnv {
  LATEST_CACHE?: LatestCacheBinding;
  INVALIDATION_ENABLED?: string;
}

/**
 * Purge the cached /v1/releases/latest default shape after a publish.
 *
 * Called fire-and-forget from the publish sites alongside publishReleaseEvents.
 * Purges are best-effort; the 300s TTL remains the safety net on failure.
 *
 * v1 scope: only the unfiltered default shape (`latest:v1:count=10`) is cached,
 * so that's all this purges. When ALLOWLISTED_CACHE_KEYS grows, extend this
 * helper to purge the matching shapes in the same PR.
 *
 * Kept inline (no queue, no dedicated Worker) because the work is a single
 * KV.delete(). If a second event-driven side-effect emerges, revisit a
 * dedicated consumer — see https://github.com/buildinternet/releases/issues/408
 * for the conversation.
 */
export async function invalidateLatestCache(
  env: InvalidationEnv,
  meta: { nReleases: number; sourceId: string },
): Promise<void> {
  const key = buildLatestCacheKey({ count: String(DEFAULT_LATEST_COUNT) });
  const base = `[invalidation] key=${key} source_id=${meta.sourceId} n_releases=${meta.nReleases}`;

  if (env.INVALIDATION_ENABLED !== "true") {
    console.info(`${base} action=skipped reason=flag_off`);
    return;
  }
  if (meta.nReleases === 0) {
    console.info(`${base} action=skipped reason=no_releases`);
    return;
  }
  if (!env.LATEST_CACHE) {
    console.info(`${base} action=skipped reason=no_binding`);
    return;
  }

  try {
    await env.LATEST_CACHE.delete(key);
    console.info(`${base} action=purged reason=ok ok=true`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`${base} action=purged reason=error ok=false error=${msg}`);
  }
}
```

- [ ] **Step 2: Add cross-reference comment at `ALLOWLISTED_CACHE_KEYS`**

Edit `workers/api/src/lib/latest-cache.ts` around line 39–43. Replace the block:

```ts
// Explicit allowlist of filtered cache keys worth caching beyond the default
// unfiltered shape. Empty by design — add an entry here (matching the
// `buildLatestCacheKey` output for that shape) when analytics show a
// filtered request is a hot enough read to justify its own cache entry.
// Example: the Vercel org page might eventually warrant
//   "latest:v1:count=10&org=org_vercel_id"
//
// When you add an entry, also extend `invalidateLatestCache` below so the
// purge set matches the cache set — otherwise entries here will be stale
// for up to LATEST_CACHE_TTL_SECONDS after any release to the relevant org.
export const ALLOWLISTED_CACHE_KEYS: ReadonlySet<string> = new Set<string>();
```

- [ ] **Step 3: Run tests to verify they pass**

Run:

```bash
cd workers/api && bun test test/latest-cache.test.ts
```

Expected: all six tests PASS.

- [ ] **Step 4: Type-check the worker**

Run:

```bash
cd workers/api && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Commit the helper implementation**

```bash
git add workers/api/src/lib/latest-cache.ts
git commit -m "feat(api): add invalidateLatestCache helper (#408)"
```

---

## Task 3: Add `INVALIDATION_ENABLED` to `Env.Bindings` and wrangler vars

**Files:**

- Modify: `workers/api/src/index.ts:47-95` (add to Env.Bindings)
- Modify: `workers/api/wrangler.jsonc:22-44` (add var)

- [ ] **Step 1: Add `INVALIDATION_ENABLED` to `Env.Bindings`**

Edit `workers/api/src/index.ts`. Find the block near line 84–85 where `LATEST_CACHE` is declared. Immediately after the `LATEST_CACHE?: KVNamespace;` line, add:

```ts
    // Gates event-driven KV purge of `/v1/releases/latest` (see
    // src/lib/latest-cache.ts invalidateLatestCache). Ships "false"; flipped
    // to "true" after a parity-logging week.
    INVALIDATION_ENABLED?: string;
```

- [ ] **Step 2: Add `INVALIDATION_ENABLED` var to wrangler.jsonc**

Edit `workers/api/wrangler.jsonc`. Find the `"vars"` block starting at line 22. After the `"ADMIN_BASE_URL"` entry (around line 43), add:

```jsonc
    // Event-driven KV purge of GET /v1/releases/latest. Ships "false" to
    // run the helper in shadow mode (log-only); flip to "true" after a
    // week of parity-check logs. See #408.
    "INVALIDATION_ENABLED": "false",
```

Make sure the preceding line has a trailing comma.

- [ ] **Step 3: Type-check**

Run:

```bash
cd workers/api && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Validate wrangler config**

Run:

```bash
cd workers/api && npx wrangler types --x-with-new-deployments-api=false || npx wrangler types
```

Expected: exits 0; `INVALIDATION_ENABLED` appears in generated types if a types file is produced. Non-fatal if the command has no output — we just need to know the jsonc parses.

Alternative verification if `wrangler types` isn't the right command here:

```bash
cd workers/api && npx wrangler deploy --dry-run --outdir /tmp/wrangler-dry 2>&1 | tail -20
```

Expected: no parse errors for wrangler.jsonc (deploy may fail for other reasons — we only care that the config loads).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/index.ts workers/api/wrangler.jsonc
git commit -m "feat(api): wire INVALIDATION_ENABLED flag binding (#408)"
```

---

## Task 4: Wire the helper into the batch-ingest publish site

**Files:**

- Modify: `workers/api/src/routes/sources.ts:426-436` (add invalidation call next to `publishReleaseEvents`)

- [ ] **Step 1: Add the import**

Edit `workers/api/src/routes/sources.ts`. Find the existing `latest-cache` imports (if any) or add a new import near the other `../lib/...` imports at the top:

```ts
import { invalidateLatestCache } from "../lib/latest-cache.js";
```

If an import from `../lib/latest-cache.js` already exists (check for `buildLatestCacheKey`), add `invalidateLatestCache` to that existing import instead.

- [ ] **Step 2: Call the helper alongside `publishReleaseEvents`**

Edit `workers/api/src/routes/sources.ts` lines 429–436. Replace the existing block:

```ts
if (publishRows.length > 0) {
  c.executionCtx.waitUntil(
    publishReleaseEvents(c.env, {
      src: { name: src.name, slug: src.slug, orgId: src.orgId, sourceId: src.id },
      inserted: publishRows,
    }),
  );
  c.executionCtx.waitUntil(
    invalidateLatestCache(c.env, {
      nReleases: publishRows.length,
      sourceId: src.id,
    }),
  );
}
```

- [ ] **Step 3: Type-check**

Run:

```bash
cd workers/api && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 4: Run the existing sources.ts test suite (if present) to confirm no regression**

Run:

```bash
cd workers/api && bun test
```

Expected: all existing tests pass. (No new test added here — the helper's unit tests cover its behavior; this task is pure wiring.)

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/routes/sources.ts
git commit -m "feat(api): invalidate latest cache on batch ingest publish (#408)"
```

---

## Task 5: Wire the helper into the cron `fetchOne` publish site

**Files:**

- Modify: `workers/api/src/cron/poll-fetch.ts:201-218` (extend `FetchOneEnv`)
- Modify: `workers/api/src/cron/poll-fetch.ts:379-391` (add invalidation call)

- [ ] **Step 1: Extend `FetchOneEnv`**

Edit `workers/api/src/cron/poll-fetch.ts` around lines 201–218. Add two fields at the bottom of the interface (before the closing brace on line 218):

```ts
  LATEST_CACHE?: {
    get(key: string, type: "json"): Promise<unknown>;
    put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
    delete(key: string): Promise<void>;
  };
  INVALIDATION_ENABLED?: string;
```

> Note: we declare the KV shape structurally rather than importing `KVNamespace`
> to match the existing pattern in this file (Vectorize indexes are typed as
> `unknown` for the same reason — see the comment at line 203).

- [ ] **Step 2: Add the import**

Near the top of `workers/api/src/cron/poll-fetch.ts`, add:

```ts
import { invalidateLatestCache } from "../lib/latest-cache.js";
```

- [ ] **Step 3: Call the helper after `publishReleaseEvents` in `fetchOne`**

Edit `workers/api/src/cron/poll-fetch.ts` around lines 379–391. Replace the existing block:

```ts
if (publishRows.length > 0 && env.RELEASE_HUB) {
  await publishReleaseEvents(
    {
      RELEASE_HUB: env.RELEASE_HUB,
      WEBHOOK_DELIVERY_QUEUE: env.WEBHOOK_DELIVERY_QUEUE,
      DB: env.DB,
    },
    {
      src: { name: source.name, slug: source.slug, orgId: source.orgId, sourceId: source.id },
      inserted: publishRows,
    },
  );
  await invalidateLatestCache(
    { LATEST_CACHE: env.LATEST_CACHE, INVALIDATION_ENABLED: env.INVALIDATION_ENABLED },
    { nReleases: publishRows.length, sourceId: source.id },
  );
}
```

> Note: unlike the HTTP handler, `fetchOne` already runs inside a
> `ctx.waitUntil` boundary at its callers (see the comment at line 394–395),
> so we call the invalidation inline and let any throw propagate. The
> helper is catch-all safe internally, so nothing actually propagates.

- [ ] **Step 4: Type-check**

Run:

```bash
cd workers/api && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 5: Run the test suite**

Run:

```bash
cd workers/api && bun test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/cron/poll-fetch.ts
git commit -m "feat(api): invalidate latest cache on cron fetch publish (#408)"
```

---

## Task 6: Root-level type-check, lint, format

**Files:** (no new edits — verification only)

- [ ] **Step 1: Root type-check**

Run from repo root:

```bash
npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 2: Lint**

Run:

```bash
bun run lint
```

Expected: zero warnings, zero errors (the repo is at zero-warnings as of commit 89ed855).

- [ ] **Step 3: Format check**

Run:

```bash
bun run format:check
```

Expected: clean. If anything fails, run `bun run format` and commit the formatting fix in a separate commit.

- [ ] **Step 4: Full test run**

Run:

```bash
bun test
```

Expected: all tests pass (existing + the six new unit tests added in Task 1).

- [ ] **Step 5: If any formatting changed, commit the fix**

```bash
git add -u
git commit -m "chore: prettier fixes"
```

If nothing to commit, skip.

---

## Task 7: Open the PR

**Files:** (no edits — PR only)

- [ ] **Step 1: Push branch**

```bash
git push -u origin feat/408-kv-invalidation
```

- [ ] **Step 2: Open PR via `gh`**

Write the PR body to a temp file (per user's preference — `--body-file` avoids HEREDOC-backtick escaping):

```bash
cat > /tmp/pr-408-body.md <<'EOF'
## Summary

- Adds `invalidateLatestCache` helper that purges the cached default `/v1/releases/latest` key after a release publishes.
- Wires the helper into the two existing `publishReleaseEvents` sites (batch ingest + cron `fetchOne`), fire-and-forget via `ctx.waitUntil` where available.
- Gated behind `INVALIDATION_ENABLED` (ships `"false"`). Ships in shadow-log mode — every publish emits `[invalidation] action=skipped reason=flag_off …` so we can parity-check firings for a week before flipping to `"true"`.
- Out of scope: overview regeneration on `release.created` (deferred, see #408 follow-up); dedicated queue consumer (rejected as overbuilt for a single `KV.delete()`, comment references #408).

Spec: `docs/superpowers/specs/2026-04-20-event-driven-kv-invalidation-design.md`

Closes part of #408 (KV invalidation half). Overview regen tracked separately.

## Test plan

- [ ] `cd workers/api && bun test test/latest-cache.test.ts` — six unit tests for helper branches (flag off, no releases, no binding, purge ok, purge throws).
- [ ] `bun test` at repo root — full suite green.
- [ ] `npx tsc --noEmit` at repo root and in `workers/api/`.
- [ ] `bun run lint` — zero warnings.
- [ ] Manual smoke after deploy with flag off: confirm axiom-logs shows `[invalidation] action=skipped reason=flag_off` on every batch-ingest and cron-fetch publish for 24h.
- [ ] Flip flag to `"true"` in a follow-up deploy after the parity week. Confirm logs show `action=purged ok=true` and `X-Cache: MISS` on the next `/v1/releases/latest` GET after a fresh publish.
EOF
```

Then open the PR:

```bash
gh pr create \
  --title "feat(api): event-driven KV invalidation for /v1/releases/latest (#408)" \
  --body-file /tmp/pr-408-body.md
```

- [ ] **Step 3: Report the PR URL back**

The `gh pr create` command prints the PR URL on success. Return it so the user can review.

---

## Self-review notes

**Spec coverage.** Every spec section maps to a task:

- "Helper" in Architecture → Tasks 1, 2.
- "Call sites" in Architecture → Tasks 4, 5.
- "Flag" + "Flag rollout" → Task 3 (wrangler var + Env binding); parity week is operational, not code.
- "Key-to-purge logic" → Task 2 Step 1 (uses `buildLatestCacheKey` + `DEFAULT_LATEST_COUNT`).
- "Observability" → Task 2 Step 1 (single structured log line per call with all fields from the spec table).
- "Testing — Unit" → Task 1 Step 2 (six tests matching the five bullets + one covering the `"false"` explicit case).
- "Testing — Integration" → Deliberately folded into the full `bun test` run in Tasks 4, 5, 6. No new stubbed-binding integration test beyond the unit tests, because the helper is isolated and the call-site wiring is a single-line addition; the unit tests already verify the helper's contract.
- "Testing — Smoke" → PR checklist in Task 7.
- "Risk + mitigation" → Implicit in tests (KV throws case, flag off case, missing binding case).
- "File touches (preview)" → Tasks 1–5 match the preview list.

**Placeholder scan.** No TBDs, no "implement later", no "similar to task N". Every code block is complete.

**Type consistency.** `InvalidationEnv` fields match across the helper signature (Task 2), the Env.Bindings addition (Task 3), and the `FetchOneEnv` extension (Task 5). `nReleases` and `sourceId` naming consistent across all call sites and tests. The structural KV type in `FetchOneEnv` (Task 5 Step 1) is a superset of the `LatestCacheBinding` the helper expects (both have `delete`).

No gaps found.
