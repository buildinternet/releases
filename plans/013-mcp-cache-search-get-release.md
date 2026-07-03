# Plan 013: Cache MCP search and get_release read tools

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b1c2e87a..HEAD -- workers/mcp/src/mcp-agent.ts workers/mcp/src/lib/read-cache.ts workers/mcp/test/read-cache.test.ts`

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW–MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `b1c2e87a`, 2026-07-03

## Why this matters

MCP read-through KV cache (#1800) wraps list/feed/catalog tools but not `search` or `get_release` — the hottest post-discovery tools. Repeated identical calls pay full D1 + Vectorize cost. Wrapping token-independent variants collapses agent traffic onto one round-trip per TTL (60s per `MCP_READ_CACHE_TTL_SECONDS`).

## Current state

`workers/mcp/src/mcp-agent.ts`:

- `const cached = makeReadCache(env.EMBED_CACHE, ctx);` (~290)
- `get_release` registered at ~832-842 **without** `cached()`
- `search` registered at ~516-524 inside `withSearchLog("search", ...)` **without** `cached()`

`workers/mcp/src/lib/read-cache.ts` — keys `mcpread:v1:${toolName}:${stableStringify(params)}`; never caches `isError` results.

**Caching constraints**:
- `get_release` by id — safe to cache (token-independent).
- `search` with `since`/`until` relative values (`90d`) resolve at handler time — **do not cache** when params include relative date strings (stale window within TTL). Cache only when `since`/`until` absent or ISO-shaped.
- Hybrid search with embeddings — cache key must include mode-relevant params; identical query + filters is correct.

Tests: `workers/mcp/test/read-cache.test.ts` — extend or add `mcp-agent` registration smoke test.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| MCP tests | `bun test workers/mcp` | all pass |
| MCP typecheck | `cd workers/mcp && bun run typecheck` | exit 0 |
| Lint | `bun run check` | exit 0 |

## Scope

**In scope**:
- `workers/mcp/src/mcp-agent.ts`
- `workers/mcp/src/lib/read-cache.ts` (only if helper needed for cache eligibility)
- `workers/mcp/test/read-cache.test.ts` or new test file

**Out of scope**:
- `whats_changed` tool (separate perf item)
- Publish-time MCP cache invalidation (TTL-only by design per read-cache.ts header)
- Personalized follows tools

## Git workflow

- Branch: `advisor/013-mcp-cache-search-get-release`
- Commit: `perf(mcp): KV read cache for get_release and eligible search calls`

## Steps

### Step 1: Wrap get_release

Change registration from:

```ts
withMedia(async (params) => getRelease(db, params)),
```

to:

```ts
cached("get_release", withMedia(async (params) => getRelease(db, params))),
```

Note: `cached` wraps the outer handler; `withMedia` may need to be inside cached callback — match pattern used by `get_latest_releases` (~604-607): `cached("get_latest_releases", withMedia(async ...))`.

**Verify**: `grep -A2 'registerTool.*get_release' workers/mcp/src/mcp-agent.ts` shows `cached(`.

### Step 2: Wrap search with eligibility guard

Add helper in `read-cache.ts` or inline in `mcp-agent.ts`:

```ts
const RELATIVE_DATE_RE = /^\d+[dwmy]$/i;
function searchParamsCacheable(params: { since?: string; until?: string }): boolean {
  if (params.since && RELATIVE_DATE_RE.test(params.since)) return false;
  if (params.until && RELATIVE_DATE_RE.test(params.until)) return false;
  return true;
}
```

Wrap search handler:

```ts
withSearchLog("search", async (params) => {
  const run = async () => { /* existing body */ };
  if (!searchParamsCacheable(params)) return run();
  return cached("search", run)();
}),
```

Or structure so `withSearchLog` still logs every call (logging must not be skipped on cache hit). **Preferred**: keep `withSearchLog` outside; inner `cached` only wraps the `search()` call + `maybeLookup` logic. Cache hits skip search_query log — acceptable for identical repeated queries, OR log on cache hit with zero duration (optional).

**Verify**: manual read of registration — relative `since: "90d"` bypasses cache.

### Step 3: Add tests

In `read-cache.test.ts` or new file:

1. `get_release` cache hit returns same result without second DB call (mock KV).
2. `search` with `since: "90d"` does not write cache key (mock KV put not called).

Follow existing read-cache test patterns.

**Verify**: `bun test workers/mcp` → all pass.

### Step 4: Typecheck carved-out worker

**Verify**: `cd workers/mcp && bun run typecheck` → exit 0.

## Test plan

- Cache hit for get_release
- Relative-date search bypasses cache
- Existing MCP tests green

## Done criteria

- [ ] `get_release` wrapped in `cached()`
- [ ] `search` cached only when cacheable by date params
- [ ] Tests added
- [ ] `bun test workers/mcp` and mcp typecheck pass
- [ ] `plans/README.md` updated

## STOP conditions

- `withMedia` + `cached` composition causes double-wrap or breaks ToolResult shape — stop and match `get_latest_releases` pattern exactly.
- Product requires search_query log on every call including cache hits — implement log-on-hit before caching.

## Maintenance notes

- Bump `mcpread:v1` prefix in read-cache if response shapes change.
- Hybrid search cache keys include full params — embedding config changes invalidate via param drift naturally.