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

- No new demotion/pruning logic. A sweep-created stub carries a `domain`, so the
  existing `wellKnownSync` Pass 1 already reconciles it; if its manifest later
  disappears, its locators prune through the normal reconcile path. This directly
  addresses the #1922 caution (sweep-created stubs are declared-basis and must
  prune when the manifest disappears) by *inheriting* pruning rather than adding
  a parallel mechanism.
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
governs all manifest→stub creation. Also honors `CRON_ENABLED === "false"` like
the sibling sweeps. No new flag.

**Candidate query** — unlisted, due, highest-demand-first, capped:

```sql
SELECT d.domain
FROM domain_demand d
LEFT JOIN organizations o
  ON o.domain = d.domain AND o.deleted_at IS NULL
WHERE o.id IS NULL                                   -- not already an org
  AND (d.swept_at IS NULL OR d.swept_at < :cutoff)   -- due-filter
ORDER BY d.hit_count DESC, d.swept_at ASC            -- demand, then oldest probe (NULLs first)
LIMIT :maxPerRun
```

- `cutoff = now − intervalHours`. Reuse a `WELL_KNOWN_SWEEP_INTERVAL_HOURS`-style
  env, default 168h (7d): a domain with no manifest today cools down and is
  retried later (a manifest may appear).
- `maxPerRun` default 250 (each candidate is one `createStubFromManifest` call =
  one manifest fetch; ≤250 subrequests, well under the 1000/invocation ceiling).
  Env-tunable, floor 1.
- The anti-join on `organizations.domain` is why the sweep never re-creates or
  duplicates an existing org — `createStubFromManifest`'s own `org_exists` skip
  is the belt-and-suspenders for a race.

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
  AND last_seen_at < :pruneCutoff   -- now − 30d
```

Single-hit, stale, already-probed rows are junk (a one-off typo/bot lookup for a
domain that had no manifest). Genuine repeat demand (`hit_count > 1`) is never
pruned.

**Summary log** (`logEvent("info", …)`) mirrors `well-known-sync`'s `sweep-done`:
`processed`, `created`, `skipped` (by reason bucket), `pruned`, `capped`
(`processed >= maxPerRun`), `maxPerRun`, `intervalHours`.

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
