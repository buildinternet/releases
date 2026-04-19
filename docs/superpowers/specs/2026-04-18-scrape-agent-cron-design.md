# 2026-04-18 · Scrape-no-feed Agent Cron Design

Closes part 3 of #319. Finishes the automation story started in #320 (cron fetches scrape-with-feed), #321 (cadence-driven retier), #322 (retier observability), and #324 (feed rediscovery tool).

## Problem

Today 31 scrape-type sources have no discoverable feed and no one picks them up automatically. The hourly poll-and-fetch cron flags them via `changeDetectedAt` when a HEAD check detects upstream motion, but the downstream step — running the managed worker agent to render, parse, and insert releases — only happens when a human types `releases admin source fetch --changed`. Left alone, these sources accumulate backlog indefinitely.

The rediscovery tool from #324 shrunk the set from 34 to 31 (notion-releases promoted to the feed path). The remaining 31 genuinely need AI rendering + parsing because they have no feed.

## Goals

- Drain flagged scrape-no-feed sources automatically on a daily schedule.
- Reuse the existing managed-agents path (`claude-haiku-4-5` via `ANTHROPIC_WORKER_AGENT_ID`, dispatched by the discovery worker's `POST /update`) — no new agent, no new tools, no direct Anthropic Messages API calls for the actual work.
- Cap worst-case cost via a tunable `SCRAPE_AGENT_MAX_SESSIONS` ceiling (default 20 sessions per sweep × ~$0.20 = ~$4/day ceiling).
- Produce observable, query-able run history so operators can tell at a glance what happened yesterday and whether it's time to escalate.

## Non-goals

- No circuit breaker for sustained dispatch failures — runbook-only in v1, with a `TODO` in code.
- No backfilling of the existing `retier` or `poll-fetch` crons into the new `cron_runs` table — the `cron_name` discriminator is there for a future follow-up, but retrofitting those crons changes their control flow for a side concern.
- No auto-pause based on cadence signal — still blocked on #321's deferred `fetchPriorityAutomatic` schema work.
- No manual-trigger HTTP endpoint — `wrangler cron trigger` is sufficient.

## Architecture

### Control flow (daily 01:00 UTC on the API worker)

The scheduled handler in `workers/api/src/index.ts` already branches on `event.cron`. A third branch dispatches to a new module `workers/api/src/cron/scrape-agent-sweep.ts`:

1. **Gate** on `CRON_ENABLED !== "false"` AND `SCRAPE_AGENT_CRON_ENABLED !== "false"`. If either is false, short-circuit with a log line — no `cron_runs` row written (matches existing cron behavior).
2. **Reconcile stale `running` rows** for this `cron_name` older than 10 minutes. Mark them `status='aborted'`, `abort_reason='stale_running'`, `ended_at=now`.
3. **Insert** a new `cron_runs` row with `status='running'`, `started_at=now`.
4. **Pre-flight** Anthropic: `GET https://api.anthropic.com/v1/models` with a 3s timeout. Classify per the matrix in §5.2. Abort or proceed.
5. **Candidate query** (§3). Pull `cap + 1` rows. Slice to `cap`; count `skipped_over_cap`.
6. **Group by `org_id`**. Source IDs preferred over slugs (AGENTS.md convention).
7. **Dispatch** per-org groups via `runWithConcurrency(groups, 3, dispatchOne)`. Each `dispatchOne` calls `env.DISCOVERY_WORKER.fetch('https://discovery/update', ...)`.
8. **Derive final status** from dispatch results (see Dispatch → Status derivation).
9. **Update** the `cron_runs` row with final counts, status, session IDs, errors, and notes.

No polling on session completion. No within-sweep retries. Sweep wall time is bounded at ~10s even in pathological cases; the CF scheduled-event 30-minute budget is never at risk.

### Why reuse discovery worker's `/update`

The discovery worker already exposes `POST /update` that:

- Validates `ANTHROPIC_API_KEY` and agent config
- Spins up a `ManagedAgentsSession` Durable Object per call
- Invokes the worker agent (`claude-haiku-4-5`) in `mode: "update"`
- Returns `{ sessionId, status: "running" }` synchronously
- Caps at 20 source identifiers per call (`MAX_UPDATE_SOURCES`)

The cron is plumbing in front of this; it does not replicate agent orchestration, tool dispatch, or release insertion — those already work in production today via human invocation.

### Anthropic pre-flight

One `GET https://api.anthropic.com/v1/models` call per sweep before any dispatch. The endpoint returns metadata (not inference), is not token-billed, and validates the `ANTHROPIC_API_KEY` secret bound to the API worker (same secret used by the discovery worker, ensuring consistent auth between pre-flight and session execution).

Classifications (this is the single source of truth for the preflight matrix — the code and the status-derivation tests reference this table):

| response                                           | action         | `abort_reason`      |
| -------------------------------------------------- | -------------- | ------------------- |
| 200                                                | proceed        | —                   |
| 401 / 403                                          | abort          | `anthropic_auth`    |
| 402                                                | abort          | `anthropic_credits` |
| 429 with `error.type === 'credit_balance_too_low'` | abort          | `anthropic_credits` |
| 429 (other)                                        | warn + proceed | —                   |
| 5xx                                                | warn + proceed | —                   |
| timeout (3s)                                       | warn + proceed | —                   |

The 429-credits check reads response body (cap 1 KB, JSON.parse in try/catch; malformed body falls through to warn).

## Data model

### New table: `cron_runs`

Defined in `workers/api/src/db/schema-cron.ts` (worker-scoped, following the `src/db/schema-coverage.ts` precedent). Not added to `@buildinternet/releases-core`; the CLI has no reason to read or write it.

| column                  | type                       | notes                                                                                                                                       |
| ----------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`                    | TEXT PK                    | `crun_<nanoid>`. New `newCronRunId()` helper in `@buildinternet/releases-core/id`.                                                          |
| `cron_name`             | TEXT NOT NULL              | Discriminator. Starts as `'scrape-agent-sweep'`; schema supports future crons reusing the table.                                            |
| `started_at`            | TEXT NOT NULL              | ISO                                                                                                                                         |
| `ended_at`              | TEXT                       | Null while running                                                                                                                          |
| `duration_ms`           | INTEGER                    | Cached on final write                                                                                                                       |
| `status`                | TEXT NOT NULL              | `'running' \| 'done' \| 'degraded' \| 'dispatch_failed' \| 'aborted'`                                                                       |
| `candidates`            | INTEGER NOT NULL DEFAULT 0 | Rows returned by candidate query                                                                                                            |
| `dispatched`            | INTEGER NOT NULL DEFAULT 0 | `/update` calls that returned 202                                                                                                           |
| `skipped_over_cap`      | INTEGER NOT NULL DEFAULT 0 | Dropped by `SCRAPE_AGENT_MAX_SESSIONS`                                                                                                      |
| `dispatch_errors`       | INTEGER NOT NULL DEFAULT 0 | Count of failed per-org dispatches                                                                                                          |
| `sessions_started`      | TEXT                       | JSON array of session IDs (cap 20 entries)                                                                                                  |
| `dispatch_error_detail` | TEXT                       | JSON `[{orgSlug, error}]` (cap 20 entries)                                                                                                  |
| `abort_reason`          | TEXT                       | Null unless `status='aborted'`. Values: `'anthropic_auth' \| 'anthropic_credits' \| 'stale_running' \| 'cron_disabled' \| 'config_missing'` |
| `notes`                 | TEXT                       | Free-form human-readable summary                                                                                                            |

Index: `idx_cron_runs_name_started ON (cron_name, started_at DESC)`.

Timestamp-prefixed migrations: `src/db/migrations/YYYYMMDDHHMMSS_cron_runs.sql` + `workers/api/migrations/YYYYMMDDHHMMSS_cron_runs.sql`. Purely additive — `CREATE TABLE` + `CREATE INDEX`, no backfill, no rewrites.

Expected row growth: ~365 rows per cron per year. No retention policy in v1.

### New ID helper

`newCronRunId()` added to `@buildinternet/releases-core/id` alongside the existing helpers. One assertion added to `tests/unit/id.test.ts` locks the `crun_` prefix.

## Candidate selection

```sql
SELECT
  s.id, s.slug, s.org_id,
  o.slug AS org_slug, o.name AS org_name,
  s.change_detected_at
FROM sources s
INNER JOIN organizations o ON o.id = s.org_id
WHERE
  s.type = 'scrape'
  AND s.fetch_priority != 'paused'
  AND s.change_detected_at IS NOT NULL
  AND (json_extract(s.metadata, '$.feedUrl') IS NULL OR s.metadata IS NULL)
  AND s.is_hidden = 0
ORDER BY s.change_detected_at ASC
LIMIT :cap
```

`:cap` is `SCRAPE_AGENT_MAX_SESSIONS + 1` so we can detect "more than the cap" without always paying for a `COUNT(*)`. If the query returns `cap + 1` rows, the last row is sliced off before grouping, and `skipped_over_cap` is populated via a single follow-up `COUNT(*)` with the same `WHERE` clause. If the query returns `≤ cap` rows, the count query is skipped entirely — most sweeps take this fast path.

Filter rationale:

- `type = 'scrape'`: this cron exists for the no-feed scrape flow specifically.
- `fetch_priority != 'paused'`: mirrors #321's retier. Manually paused sources stay paused.
- `change_detected_at IS NOT NULL`: only work on upstream-flagged sources.
- `feedUrl IS NULL`: excludes scrape-with-feed sources (those flow through #320's cron).
- `is_hidden = 0`: standard `notDisabled` guard.
- `INNER JOIN organizations`: sources without an org can't be dispatched via `/update` (which requires `company`). Any such row logs a warning and silently drops.

Grouping: in-memory, by `org_id` → `Map<orgId, { orgName, orgSlug, sources[] }>`.

## Dispatch

```ts
async function dispatchOne(group: OrgGroup, ctx: SweepContext): Promise<DispatchResult> {
  try {
    const res = await ctx.env.DISCOVERY_WORKER.fetch("https://discovery/update", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${ctx.apiKey}`,
      },
      body: JSON.stringify({
        company: group.orgName,
        sourceIdentifiers: group.sources.map((s) => s.id),
        orgId: group.orgId,
        correlationId: `${ctx.sweepCorrelationId}:${group.orgSlug}`,
      }),
    });
    if (!res.ok) {
      return {
        orgSlug: group.orgSlug,
        ok: false,
        error: `${res.status} ${await res.text().catch(() => "")}`,
      };
    }
    const { sessionId } = (await res.json()) as { sessionId: string };
    return { orgSlug: group.orgSlug, ok: true, sessionId };
  } catch (err) {
    return {
      orgSlug: group.orgSlug,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
```

Concurrency: `runWithConcurrency(groups, 3, dispatchOne)`. **Extract** the existing helper from `workers/api/src/cron/poll-fetch.ts:749` to `workers/api/src/lib/concurrency.ts`; re-import in poll-fetch. Same implementation, shared consumer.

### Status derivation

| case                   | `status`          | `abort_reason`                          |
| ---------------------- | ----------------- | --------------------------------------- |
| pre-flight aborted     | `aborted`         | `anthropic_auth` \| `anthropic_credits` |
| 0 candidates           | `done`            | —                                       |
| all dispatches 200     | `done`            | —                                       |
| some dispatches failed | `degraded`        | —                                       |
| all dispatches failed  | `dispatch_failed` | —                                       |

### Idempotency

Double-firing (manual + scheduled overlap) spawns two sessions per org. Existing `UNIQUE(source_id, url)` on `releases` deduplicates at insert. Noisier than ideal but not corrupting. No duplicate-run detection in v1.

## Failure handling

- **Stuck `running` rows** reconciled at the top of each sweep. Any row with `status='running'` for the same `cron_name` older than 10 minutes is marked `aborted` with `abort_reason='stale_running'` before the new row is inserted. One sweep's wallclock budget is ~10s; anything older is guaranteed dead. No separate janitor job.
- **Pre-flight failures** classified per the matrix under Architecture → Anthropic pre-flight.
- **Sustained dispatch failures**: no circuit breaker in v1. Per-sweep cost under sustained failure is one D1 read + one Anthropic models call + N failed HTTP calls to an in-cluster service binding (cents per day). A `TODO` comment in the sweep module notes the breaker could track consecutive `dispatch_failed` rows if it's ever needed. Runbook calls for escalation on two consecutive `dispatch_failed` rows for the same `cron_name`.
- **`CRON_ENABLED=false`** or `SCRAPE_AGENT_CRON_ENABLED=false`: short-circuit at the top of the function with a log line, no `cron_runs` row written. Matches the other crons' behavior and avoids a `disabled` row per day of noise.
- **CPU/wallclock budget**: no explicit timeout wrapping at the function level. CF scheduled events have a 30-minute wallclock budget; worst-case sweep wallclock is ~60s. If the runtime terminates a misbehaving sweep, the stuck-`running`-row reconciler picks up the pieces on the next run.
- **Per-source outcomes**: captured in `fetch_log` by the agent's existing `scrape-fetch.ts:writeFetchLog` path. Cross-linked to `cron_runs` via `session_id` — no duplicate per-source logging in `cron_runs`.
- **Post-dispatch paranoia check explicitly rejected**: blocking the sweep to poll session completion and assert ≥1 insert would couple sweep lifetime to async session execution (sessions legitimately take 2+ minutes each) and waste the CF budget. Systemic "every session produces 0 inserts" failures surface in `fetch_log` status counts via the dashboard; they're not something a cron-level assertion can fix.

## Observability

### API routes

- `GET /v1/admin/cron-runs` — admin-gated list. Query params: `cron`, `limit` (max 200), `status` (CSV), `since` (ISO, default last 30 days).
- `GET /v1/admin/cron-runs/:id` — single row hydrated with related session state (from the existing sessions hub) and per-session `fetch_log` status breakdowns.
- `GET /v1/admin/cron-runs/recent/:cron_name` — last 7 rows for monitoring scripts. Low-priority; can be cut if we need to trim scope.

Routes live in `workers/api/src/routes/admin-cron-runs.ts`, mounted under `v1.route("/admin", ...)` alongside `admin-embed`. Auth via `authMiddleware` (bearer token).

### Dashboard

New `Cron` tab on the dev-gated `/status` page (`web/src/app/status/dashboard.tsx`). Same tab infrastructure as Sessions/Sources/Fetch Log.

Row format:

```
cron                started        dur    status       outcome
scrape-agent-sweep  Apr 18, 01:00  1.2s   done         12/12
scrape-agent-sweep  Apr 17, 01:00  3.4s   degraded     8/10 · 2 err
scrape-agent-sweep  Apr 16, 01:00  9.1s   aborted      anthropic_auth
scrape-agent-sweep  Apr 15, 01:00  1.8s   done         14/14
```

Click-through expands to a drill-down with per-org dispatch breakdown, session-level status, and per-session `fetch_log` counts joined by session ID. Links out to `/v1/sessions/:sessionId` for agent trace inspection.

Styling reuses `FetchStatusBadge`, `LocalTimestamp`, `formatFetchDuration` from the existing `fetch-log-shared` component library.

### Runbook (captured in AGENTS.md)

```
The `cron_runs` table records every scheduled-event execution. `/status` →
Cron tab shows the last 50 rows across all crons; filter `?status=aborted,
dispatch_failed` for "things worth looking at." Two consecutive
`dispatch_failed` rows for the same `cron_name` means escalate — the
likely cause is a bad deploy of the downstream worker. `aborted` with
`abort_reason='anthropic_auth'` means replace the ANTHROPIC_API_KEY
secret; `anthropic_credits` means top up the account. Stale-running rows
(reconciled by next sweep) are informational.
```

## Config

### Environment variables (in `workers/api/wrangler.jsonc`)

| var                         | default  | effect                                                                                                                                           |
| --------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CRON_ENABLED`              | `"true"` | Existing; `"false"` disables every cron.                                                                                                         |
| `SCRAPE_AGENT_CRON_ENABLED` | `"true"` | New; per-cron toggle. Both must be truthy.                                                                                                       |
| `SCRAPE_AGENT_MAX_SESSIONS` | `"20"`   | Cap (Q3). Invalid values fall back to `20` with a warning. Code comment notes this could differentiate by `fetchPriority` in a future iteration. |

### Cron trigger (in `workers/api/wrangler.jsonc`)

```jsonc
"crons": [
  "0 * * * *",     // hourly: poll + fetch feed/github
  "0 3 * * *",     // daily 03:00 UTC: fetchPriority retier
  "0 1 * * *"      // daily 01:00 UTC: scrape-no-feed agent sweep
]
```

### Scheduled handler dispatch (`workers/api/src/index.ts`)

```ts
if (event.cron === "0 1 * * *") {
  ctx.waitUntil(
    scrapeAgentSweep({
      DB: env.DB,
      CRON_ENABLED: env.CRON_ENABLED,
      SCRAPE_AGENT_CRON_ENABLED: env.SCRAPE_AGENT_CRON_ENABLED,
      SCRAPE_AGENT_MAX_SESSIONS: env.SCRAPE_AGENT_MAX_SESSIONS,
      DISCOVERY_WORKER: env.DISCOVERY_WORKER,
      RELEASED_API_KEY: await env.RELEASED_API_KEY.get(),
      ANTHROPIC_API_KEY: await env.ANTHROPIC_API_KEY?.get(),
    }),
  );
  return;
}
```

API-key pull is lazy (inside the branch) so hourly poll-fetch ticks don't load it.

### Secrets

- `ANTHROPIC_API_KEY` bound to the API worker via Secrets Store — same secret already bound to the discovery worker for session inference. Bound via `wrangler secret put` once.

### Rollout strategy

- **Initial deploy:** `SCRAPE_AGENT_MAX_SESSIONS=5` — bounded blast radius (~$1 worst case).
- After 2–3 healthy sweeps verified via the dashboard: bump to `20` in a one-line follow-up commit.
- **Not** a DB-backed feature flag; env var + redeploy suffices for a daily cron.

### `.env.example`

Updated to document the new vars under the existing worker-vars section.

## Testing

### Pure-helper unit tests (`tests/unit/`)

- `id.test.ts`: one new case for `newCronRunId()`.
- `scrape-agent-candidates.test.ts`: `groupByOrg` — empty, multi-org, ordering, null-org silent-drop.
- `scrape-agent-preflight.test.ts`: `classifyPreflightResponse` — every row of the preflight matrix (Architecture → Anthropic pre-flight) including 429-with-credits JSON-parse edge cases.
- `scrape-agent-status-derivation.test.ts`: `deriveSweepStatus` — every row of the status matrix plus 0-candidates.

### Bind-budget assertion (`tests/api/cron-runs-bind-budget.test.ts`)

Mirrors `tests/api/retier-binds.test.ts` from #322. Locks `INSERT` and `UPDATE` shapes under D1's 100-bind cap so a future column addition fails loudly.

### Integration tests (`tests/api/`, in-memory D1 via `bun:sqlite` + Drizzle)

- `cron-runs-migrations.test.ts`: apply migration, assert table + index via `sqlite_master`.
- `scrape-agent-candidate-query.test.ts`: seed 12 sources × 5 orgs × every filter case; run the exact SQL from §3; assert expected 2 rows.
- `cron-runs-dao.test.ts`: round-trip two-stage writes (`running` → final); assert `duration_ms` correctness.
- `stale-running-reconciler.test.ts`: seed a 20-min-old `running` row; run sweep; assert transition to `aborted` with `stale_running`.

### End-to-end sweep test (`tests/api/scrape-agent-sweep.test.ts`)

Mocks only two boundaries: Anthropic pre-flight (`fetch`) and discovery worker (`env.DISCOVERY_WORKER.fetch`). Everything else runs against in-memory D1.

Cases:

- Happy path: 5 candidates / 3 orgs → 3 dispatches → `status='done'`.
- Pre-flight auth failure: 401 → 0 dispatches → `aborted(anthropic_auth)`.
- Mixed dispatch: 2 ok, 1 fails → `degraded`, `dispatch_errors=1`.
- Cap enforcement: 25 candidates, cap=20 → 20 dispatched, `skipped_over_cap=5`.

### Out of scope

- Managed-agent session internals (covered by existing integration tests + evals).
- `scrape-fetch.ts` write path (covered by existing update-session tests).
- Live dashboard rendering (visual smoke-test post-deploy, same as #322).
- Real Anthropic API behavior (evals only, on-demand).

### Post-deploy smoke test

1. Apply migration to prod D1: `wrangler d1 migrations apply released-db --remote`.
2. `wrangler dev --remote --test-scheduled` from this branch.
3. `curl -X POST 'http://localhost:8799/__scheduled?cron=0+1+*+*+*'`.
4. Verify: `cron_runs` row appears with `status='done'` (or an explicit abort reason); per-source `fetch_log` entries accumulate over the next few minutes.
5. Post results as a PR comment before merge.

## Open questions / deferred work

- **Circuit breaker on sustained dispatch failures.** `TODO` comment placed in code; revisit if we ever see a real multi-day failure.
- **Per-priority cap differentiation.** Code comment notes we could let `fetchPriority='normal'` bypass or get a higher cap than `low`. Not in v1.
- **Retrofitting other crons into `cron_runs`.** The table supports it via `cron_name`; retrofit poll-fetch and retier in a separate PR if the observability value proves out.
- **Retention policy.** No cleanup in v1. At ~365 rows/cron/year, trivial for years.
- **Auto-pause integration.** Still blocked on #321's deferred `fetchPriorityAutomatic` column. Once that lands, the retier gains auto-pause; this cron's candidate set may shrink further.

## File inventory

### New files

- `workers/api/src/cron/scrape-agent-sweep.ts`
- `workers/api/src/db/schema-cron.ts`
- `workers/api/src/routes/admin-cron-runs.ts`
- `workers/api/src/lib/concurrency.ts` (extracted from poll-fetch)
- `workers/api/migrations/YYYYMMDDHHMMSS_cron_runs.sql`
- `src/db/migrations/YYYYMMDDHHMMSS_cron_runs.sql` + meta snapshot
- `web/src/app/status/cron-runs.tsx` (tab content component)
- `tests/unit/scrape-agent-candidates.test.ts`
- `tests/unit/scrape-agent-preflight.test.ts`
- `tests/unit/scrape-agent-status-derivation.test.ts`
- `tests/api/cron-runs-bind-budget.test.ts`
- `tests/api/cron-runs-migrations.test.ts`
- `tests/api/scrape-agent-candidate-query.test.ts`
- `tests/api/cron-runs-dao.test.ts`
- `tests/api/stale-running-reconciler.test.ts`
- `tests/api/scrape-agent-sweep.test.ts`

### Modified files

- `workers/api/src/index.ts` (new scheduled-handler branch)
- `workers/api/src/cron/poll-fetch.ts` (import `runWithConcurrency` from new shared location)
- `workers/api/wrangler.jsonc` (new cron trigger, vars, binding for ANTHROPIC_API_KEY)
- `packages/core/src/id.ts` (new `newCronRunId()` helper)
- `tests/unit/id.test.ts` (lock `crun_` prefix)
- `web/src/app/status/dashboard.tsx` (new Cron tab)
- `AGENTS.md` (Cron observability runbook paragraph)
- `.env.example` (document new worker vars)

## References

- #319 — parent issue ("Scheduled fetching for scrape and agent sources")
- #320 — part 1: cron fetches scrape-with-feed
- #321 — part 2: cadence-driven fetchPriority retier
- #322 — retier observability follow-up (pattern precedent for `/status` tab)
- #324 — feed rediscovery tool (pre-work that shrunk scope from 34→31 sources)
- AGENTS.md `Agent Architecture` section — managed-agents deployment details
- `workers/discovery/src/index.ts` — existing `/update` endpoint
- `workers/discovery/src/scrape-fetch.ts` — existing per-source scrape + fetch-log writes
