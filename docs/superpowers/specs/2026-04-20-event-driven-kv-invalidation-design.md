# Event-driven KV invalidation for `/v1/releases/latest`

**Issue:** [#408](https://github.com/buildinternet/releases/issues/408)
**Date:** 2026-04-20
**Status:** Proposed

## Goal

Drop `/v1/releases/latest` homepage / CLI-tail staleness from "up to 5 minutes" (the `LATEST_CACHE_TTL_SECONDS = 300` TTL floor) to "≤1s after D1 commit" by purging the KV entry when a release is published.

## Scope

**In scope.** Event-driven purge of the unfiltered default cache shape (`latest:v1:count=10`) fired from the two existing `publishReleaseEvents` call sites.

**Out of scope.**

- Overview regeneration on `release.created`. Punted — the worker has no in-process overview prompt today, and deciding where that AI call should live is a larger design question than we want to bundle here. Tracked in #408 follow-up.
- Dedicated invalidation Worker + queue consumer. Rejected as overbuilt for a single `KV.delete()`. A code comment references #408 so we can revisit if a second invalidation side-effect ever emerges.
- Lowering the 300s TTL. Keeps its role as a belt-and-suspenders ceiling even once event-driven purge is authoritative.
- Purging filtered / source-scoped / org-scoped cache keys. The allowlist (`ALLOWLISTED_CACHE_KEYS`) is empty today; when entries are added, the PR adding them extends this helper in lockstep.

## Context

- Event bus is live: `ReleaseHub` DO + `publishReleaseEvents` called via `ctx.waitUntil` from `workers/api/src/routes/sources.ts` (batch ingest) and `workers/api/src/cron/poll-fetch.ts` (hourly cron).
- `LATEST_CACHE` KV binding exists on the API worker. `withLatestCache` / `buildLatestCacheKey` / `isCacheableLatestRequest` live in `workers/api/src/lib/latest-cache.ts`.
- Today only the default unfiltered shape (`count=10`, no filters, coverage hidden) is cacheable. Filtered requests bypass KV and hit D1 directly — intentional, since D1 reads are cheap at current scale and caching every filter shape would inflate cardinality. The allowlist is the opt-in path for hot filtered shapes (e.g. a very popular product feed) if/when they emerge.

## Architecture

### Helper

Add `invalidateLatestCache(env, ctx)` in `workers/api/src/lib/latest-cache.ts`:

```ts
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
 * v1 scope: only the unfiltered default shape (latest:v1:count=10) is cached,
 * so that's all this purges. When ALLOWLISTED_CACHE_KEYS grows, extend this
 * helper to purge the matching shapes in the same PR.
 *
 * Kept inline (no queue, no dedicated Worker) because the work is a single
 * KV.delete(). If a second event-driven side-effect emerges, revisit a
 * dedicated consumer — see #408 for the conversation.
 */
export async function invalidateLatestCache(
  env: InvalidationEnv,
  meta: { nReleases: number; sourceId: string },
): Promise<void> {
  // ...
}
```

The helper emits exactly one structured log line per call (see Observability).

### Call sites

Three:

1. `workers/api/src/routes/sources.ts` batch ingest — after the D1 commit, adjacent to the existing `publishReleaseEvents(c.env, { src, inserted })` wrapped in `ctx.waitUntil`.
2. `workers/api/src/routes/sources.ts` admin manual fetch — after `fetchOne` returns, if `result.releasesInserted > 0`, called via `ctx.waitUntil`.
3. `workers/api/src/cron/poll-fetch.ts` hourly cron — aggregated inside `pollAndFetch`. `fetchOne` itself does NOT invalidate; `pollAndFetch` sums `releasesInserted` across the parallel `runWithConcurrency` and calls the helper once at the end if the total is positive. This prevents N redundant `KV.delete`s against the same key when multiple sources publish in a single cron run.

### Flag

New var in `workers/api/wrangler.jsonc`:

```jsonc
"INVALIDATION_ENABLED": "false"
```

When `"false"` or unset: helper logs `action=skipped reason=flag_off`, returns.
When `"true"`: helper calls `KV.delete(buildLatestCacheKey({ count: String(DEFAULT_LATEST_COUNT) }))` and logs the outcome.

Any exception from `KV.delete` is caught and logged with `ok=false`; it does not throw to the caller (the ingest path must never fail because a purge failed).

## Key-to-purge logic

V1:

```ts
const key = buildLatestCacheKey({ count: String(DEFAULT_LATEST_COUNT) });
await env.LATEST_CACHE?.delete(key);
```

That's the entire purge set today. A paired comment at `ALLOWLISTED_CACHE_KEYS` points at `invalidateLatestCache`, and the helper's doc comment points back at the allowlist. Anyone adding an allowlist entry will see they need to extend the purge set.

When the allowlist grows, the natural generalization is a function that takes `{ sourceId, orgId }` from the publish context and returns every allowlisted key that could plausibly be stale after releases for that source/org. Not building that now — YAGNI until the allowlist has an entry.

## Flag rollout

- **Week 0 — deploy with flag off.** Helper wired in, every publish logs `action=skipped reason=flag_off`. Zero production behavior change. The flag-off log gives us a parity signal.
- **Parity check.** Count `[invalidation]` log lines per hour against publish firings (both batch-ingest and cron paths). They should match 1:1 per publish event. If the count diverges, the helper is wired incorrectly — fix before flipping.
- **Week 1 — flip flag to true.** Redeploy with `INVALIDATION_ENABLED=true`. Logs now show `action=purged ok=true|false`. Monitor for a week; purge-failure rate should be near zero (KV.delete is reliable).
- **Post-stabilization.** TTL stays at 300s as the safety net. No immediate need to lower it.

## Observability

One structured log line per call, keyed on `[invalidation]`:

| Field        | Values                                                 | Meaning                                                                                                             |
| ------------ | ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| `action`     | `purged` \| `skipped`                                  | Did we call `KV.delete`?                                                                                            |
| `reason`     | `flag_off` \| `no_binding` \| `no_releases` \| `error` | Why the skip or error branch was taken. Absent when action=purged succeeded (ok=true alone is the positive signal). |
| `key`        | string                                                 | Cache key targeted (always present so parity queries can diff by shape).                                            |
| `ok`         | boolean                                                | Only set when `action=purged`.                                                                                      |
| `n_releases` | number                                                 | Size of the publish batch.                                                                                          |
| `source_id`  | string                                                 | For debugging parity mismatches.                                                                                    |
| `error`      | string?                                                | Only set when `ok=false`.                                                                                           |

Axiom-logs destination is already wired in `wrangler.jsonc` observability. A saved query on `[invalidation]` gives the parity view. No Analytics Engine dataset — not justified at current scope.

## Testing

### Unit (`workers/api/test/`)

- `invalidateLatestCache` with flag off → no KV calls, log reflects `skipped reason=flag_off`.
- With flag on, binding present, KV resolves → `KV.delete` called once with the default key, log reflects `purged ok=true`.
- With flag on, KV.delete throws → no rethrow, log reflects `purged ok=false reason=error`.
- With binding missing (optional chaining path) → log reflects `skipped reason=no_binding`.
- With `nReleases: 0` → log reflects `skipped reason=no_releases` (early return; matches the `publishReleaseEvents` contract).

### Integration

Extend an existing `sources.ts` batch-ingest test. Stub the `LATEST_CACHE` binding with `{ delete: mock() }`. Assert:

- `delete` not called when `INVALIDATION_ENABLED` is unset or `"false"`.
- `delete` called exactly once with `"latest:v1:count=10"` when flag is `"true"` and the batch produced ≥1 inserted row.

### Smoke (post-deploy, via CLI)

Per user preference (no raw curl):

1. `releases admin fetch <known-active-source>` against staging.
2. Observe the cron or batch ingest write a release.
3. `releases admin org show <slug>` or the equivalent list command that exercises `/v1/releases/latest`.
4. Verify the response reflects the new release within seconds (not 300s).

## Risk + mitigation

- **Purge fires for a release the consumer already received via REST (race).** Harmless — the next READ repopulates the cache from D1 on the next request. Worst case is one extra cache miss.
- **Purge fires before the D1 row is actually readable.** Can't happen — `publishReleaseEvents` already fires _after_ the D1 commit; the purge sits right next to it.
- **Purge fails silently and we don't notice.** Axiom saved query on `ok=false` catches this; TTL covers the staleness window in any case.
- **Allowlist grows and the invalidator isn't extended.** Cross-reference comments make the coupling visible. Worst case: that one shape is stale for up to 300s — same as today.

## File touches (preview; actual list lives in the implementation plan)

- `workers/api/src/lib/latest-cache.ts` — add `invalidateLatestCache` helper + cross-reference comment on `ALLOWLISTED_CACHE_KEYS`.
- `workers/api/src/routes/sources.ts` — call helper next to `publishReleaseEvents`.
- `workers/api/src/cron/poll-fetch.ts` — same.
- `workers/api/wrangler.jsonc` — add `INVALIDATION_ENABLED: "false"` var.
- `workers/api/src/index.ts` — thread `INVALIDATION_ENABLED` through `Env` type if not already present.
- Tests next to the above.
