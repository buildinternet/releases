# SourceActor migration scaffolding removal (heartbeat model)

**Date:** 2026-07-01
**Status:** Approved (design), ready for implementation plan
**Related:** #1776 (SourceActor), #1780 (lock retirement, closed), #1777 (ProductActor, deferred)

## Goal

The SourceActor per-source Durable Object has been at 100% cohort in prod since
#1791 and is proven. This change removes the rollout scaffolding so the actor is
the sole per-source fetch driver, and shrinks the hourly poll cron
(`fanOutPollAndFetch`) to a pure **re-seed heartbeat** over all due sources.

Rollback semantics change from "flip a flag → hand sources back to the cron" to
"revert + redeploy" — consistent with the decision to remove the kill-switch
flag (option A below).

### Out of scope (deferred)

Absorbing other per-source crons (force-drain #518, scrape-agent sweep #482,
staleness digests #1528) into actors. Those need a cross-source coordinator to
enforce global MA-spend caps (e.g. `FORCE_SWEEP_MAX_SESSIONS`); that coordinator
is the deferred ProductActor (#1777). This phase is scaffolding removal only.

## Background: what the scaffolding is

Three consumers share one cohort predicate,
`isSourceActorManaged(sourceId, enabled, cohortPct, hasBinding)` in
`workers/api/src/lib/source-actor-cohort.ts`:

1. **Cron fan-out split** (`workers/api/src/index.ts` `fanOutPollAndFetch`) —
   partitions due sources into `actorManaged` (→ `ensureScheduled`) vs `due`
   (→ `POLL_AND_FETCH_WORKFLOW.createBatch`, the legacy cron-driven ingest).
2. **Actor alarm self-check** (`workers/api/src/source-actor.ts` `alarm()`) —
   re-evaluates the same gate every alarm so flag-off hands a source back to the
   cron with no double-driving.
3. **PATCH reparent hook** (`workers/api/src/routes/sources.ts`) — gates the
   `onSourceChanged` actor notify on the cohort predicate.

Plus the `SOURCE_ACTOR_COHORT_PCT` wrangler var and the `source-actor-enabled`
Flagship flag.

`seedJitterMs` / `SEED_JITTER_WINDOW_MS` (same file) is NOT scaffolding — it
staggers the first alarm of freshly-seeded sources to avoid a thundering herd,
and stays load-bearing after this change.

## The heartbeat model

With the cohort at 100%, every due source is already actor-driven; the
`createBatch` cron path is dead code in steady state. New shape:

- `fanOutPollAndFetch` stops partitioning. **Every** source from
  `queryDueSources` gets `ensureScheduled` (idempotent — no-op when an alarm is
  already pending), in the existing bounded-concurrency waves.
- The `createBatch` cron-driven ingest branch and its
  `POLL_FETCH_SUMMARY_WORKFLOW` companion (keyed to that fan-out) are removed.

The heartbeat is load-bearing, not just anti-stranding insurance: an actor that
hits `noReschedule` (paused / org-paused / firecrawl) **deletes its own alarm**
(`deleteAlarm()`), so when the source becomes due again the cron heartbeat is
what re-seeds it via `ensureScheduled`. Actors still self-perpetuate via their
alarm between heartbeats; the cron only guarantees due sources have a live alarm.

## Flag decision: remove it (option A)

`source-actor-enabled` is removed entirely. With no cron-driven fallback path,
"flag off" can no longer mean "safe handback to cron" — keeping the flag would
be a footgun (a stale runbook flips it expecting safety and instead changes
behavior). Rollback is `git revert` + redeploy, matching how the rest of the
actor internals are already shipped.

(Rejected — option B, redefine the flag as a global halt: keeps an instant
incident lever but changes flag-off from "safe" to "stops all ingestion". Not
worth the standing footgun for a proven system.)

## Removal surface

| File                                         | Change                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workers/api/src/lib/source-actor-cohort.ts` | Trim to seed-jitter only: keep `fnv1a32`, `SEED_JITTER_WINDOW_MS`, `seedJitterMs`; drop `parseCohortPct`, `isSourceActorManaged`. Rename file → `source-actor-seed.ts` (clarity; only two importers, both edited anyway). Rewrite the module docstring.                                                                                                                            |
| `workers/api/src/index.ts`                   | `fanOutPollAndFetch`: remove the partition (lines ~1444-1452) and the `createBatch` + summary-workflow branch (~1497-1545); heartbeat `ensureScheduled` over all due sources. Drop the `isSourceActorManaged, parseCohortPct` import and the `SOURCE_ACTOR_ENABLED` / `SOURCE_ACTOR_COHORT_PCT` env-type fields. Keep `flag`/`FLAGS` (used elsewhere).                             |
| `workers/api/src/source-actor.ts`            | `alarm()`: remove the cohort self-check (lines ~228-240) — keep the source-deleted teardown above it. Drop `SOURCE_ACTOR_ENABLED` / `SOURCE_ACTOR_COHORT_PCT` (and unused `FLAGS?: FlagshipBinding`) from `SourceActorEnv`. Remove now-unused `flag`, `FLAGS`, `FlagshipBinding`, `isSourceActorManaged`, `parseCohortPct` imports; keep `seedJitterMs` (from the renamed module). |
| `workers/api/src/routes/sources.ts`          | Reparent hook: drop cohort gating → `if (c.env.SOURCE_ACTOR && (orgId/productId/fetchPriority changed)) waitUntil(onSourceChanged(...))`. Remove the `isSourceActorManaged, parseCohortPct` import.                                                                                                                                                                                |
| `packages/lib/src/flags.ts`                  | Remove the `sourceActorEnabled` registry entry + its comment.                                                                                                                                                                                                                                                                                                                      |
| `workers/api/wrangler.jsonc`                 | Remove `SOURCE_ACTOR_COHORT_PCT` from prod (line 155) and staging (line 776). Keep the `SOURCE_ACTOR` DO binding + migration entries.                                                                                                                                                                                                                                              |

`SOURCE_ACTOR_ENABLED` is only a flag-registry env fallback (never set as a
wrangler var), so there is no wrangler var to delete for the flag itself.

## Safety / sequencing

- Cohort is already 100% (#1791, deployed) → removing the dead `createBatch`
  branch is behavior-neutral in steady state; every source is actor-driven today.
- Single PR (cron + actor + routes + flags + config together) so there is no
  deploy window where neither path drives a source.
- **Flag cleanup follow-up:** after merge+deploy, delete the `source-actor-enabled`
  key from BOTH Flagship apps (`releases-platform`, `releases-platform-staging`).
  Tracked as a post-merge chore (same pattern as prior flag retirements).

## Testing

- `workers/api/test/source-actor-cohort.test.ts` → rename to
  `source-actor-seed.test.ts`; drop `parseCohortPct` / `isSourceActorManaged`
  cases, keep seed-jitter (`seedJitterMs`, `SEED_JITTER_WINDOW_MS`,
  determinism + windowing).
- `workers/api/test/source-actor.test.ts` → remove the cohort-gating alarm
  cases (flag-off / out-of-cohort → `stop`); keep scrape-lock, alarm
  scheduling, `noReschedule`, seed cases.
- `tests/api/poll-and-fetch-fanout.test.ts` → assert the heartbeat seeds
  `ensureScheduled` for **all** due sources and never calls `createBatch`;
  drop the partition assertions.
- Gate: `bun run check` + `workers/api` `bun test` green; `workers/discovery`
  untouched (its per-source lock wrappers don't reference the cohort).
