# Manifest sweep → stubs for unlisted domains (#1947)

**Status:** Design
**Date:** 2026-07-07
**Epic:** #1947 (stub tier). Follows phase 3 (self-serve `/submit` fast lane, #1972).

## Problem

Today a stub for an *unlisted* domain is only created when a human actively hits
`/submit` (or `releases json validate`), which drives `POST /v1/listing/activate`.
The daily well-known sweep (`cron/well-known-sync.ts`) only reconciles domains
that are *already listed* — it iterates `organizations` and `github` sources. So
a domain that publishes a valid `/.well-known/releases.json` but that nobody has
manually submitted is never discovered.

We want a demand-driven background sweep that discovers such domains from real
lookup traffic and activates a stub for any that publish a valid manifest —
without a curator or owner in the loop, matching the epic's ladder
("promotion is demand-driven: follows, lookup hits, owner request, curator").

## Non-goals

- No new demotion/pruning logic, and specifically **no handling of the
  manifest-disappears case** for sweep-created stubs. This is deliberate: a
  sweep-created stub is byte-for-byte the same entity a manually-activated stub
  (`POST /v1/listing/activate`) produces, and that entity *already* has this
  property today — `syncOrgWellKnown` returns early on a failed/absent fetch
  (`!fetched.ok`) without pruning locators or the org, so an existing stub whose
  manifest vanishes already persists. This sweep creates more of the same entity;
  it introduces no new pruning obligation. Cleaning up stubs whose manifest
  disappears is #1922's scope, tracked separately, and applies equally to
  manually-activated and sweep-activated stubs. A persisted orphan stub is
  low-harm: `noindex`, sitemap-excluded, catalog-badged `(stub)`, and excluded
  from ticker/featured/release-ranked surfaces.
- No promotion to live tracking. The sweep creates stubs only; promotion stays
  curator-gated via `tracking_requested_at` (self-serve Tier-1 is a later phase).
- No candidate source beyond captured lookup misses (curator-seeded candidates
  are a trivial future superset — another row in the same table).

## Overview

Two independent pieces:

1. **Demand capture** — record unresolved domain lookups into a new
   `domain_demand` D1 table, fire-and-forget from the read path.
2. **Demand sweep** — a new daily cron that pulls the highest-demand unlisted
   domains, probes each domain's manifest, and activates a stub for any valid
   one via the existing `createStubFromManifest`.

```
GET /lookups/by-domain (404)  ─┐
POST /v1/lookups (domain miss) ─┴─ waitUntil ─▶ domain_demand (upsert hit_count++)
                                                      │
                                          cron 0 4 * * *  (domain-demand-sweep)
                                                      │
                                   candidates = unlisted, due, top hit_count
                                                      │
                                   createStubFromManifest(domain)  ─▶ stub org + locators
                                                      │
                                          stamp swept_at; prune stale junk
```

## Data model

New table in `packages/core/src/schema.ts` (source of truth), paired migration
under `workers/api/migrations/`.

```ts
export const domainDemand = sqliteTable(
  "domain_demand",
  {
    // Normalized hostname (lowercased, no scheme/path/www) — the natural key.
    domain: text("domain").primaryKey(),
    firstSeenAt: integer("first_seen_at").notNull(),
    lastSeenAt: integer("last_seen_at").notNull(),
    hitCount: integer("hit_count").notNull().default(1),
    // NULL = never probed by the sweep. Set on every sweep attempt regardless
    // of outcome (the due-filter clock). Epoch millis, matching the columns.
    sweptAt: integer("swept_at"),
  },
  (table) => [
    // Candidate ordering: highest demand, least-recently-probed first.
    index("idx_domain_demand_hitcount_swept").on(table.hitCount, table.sweptAt),
  ],
);
```

Timestamps are integer epoch millis, matching the nearest analog (`search_queries`).
`domain` is the primary key so the upsert is a single `ON CONFLICT` with no
secondary uniqueness concern.

## Demand capture

A small helper `recordDomainDemand(db, domain)` in
`workers/api/src/lib/listing/domain-demand.ts`:

```ts
INSERT INTO domain_demand (domain, first_seen_at, last_seen_at, hit_count)
VALUES (?, ?, ?, 1)
ON CONFLICT (domain) DO UPDATE
  SET hit_count = hit_count + 1, last_seen_at = excluded.last_seen_at
```

Call sites (both fire-and-forget via `c.executionCtx.waitUntil(...)`, wrapped so a
failure is swallowed and logged at `warn` — same fail-open posture as the
search-query log; capture must never add latency or a failure mode to a read):

- **`GET /lookups/by-domain`** (`routes/lookups.ts`) — on the 404 branch, after
  `normalizeDomain` yields a valid host. Record the normalized domain.
- **`POST /v1/lookups`** (`routes/lookups.ts`) — on the domain-coordinate path
  when it resolves to nothing.

**Excluded:** `search?domain=` (search-narrowing param — noisier, lower intent).

Only syntactically valid normalized hostnames are recorded (the routes already
`normalizeDomain` and reject invalid input before the miss branch), which is the
first bound on junk accumulation.

## Demand sweep

New file `workers/api/src/cron/domain-demand-sweep.ts`, wired into the daily
`0 4 * * *` scheduled handler next to the existing sweeps.

**Gate:** `listing-self-serve-enabled` (existing flag, `FLAGS.listingSelfServeEnabled`
+ `LISTING_SELF_SERVE_ENABLED` var). This is the same "create stubs from live
manifests" posture as the activate route, just server-initiated — one switch
governs all manifest→stub creation, and doubles as the kill switch if the sweep
misbehaves. Also honors `CRON_ENABLED === "false"` like the sibling sweeps.
No new flag.

**No env knobs — hardcoded constants.** An env var is the same maintenance
surface as a flag minus the dashboard, and none of these will be tuned at
runtime (tuning is a one-line PR). At the top of the file:

```ts
const SWEEP_RETRY_DAYS = 7;   // re-probe cadence for a domain the sweep found nothing on
const MAX_PER_RUN = 100;      // effective daily stub-creation cap; << CF 1000-subrequest ceiling
const PRUNE_STALE_DAYS = 30;  // age past which a single-hit, already-probed junk row is deleted
```

`MAX_PER_RUN = 100` (not 250) is deliberately modest: it leaves ample subrequest
headroom for the sibling sweeps sharing the `0 4 * * *` tick, and — see the
rate-limit note below — it *is* the sweep's effective rate limit.

**Candidate query** — unlisted, due, highest-demand-first, capped:

```sql
SELECT d.domain
FROM domain_demand d
LEFT JOIN organizations o
  ON o.domain = d.domain AND o.deleted_at IS NULL
WHERE o.id IS NULL                                   -- not already an org
  AND (d.swept_at IS NULL OR d.swept_at < :cutoff)   -- due-filter
ORDER BY d.hit_count DESC, d.swept_at ASC            -- demand, then oldest probe (NULLs first)
LIMIT :MAX_PER_RUN
```

- `cutoff = now − SWEEP_RETRY_DAYS` (7d): a domain with no manifest today cools
  down and is retried later (a manifest may appear).
- `MAX_PER_RUN` (100): each candidate is one `createStubFromManifest` call = one
  manifest fetch, so ≤100 subrequests — well under the 1000/invocation ceiling
  with room to spare for the sibling sweeps on the same tick.
- The anti-join on `organizations.domain` is why the sweep never re-creates or
  duplicates an existing org — `createStubFromManifest`'s own `org_exists` skip
  is the belt-and-suspenders for a race.

**SSRF is inherited, not re-implemented.** Every probe goes through
`createStubFromManifest` → `fetchReleasesJson`, which already enforces HTTPS-only
and screens the parsed host with `isPrivateOrLocalHost` (rejecting IP literals,
`localhost`, and private ranges). The public capture route therefore cannot turn
the cron into an internal-network prober — the shared fetch path is the single
SSRF chokepoint. No host-class filter is added here.

**The sweep runs without the activate route's per-IP / per-domain rate limits, by
design.** `/listing/activate` is 10/min-IP + 3/min-domain; the sweep has no human
in the loop, so `MAX_PER_RUN` is its effective daily cap. This grants no new
capability — a stub still requires a real, valid, host-scoped manifest to exist
(an attacker can only get *their own* domain listed) — it only removes the
per-request cost, which the modest cap bounds.

**Per candidate** (sequential, `no-await-in-loop` disabled with a rationale
comment, mirroring `well-known-sync`):

1. `const r = await createStubFromManifest(db, domain, { fetchImpl })`.
   This is the **shared activation core** — it already fetches the manifest,
   validates it against the v2 schema, applies every carve-out (org-exists skip,
   registry-org-declared skip, reserved-slug skip, invalid/absent manifest), and
   writes the stub org + declared locators. No new `activateListing` wrapper is
   introduced: `createStubFromManifest` *is* the single source of truth the
   `/listing/activate` route already delegates to, so reusing it directly keeps
   the carve-outs in exactly one place (a refinement over the earlier idea of
   extracting a second wrapper, which would only re-wrap this function).
   The sweep never sets `tracking_requested_at` — there is no owner asking; a
   sweep-discovered stub sits at the bottom of the ladder until real demand
   (follows/owner request) promotes it.
2. Stamp `swept_at = now` on the `domain_demand` row regardless of outcome (the
   due-filter clock). A `created`/`skippedReason` tally goes to the sweep's
   summary log.

**Prune step** (once per run, after the loop) — bound table growth against a
public capture route:

```sql
DELETE FROM domain_demand
WHERE hit_count = 1
  AND swept_at IS NOT NULL          -- already probed and found nothing worth keeping
  AND last_seen_at < :pruneCutoff   -- now − PRUNE_STALE_DAYS (30d)
```

Single-hit, stale, already-probed rows are junk (a one-off typo/bot lookup for a
domain that had no manifest). Genuine repeat demand (`hit_count > 1`) is never
pruned.

**Summary log** (`logEvent("info", …)`) mirrors `well-known-sync`'s `sweep-done`:
`processed`, `created`, `skipped` (by reason bucket), `pruned`, `capped`
(`processed >= MAX_PER_RUN`).

## Error handling

- Capture: fail-open, swallowed + `warn`-logged; never touches the read response.
- Per-candidate `createStubFromManifest` failure: caught, logged at `error` with
  the domain, `swept_at` still stamped (so a persistently failing domain cools
  down and doesn't jam the head of the queue), loop continues.
- Whole-sweep guard: `CRON_ENABLED` + flag checks short-circuit with an info log,
  exactly like the sibling sweeps.

## Testing

- **Schema/migration:** paired migration; `bun run db:reset:local` applies clean.
- **Capture unit test:** `recordDomainDemand` inserts then increments `hit_count`
  / advances `last_seen_at` on conflict.
- **Route capture tests:** `/lookups/by-domain` 404 and `POST /v1/lookups`
  domain-miss each enqueue a demand row (in-process route smoke with a real
  in-memory D1, asserting the row after `waitUntil` drains); a *hit* records
  nothing.
- **Sweep tests** (`cron/domain-demand-sweep.test.ts`, injected `fetchImpl`):
  - valid manifest on an unlisted due domain → stub created, `swept_at` stamped;
  - domain already owning an org → excluded by the anti-join (no fetch);
  - no/invalid manifest → no stub, `swept_at` stamped, loop continues;
  - due-filter: a recently-swept domain is skipped;
  - ordering: higher `hit_count` processed before lower under a cap of 1;
  - prune: a stale single-hit probed row is deleted; `hit_count > 1` survives;
  - flag off / `CRON_ENABLED=false` → no-op.

## Files

- `packages/core/src/schema.ts` — `domainDemand` table + types.
- `workers/api/migrations/2026070800…_add_domain_demand.sql` — paired migration.
- `workers/api/src/lib/listing/domain-demand.ts` — `recordDomainDemand`.
- `workers/api/src/routes/lookups.ts` — two `waitUntil` capture call sites.
- `workers/api/src/cron/domain-demand-sweep.ts` — the sweep + prune.
- Scheduled handler (`workers/api/src/index.ts` or wherever `0 4 * * *` fans out)
  — wire `domainDemandSweep(env)` next to the existing sweeps.
- Tests as above.

## Rollout

- Migration + workers auto-apply on merge.
- `listing-self-serve-enabled` already exists in both Flagship apps (created in
  phase 2) and is on — so the sweep is live on first daily tick after deploy.
  No new flag key, no manual deploy step.
```
