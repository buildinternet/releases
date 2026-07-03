# Plan 015: Wire edge-cache purge alongside KV invalidation on publish

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b1c2e87a..HEAD -- workers/api/src/lib/latest-cache.ts workers/api/src/middleware/edge-cache.ts workers/api/src/index.ts`

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `b1c2e87a`, 2026-07-03

## Why this matters

Worker-side edge cache (#1800) stores anonymous GET responses keyed by URL (`edge-cache.ts`). `invalidateLatestCache` purges KV keys on ingest but **not** Cache API entries — comment at `edge-cache.ts:48-51` says purge is future work. After publish, edge-cached org feeds and headline endpoints can stay stale for full `max-age` + `stale-while-revalidate` even when KV is fresh.

## Current state

- `workers/api/src/middleware/edge-cache.ts` — `edgeCacheKey(req)` builds cache key (lines 123-128); `defaultCache()` wraps `caches.default`.
- `workers/api/src/lib/latest-cache.ts` — `invalidateLatestCache` deletes KV keys from `CACHEABLE_DEFAULT_SHAPES` (~155-206).
- Publish sites call `invalidateLatestCache` from poll-fetch, batch routes, onboard workflow, etc. (grep `invalidateLatestCache`).

Edge cache applies to all `v1` GET via `v1.use("*", edgeCache())` in `index.ts`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint | `bun run check` | exit 0 |
| API tests | `bun test workers/api` | all pass |
| Targeted | `bun test workers/api/test/latest-cache.test.ts` (if exists) | pass |

## Scope

**In scope**:
- `workers/api/src/middleware/edge-cache.ts` — export key builder
- `workers/api/src/lib/latest-cache.ts` — call edge purge from invalidation
- New test file e.g. `workers/api/test/edge-cache-invalidation.test.ts`

**Out of scope**:
- Purging every org-scoped URL variant (start with global headline shapes matching KV purge)
- MCP worker cache
- New feature flag (reuse `INVALIDATION_ENABLED` gate)

## Git workflow

- Branch: `advisor/015-edge-cache-purge-on-publish`
- Commit: `perf(api): purge edge cache on publish alongside KV invalidation`

## Steps

### Step 1: Export edge cache key builder

In `edge-cache.ts`, export:

```ts
export function buildEdgeCacheKey(url: string, accept: string | null): Request {
  const req = new Request(url, { method: "GET", headers: accept ? { Accept: accept } : {} });
  return edgeCacheKey(req);
}
```

Refactor private `edgeCacheKey` to use `buildEdgeCacheKey` internally if needed.

**Verify**: export used without breaking existing middleware.

### Step 2: Add purgeEdgeCacheKeys helper

In `latest-cache.ts` (or new `lib/edge-cache-invalidation.ts` imported by latest-cache):

```ts
export async function purgeEdgeCacheUrls(urls: string[]): Promise<void> {
  const cache = typeof caches !== "undefined"
    ? (caches as { default: { delete: (k: Request) => Promise<boolean> } }).default
    : undefined;
  if (!cache) return;
  for (const url of urls) {
    for (const accept of ["application/json", "text/markdown"]) {
      try {
        await cache.delete(buildEdgeCacheKey(url, accept));
      } catch (err) {
        logEvent("warn", { component: "invalidation", event: "edge-purge-failed", url, err });
      }
    }
  }
}
```

Build URLs from a base origin — use relative paths `/v1/releases/latest?count=10` etc. matching `CACHEABLE_DEFAULT_SHAPES` REST equivalents. Read `workers/api/src/routes/releases.ts` for latest endpoint query shapes.

**Verify**: `grep purgeEdgeCacheUrls workers/api` → defined + called.

### Step 3: Call from invalidateLatestCache

At end of successful KV purge block in `invalidateLatestCache`, derive public GET URLs for the same shapes and call `purgeEdgeCacheUrls`. Respect the same `INVALIDATION_ENABLED` and `nReleases > 0` gates.

Use `env.API_PUBLIC_ORIGIN` or hardcode canonical paths only (cache keys use path+query, not host) — `edgeCacheKey` uses full URL; construct with `https://cache.internal` dummy host if pathname+search is all that matters. **Read** `edgeCacheKey` — it uses `new URL(req.url)`; host may matter. Test in miniflare or unit-test key equality with middleware.

**STOP if**: Cache API keys include hostname and dummy host won't match stored entries — must use same origin the worker uses when storing (read edge-cache middleware `cache.put` call).

### Step 4: Add unit test

Test `buildEdgeCacheKey` produces stable keys for json vs markdown Accept headers.

If integration test is hard, test URL list generation from shapes matches keys used in `edgeCache()` middleware.

**Verify**: `bun test workers/api` → pass.

## Test plan

- Key builder: json vs md discriminator
- invalidateLatestCache invokes edge purge when flag on (mock caches.default.delete)

## Done criteria

- [ ] Edge cache delete called on same publish invalidation path as KV
- [ ] Fail-open on missing `caches` (tests/local)
- [ ] Tests added
- [ ] `bun run check` and `bun test workers/api` exit 0
- [ ] `plans/README.md` updated

## STOP conditions

- Stored cache keys use full request URL with caller host — must thread canonical origin from env; stop if no env exists and add `CACHE_PURGE_ORIGIN` var (discuss before adding).
- Purge scope explodes (per-org URLs) — keep v1 to global latest shapes only per this plan.

## Maintenance notes

- Adding new `CACHEABLE_DEFAULT_SHAPES` entries requires matching edge URL in purge list.
- Org-scoped edge entries may remain TTL-bound until a follow-up plan adds targeted org purge.