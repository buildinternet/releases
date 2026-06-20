# Plan 003: Instrument agent/API consumption + define a demand north-star

> **Executor instructions**: Follow step by step; run every verification command;
> honor "STOP conditions". Update the status row in `plans/README.md` when done.
>
> **Drift check (run first)**:
> `git diff --stat 8f811cb5..HEAD -- workers/mcp/src/auth.ts workers/mcp/src/index.ts workers/api/src/routes/status.ts`
> Compare excerpts to live code; on a mismatch, STOP.

## Status

- **Priority**: P1
- **Effort**: S–M
- **Risk**: LOW (additive, fire-and-forget telemetry; no behavior change)
- **Depends on**: none (run in parallel with 001/002)
- **Category**: direction
- **Planned at**: commit `8f811cb5`, 2026-06-20
- **Issue**: https://github.com/buildinternet/releases/issues/1700

## Why this matters

Organic search (the historical human channel) is structurally impaired (#1601),
so the agent/API channel is the one that matters — and it's currently unmeasured.
The only usage instrumentation today measures **our costs and surfaces**, not
**consumer demand**: `usage_log` is our AI token spend, `search_queries` is the
web search log, `telemetry_events` is CLI command names. There is no view of who
consumes the catalog programmatically or whether that's growing. This plan adds a
PII-clean, fire-and-forget consumption signal and defines one north-star, so the
team can tell whether plan 002 (and #1698/#1699) create real pull. Cheap,
foundational, unblocks judgment on the whole push.

## Current state

- `workers/mcp/src/auth.ts` — `resolveMcpAuth()` already resolves the caller's
  **principal type** once per request at the HTTP boundary (anonymous / `relk_` /
  `relu_` / OAuth-JWT / root) and their scopes. This is the natural emit point: a
  per-tool-call count keyed by principal type is one line where identity is
  already known.
- `workers/mcp/src/index.ts` — the boundary; already does a JSON-RPC method peek
  (`isMeteredMcpMethod`) and a throttled `touchLastUsed` via `waitUntil`. Model
  the new emit on that fire-and-forget pattern (no added latency).
- `workers/api/src/routes/status.ts` — the admin observability surface; already
  aggregates `usageLog` by operation/source over a time window (`:234-247`). The
  new consumer view should live alongside it (or as a sibling admin route).
- `workers/api/src/index.ts` — where `search_queries` rows are written (the
  existing low-cardinality usage-log precedent), swept by
  `workers/api/src/cron/sweep-search-queries.ts`.
- `workers/api/src/routes/telemetry.ts` — the CLI telemetry intake; **PII-clean
  by contract** (command names only). Preserve that boundary: counts + principal
  _type_ + tool/route, never user-identifying payloads.
- Worker structured logs go to **Axiom** (memory `reference_axiom_worker_logs`:
  `releases-cloudflare-logs` dataset, JSON in `body`) via `logEvent()` from
  `@releases/lib/log-event`. A `logEvent`-based counter is the lowest-effort path
  and needs no new table; a D1 rollup table is the alternative if you want SQL
  aggregation on the admin surface (decide in Step 1).

## Commands you will need

| Purpose                   | Command                                                                     | Expected on success |
| ------------------------- | --------------------------------------------------------------------------- | ------------------- |
| Worktree bootstrap (once) | `./scripts/setup-worktree.sh`                                               | exit 0              |
| Typecheck (root)          | `npx tsc --noEmit`                                                          | exit 0              |
| Typecheck (mcp / api)     | `cd workers/mcp && npx tsc --noEmit` ; `cd workers/api && npx tsc --noEmit` | exit 0              |
| Tests                     | `bun test`                                                                  | all pass            |
| Lint                      | `bun run lint`                                                              | exit 0              |

## Scope

**In scope:**

- `workers/mcp/` — emit a per-tool-call consumption event (tool name + principal
  type + day bucket) on the existing fire-and-forget path.
- `workers/api/` — emit the same for metered API routes (by token id hash /
  principal type, route family); add a read-only admin aggregation
  (route or extend `status.ts`).
- A migration **only if** Step 1 chooses the D1-rollup option.

**Out of scope (do NOT touch):**

- The CLI `telemetry_events` contract (don't widen its payload).
- Any synchronous write on a read path (must stay `waitUntil`/fire-and-forget).
- Per-user identifying data — principal _type_ and a non-reversible token id
  reference only; no emails, no raw tokens, no IPs.

## Git workflow

- Branch: `advisor/003-consumption-instrumentation`.
- Conventional commits (`feat(obs): agent consumption telemetry`).
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Decide the sink — `logEvent`→Axiom vs. D1 rollup

Pick one and record it in the commit message:

- **A (default, lighter): `logEvent` to Axiom.** Emit `{event:"mcp_tool_call",
tool, principalType, day}` and an API equivalent; build the north-star as a
  saved Axiom query/dashboard. No schema change.
- **B (SQL on the admin surface): a `consumption_daily` D1 rollup table**
  (`day, surface, tool_or_route, principal_type, count`, unique on the tuple,
  upsert-increment). Needs a paired migration (see plan 001 step 2 pattern).

Default to **A** unless the team wants the numbers inside the existing admin
status page without Axiom. Note the choice; the rest of the steps assume A and
flag the B delta.

**Verify**: decision recorded; if B, migration drafted and `npx tsc --noEmit` clean.

### Step 2: Emit from the MCP boundary

In `workers/mcp/` (where `resolveMcpAuth` result + the tool name are both in
scope — near the `touchLastUsed`/`waitUntil` call in `index.ts`), emit one
consumption event per metered tool call. Reuse `isMeteredMcpMethod` so protocol
overhead (`initialize`/`tools/list`/`ping`/`notifications/*`) is **not** counted.
Principal type comes straight from the resolved identity. Fire-and-forget via
`waitUntil` — never await.

**Verify**: `cd workers/mcp && npx tsc --noEmit` → exit 0; `bun test workers/mcp`
→ pass; add a test asserting a `tools/list` call emits nothing and a `tools/call`
emits exactly one event.

### Step 3: Emit from metered API routes

Emit the API equivalent for token-authenticated routes (principal type + a
stable non-reversible token reference + route family). Reuse the existing
auth-middleware seam (`workers/api/src/middleware/auth.ts` /
`token-store.ts`), again fire-and-forget.

**Verify**: `cd workers/api && npx tsc --noEmit` → exit 0; `bun test workers/api` → pass.

### Step 4: Admin aggregation + north-star

- Option A: a saved Axiom query/dashboard computing **weekly active agent
  consumers** (distinct principal-type-keyed consumers/week) and **programmatic
  queries answered/week**. Document the query in `docs/architecture/` or a
  runbook.
- Option B: extend `workers/api/src/routes/status.ts` (admin-gated) with a
  `GET` that returns the rollup grouped by day/surface/principal type.

Pick **one** north-star metric and write it down as _the_ number to watch.

**Verify**: the dashboard/route returns non-empty data in a smoke run; the
north-star is named in the docs/runbook.

## Test plan

- MCP: `tools/list` emits 0 events; `tools/call` emits 1; principal type is
  carried. Model after existing `workers/mcp/src/*.test.ts`.
- API: a token-authed metered route emits 1 consumption event; an anonymous
  public read emits with `principalType: "anonymous"` (or is sampled — document
  whichever).
- PII guard test: the emitted payload contains no email / raw token / IP
  (assert the shape).
- Verification: `bun test` → all pass.

## Done criteria

- [ ] `npx tsc --noEmit` exits 0 at root, `workers/mcp`, `workers/api`.
- [ ] `bun test` exits 0; new emit + PII-guard tests pass.
- [ ] MCP tool calls and metered API calls emit aggregate, PII-clean consumption
      events on a fire-and-forget path (no awaited write on a read path).
- [ ] An admin/Axiom view exists and one north-star metric is named in docs.
- [ ] `telemetry_events` payload contract unchanged (`git diff` shows no widening).
- [ ] `plans/README.md` status row updated.

## STOP conditions

Stop and report (do not improvise) if:

- `resolveMcpAuth` / the `index.ts` boundary differ from "Current state".
- Emitting would require awaiting a write on a read path (it must not) — report
  the seam that forces it.
- The only way to count "unique consumers" needs a stable user identifier that
  crosses the PII boundary — STOP and propose a hashed/bucketed alternative.

## Maintenance notes

- This is the gauge for #1697/#1698/#1699 — when those ship, watch whether the
  north-star moves; that's the signal the agent-native pivot is working.
- If volume grows, the `logEvent`→Axiom path (option A) scales fine; only move to
  a D1 rollup if you need SQL joins against catalog tables.
- Sibling cost-tracking work: #1651. Keep demand (this) and cost (#1651) as two
  distinct dashboards — they answer different questions.
- Reviewer should scrutinize: no synchronous writes on read paths; no PII in any
  emitted payload; protocol-overhead methods excluded from counts.
