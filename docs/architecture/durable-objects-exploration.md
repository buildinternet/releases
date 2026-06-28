# Durable Objects: a per-entity actor architecture (design exploration)

> **Status: exploration, not shipped.** Every other doc in this directory describes a
> system that exists. This one is a design proposal — a sketch of how Cloudflare Durable
> Objects could absorb a cluster of orchestration "moving parts" the backend currently
> spreads across crons, Workflows, KV locks, and D1 scheduler columns. Nothing here is
> built. It exists to pin down the consistency model and the product-vs-source scoping
> decision before anyone writes code.

Reference: [Rules of Durable Objects](https://developers.cloudflare.com/durable-objects/best-practices/rules-of-durable-objects/).

## TL;DR

- **`SourceActor`** — one DO per source (`getByName(sourceId)`). Owns its own fetch timer
  (alarm), backoff, and single-threaded fetch serialization. Collapses the hourly poll
  cron + `PollAndFetchWorkflow` fan-out + jitter smear + retier + the KV `ma:active:src:*`
  lock + the `nextFetchAfter`/`lastPolledAt` scheduler columns + `workflow_failures`
  accrual into one self-driving object. **Highest leverage; build first.**
- **`ProductActor`** — one DO per product (`getByName(productId)`), parent over its source
  children. Owns **cross-source reconciliation** (coverage / "same launch" grouping), which
  has no online home today. Closes a real correctness gap and a double-decide race. **Build
  second, once children report upward.**
- **The DOs are not the database.** D1 stays the centralized, cross-org-queryable system of
  record. Actors hold only a bounded _coordination working set_ and **write their decisions
  through to D1** on the same path ingest already uses. There is no "sync DOs → Postgres"
  step because the DOs were never the master copy.
- **Do NOT** move read-surface rate limiting onto DOs — the per-colo CF native limiter is
  the right default; a DO would add cross-region latency to replace something free and fast.

## Why this, why now

A surprising amount of the backend's orchestration exists because there is **no per-entity
timer**. The API worker runs ~13 cron triggers fanning into one `scheduled()` handler, and
the hottest of them (`poll-and-fetch`) starts by _querying D1 for "what's due,"_ then fans
out one Workflow instance per source, then smears their starts with a deterministic
FNV-1a-hashed jitter to avoid a thundering herd on D1. That whole shape —
_global sweep → due-query → fan-out → per-row scheduler state in D1 columns_ — is exactly
what a DO alarm replaces with _each entity schedules itself_.

The current per-source coordination is emulated with three bolt-ons that a single-threaded
DO gives you for free:

- a KV lock `ma:active:src:{sourceId}` (in the `LATEST_CACHE` namespace) to stop a source
  fetching itself twice,
- a session-dedup window, and
- a `skipDelegation` header guard to stop a source colliding with itself on the delegation
  path.

And cross-source reconciliation — "the marketing post in source A and the changelog entry
in source B are the same launch" — has **no online home at all**:

- `clusterAndPersistCascades` only groups releases that arrive in the _same source's fetch
  batch_ (changesets monorepo cascades). Different sources land in different batches at
  different times, so it structurally can't see across them.
- Editorial coverage grouping is **batch agent work** — the `grouping-releases` skill,
  dispatched as a managed-agent session over an org's recent releases. Nothing reconciles
  continuously.

## How the Rules of Durable Objects map here

| Rule                                                  | How it applies                                                                                                                                                                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _Model around your atom of coordination_              | Fetching's atom is the **source**. Coverage/grouping's atom is the **product** (the set of sources that could cover one launch). Two atoms → two actor types.                                                       |
| _Use deterministic IDs_                               | `getByName(sourceId)` / `getByName(productId)` — the same entity always routes to the same instance.                                                                                                                |
| _Use parent-child relationships for related entities_ | `ProductActor` (parent) coordinates reconciliation across its `SourceActor` children; children own their fetch state independently. The doc's "workspaces with projects" example.                                   |
| _Don't create a single global DO_                     | Moves work off the existing global singletons (`ReleaseHub`, `StatusHub`) onto per-entity instances.                                                                                                                |
| _Use alarms for per-entity scheduled tasks_           | The source's fetch timer and the product's reconcile-debounce are both alarms — no incoming request needed.                                                                                                         |
| _Make alarm handlers idempotent_                      | Alarms can double-fire; every handler must be safe to run twice (re-fetch is naturally idempotent via the URL upsert; reconcile writes use `onConflictDoNothing`).                                                  |
| _Always `await` RPC calls_                            | The child→parent `notifyIngested` RPC must be awaited or errors get swallowed.                                                                                                                                      |
| _Avoid race conditions with non-storage I/O_          | Sources do `fetch()` (interleavable). Keep reconciliation off the fetch path — the parent reconciles in a storage-gated, single-threaded alarm, so two sources can't race to write conflicting canonical decisions. |
| _Use SQLite-backed DOs + index hot columns_           | The product's rolling reconciliation window is a small indexed SQLite table; clustering becomes a local query instead of D1 round-trips.                                                                            |
| _Understand in-memory vs persistent state_            | The window/backoff/locks are derived and bounded — reconstructable from D1 on eviction. Nothing authoritative lives only in a DO.                                                                                   |

## `SourceActor` — the child

One DO per source. Owns the fetch lifecycle.

### State (DO SQLite — derived, bounded, rehydratable)

- `nextAlarmAt` — when this source next fetches. Replaces the `queryDueSources` predicate.
- `backoffState` — consecutive-no-change / failure counters driving the 1h→72h exponential
  backoff. Replaces the `nextFetchAfter` D1 column as the _driver_ (D1 may still mirror it
  for the dev fetch-plan panel; see Observability).
- `tier` — `normal` (4h) / `low` (24h) / `paused`, mirrored from D1 on PATCH.
- `inFlight` — the single-threaded mutex is implicit (the object processes one alarm at a
  time), so the KV `ma:active:src:*` lock, the dedup window, and `skipDelegation` all go
  away.

### Behavior

```
alarm():
  if paused: return                      # no reschedule
  acquire-implicit-mutex (free: single-threaded)
  result = fetchAndIngest(sourceId)      # writes release rows to D1 (unchanged)
  if result.newReleases:
     await ProductActor(productId).notifyIngested(result.releaseIds)
     update backoff = reset
  else:
     update backoff = next step (1h→2h→…→72h)
  setAlarm(now + tierInterval ± perObjectSkew)   # jitter is emergent, not computed
  writeThroughSchedulerMirror(D1)        # optional, for observability
```

The jitter smear disappears: each source was last fetched at a different wall-clock time,
so each alarm already lands at a different time. No herd to smear.

### What it absorbs

The hourly poll cron, `PollAndFetchWorkflow`'s due-query + jitter, the 03:00 retier
(a source sees its own release gaps and can retier itself), the 04:00 force-drain, the KV
MA-lock, the session-dedup window, the `skipDelegation` guard, the
`nextFetchAfter`/`lastPolledAt` scheduler columns as _drivers_, and the `workflow_failures`
accrual (an actor holds its own failure count instead of N stateless workflow instances
writing to a D1 log that a summary workflow reconstructs 30 minutes later).

### Migration seam

This is the busiest path in the system, so stage it: **the DO owns the timer and
serialization; the existing `PollAndFetchWorkflow` still does the actual ingest work**,
invoked from the alarm via a service/RPC call. That keeps the proven step-retry ingest
pipeline intact while moving only the _scheduling_ into the actor. Flip sources over in
cohorts behind a flag; keep the cron as the binding-absent fallback (the codebase already
treats Workflows that way).

## `ProductActor` — the parent

One DO per product. Owns cross-source reconciliation.

### State (DO SQLite — a bounded working cache, NOT the master copy)

- A **rolling 30–90 day window** of recent releases across all the product's sources:
  `(release_id, source_id, title, url, published_at, content_fingerprint, canonical_id)`.
  Trimmed by an alarm, exactly like `ReleaseHub`'s 1000-event ring buffer.
- `pendingReconcile` — a debounce flag.

### Behavior

```
notifyIngested(releaseIds):              # awaited RPC from a child
  add rows to window (from D1 / payload)
  if not pendingReconcile:
     pendingReconcile = true
     setAlarm(now + 30s)                 # debounce: collapse a burst into one pass

alarm():                                  # reconcile pass (single-threaded, storage-gated)
  clusters = clusterWindow()             # local SQL + title/url near-dup + embed distance
  for each new cluster:
     write canonical + coverage links → D1 (onConflictDoNothing — never clobber manual)
     if ambiguous: escalate to grouping-releases agent session (don't guess editorially)
  pendingReconcile = false
  trimWindow(); maybe setAlarm(trim-horizon)
```

The debounce matters: a burst of sibling sources reporting in collapses into one
reconciliation pass instead of N. Reconciliation runs in the alarm (storage-gated,
single-threaded), never inside a child's `fetch()` path — so the source loop stays fast and
two sources can't double-decide the same launch.

### Division of labour with the agent

The actor does the **mechanical, continuous** reconciliation (changesets, near-duplicate
title/url/time, embedding distance) and forms coverage links _as the second source lands_ —
retroactively, which today's batch-time-only clustering can't do. The **editorial** call
("which item is the best reader entry point") stays with the `grouping-releases` agent
skill; the actor's job for hard cases is to _escalate_, not to guess.

### Where the clean tree breaks (honest edges)

- **Product-less sources.** A source can attach directly to an org with no product. So the
  parent can't always be a product. Resolution: `ProductActor` is the default atom; **org is
  the fallback parent** (`getByName(orgId)`) for orphan sources — same actor class, two
  grains, not two implementations.
- **Cross-product coverage.** Rare launches span two products; product-scoped reconciliation
  has a blind spot the org grain would catch. Accept it, or route those to the agent path.
- **Re-parenting is mutable.** A source can be PATCHed to a different product. DOs don't
  migrate membership automatically — the edit must notify both old and new parent actors.
- **Don't let it become a global DO in disguise.** It holds only the bounded working set;
  D1 stays the store.

## The consistency model: DOs own decisions, D1 owns records

This is the part that most needs to be written down, because the intuitive (and wrong)
mental model is "each actor persists all its records, then syncs to a warehouse."

**DO storage is per-object and islanded.** There is no query across all `ProductActor`s —
each object sees only its own SQLite. So the moment you want anything universally queryable
(`/v1/releases/latest`, search, the MCP `search` tool, the web homepage), you _must_ have a
central store the DOs feed. The hierarchy doesn't remove the central DB — **it makes it
mandatory.** That central DB is **D1, today, already**, and every read surface keeps hitting
it unchanged.

### Write path

```
SourceActor.alarm
   ├─► writes release rows ─────────────────────► D1   (the centralized record, unchanged)
   └─► await ProductActor.notifyIngested(ids)
          └─► reconciles over its window (DO SQLite = bounded cache)
          └─► writes coverage links + canonical flag + curated fields ─► D1
```

Two writers, both landing in D1: the source writes the _raw record_, the product writes the
_decisions about it_ (the same `INSERT … onConflictDoNothing` into `release_coverage` that
`clusterAndPersistCascades` does today). **No separate sync step, no outbox, no second
database** — the actors use the same D1 binding ingest uses now.

### What lives where

| DO SQLite (per-entity, ephemeral-ish, rehydratable) | D1 (central, global, source of truth)                 |
| --------------------------------------------------- | ----------------------------------------------------- |
| fetch timer / next-alarm / backoff counter          | canonical release rows                                |
| in-flight fetch lock (the single-thread mutex)      | coverage links + canonical / curated fields           |
| `ProductActor`'s rolling 30–90 day reconcile window | products, orgs, sources — everything read paths query |
| `pendingReconcile` debounce flag                    | search / embedding indexes                            |

The framing: **the DO owns the _decision_; D1 owns the _record_.** The DO is where "are
these the same launch?" gets computed (it needs single-threaded cross-source coordination);
D1 is where the answer gets stored so the whole world can query it.

### Eviction / durability

Nothing authoritative lives only in a DO. If a `ProductActor` is evicted, rehydrate its
window from D1 (`SELECT … WHERE product_id = ? AND published_at > now-90d`) and carry on. A
`SourceActor`'s backoff/timer can be reconstructed from `lastFetchedAt` + tier. The DO is a
coordinator + cache + scheduler, not a shard of the database.

### "...or Postgres?"

You don't need a separate Postgres — **D1 _is_ the relational central store** (SQLite under
the hood, replicated, globally queryable). If you ever outgrow it (size ceilings, write
throughput, the 100-bind-param limit on analytical queries), the migration is "swap the
center from D1 to Postgres behind Hyperdrive" — and the actors don't care: they write
through to whatever the central binding is. **The DO layer is agnostic to whether the middle
is D1 or Postgres.**

### Write-through vs. outbox

Two ways to do the central write; pick deliberately:

1. **Write-through (recommended here).** The actor writes decisions to the central DB inline
   during its alarm, same as ingest does now. Immediate read consistency, no lag, nothing
   extra to operate. Correct default at this scale (~10 releases/hr).
2. **Outbox / batched flush.** The actor writes to its own SQLite, marks rows dirty, and a
   drain flushes to the center periodically. This _is_ the "DO buffers, then syncs to the
   warehouse" pattern — but it buys eventual-consistency lag and an outbox to manage. Only
   worth it if central-DB write latency in the hot path becomes a real bottleneck. It won't
   at current volume.

**The whole proposal is a write-path coordination refactor, not a datastore change.** The
read path is untouched.

## Observability tradeoff

The one real loss: today a single SQL query answers "what's due / backed-off / starved"
(the dev fetch-plan panel reads `lastPolledAt` / `nextFetchAfter` / `changeDetectedAt`
directly). With self-scheduling actors that global view is gone unless you reconstruct it.
Options: (a) have `SourceActor` write-through a scheduler mirror to D1 (`nextAlarmAt`,
`backoffStep`) on each alarm — cheap, keeps the panel working; or (b) a directory DO /
periodic sweep that asks actors their next-alarm time. (a) is simpler and recommended.

## What NOT to put on a DO

**Read-surface rate limiting.** DOs give _globally consistent_ counters, and the wrangler
config even notes the native limiter is per-colo — so it looks like a fit. But every request
would hit a (possibly cross-region) DO to replace something currently free and fast. The
per-colo CF native limiter is the right default; the KV-backed `/api/auth/*` brute-force
limiter (#1728) is similarly fine where it is. Only reach for a DO here for a specific
global-abuse case the per-colo approximation genuinely can't catch.

## Sequencing

1. **`SourceActor`** — the load-bearing prototype. Where the cron/workflow/KV-lock collapse
   happens. Stage behind a flag with the cron as fallback; DO drives scheduling, existing
   workflow still ingests via RPC.
2. **`ProductActor`** — once children report on ingest, the parent that reconciles across
   them is a small additional surface. Earns its keep on _correctness_ (coverage forms when
   it should; no double-decide race) more than on deleting crons — be clear-eyed that it's a
   smaller cron-deletion win than the source layer.
3. **Org-grain fallback + product overview/well-known self-scheduling** — fold the remaining
   product/org-level crons (overview staleness regen, `releases.json` mapping) into the same
   parent actors once the pattern is proven.

## Open questions to settle before building

- **Atom for reconciliation: product vs org.** Product is tighter; org catches
  cross-product and product-less cases. Proposal: product default, org fallback grain — but
  confirm coverage relationships are overwhelmingly intra-product first.
- **Does backoff state stay mirrored in D1**, or does the dev fetch-plan panel move to
  querying actors? (Recommend: mirror, for cheapness.)
- **Re-parenting protocol** — exactly how a source PATCH notifies old + new `ProductActor`.
- **Window horizon** — 30 / 60 / 90 days for the reconcile window; longer catches
  slow-trickle coverage but grows DO storage.
  </content>
  </invoke>
