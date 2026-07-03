# Plan 005: Characterization tests for the ingest critical path (issue #1652)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3238d540..HEAD -- workers/api/src/routes/sources.ts workers/api/src/cron/poll-fetch.ts workers/api/test/`
> This plan creates tests only; drift in the two source files is expected and
> fine — but if either file was _restructured_ (functions renamed/moved), STOP
> and re-scout before writing tests against stale symbol names.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: LOW (test-only; no `src/` changes)
- **Depends on**: none (unblocks a future `sources.ts`/`poll-fetch.ts` decomposition — that refactor must NOT start before this lands)
- **Category**: tests
- **Planned at**: commit `3238d540`, 2026-07-02
- **Issue**: https://github.com/buildinternet/releases/issues/1652

## Why this matters

`workers/api/src/routes/sources.ts` (~3,900 LOC) and
`workers/api/src/cron/poll-fetch.ts` (~2,700 LOC) carry the bulk of the
release-write logic — fetch, parse, dedup/upsert, backoff, cascade — and are
the top two churn hotspots in the repo (90 and 58 commits since May
respectively). Their behavioral test coverage is thin relative to that churn.
Issue #1652 tracks this as a prerequisite: before either god-file can be
split (a separate, deferred effort), a characterization baseline must pin
current behavior so a refactor can be proven behavior-preserving. The goal is
to catch _unintended changes_, not to assert exhaustive correctness — if a
test reveals what looks like a real bug, that is a report, not a fix.

## Current state

Relevant files:

- `workers/api/src/routes/sources.ts` — source CRUD routes, the batch release
  upsert (`POST .../releases/batch`), release read/suppress/delete routes.
- `workers/api/src/cron/poll-fetch.ts` — exports `fetchOne` and `pollOne`
  (already imported by existing tests); feed/scrape/appstore fetch cycle,
  dedup, error backoff.
- `workers/api/test/` — ~150 existing test files; the patterns to copy live
  here.
- `workers/api/test/setup.ts` — exports `createTestDb()` (bun:sqlite +
  drizzle, real migrations applied via `tests/db-helper.ts`).
- `tests/global-fetch.ts` — exports `restoreGlobalFetch()` for stubbing
  `globalThis.fetch`.

**The structural exemplar to model after** is
`workers/api/test/appstore-poll-fetch.test.ts`. Its exact pattern (verbatim
from `3238d540`):

```ts
import { describe, it, expect, afterEach } from "bun:test";
import { organizations, sources, releases } from "@buildinternet/releases-core/schema";
import { eq } from "drizzle-orm";
import { fetchOne, pollOne } from "../src/cron/poll-fetch.js";
import { createTestDb } from "./setup";
import { restoreGlobalFetch } from "../../../tests/global-fetch";

afterEach(() => {
  restoreGlobalFetch();
});
// ... seed org + source rows with db.insert, stub globalThis.fetch with a
// canned Response, then:
// oxlint-disable-next-line no-explicit-any -- BunSQLiteDatabase vs DrizzleD1Database; works at runtime via the shim
const first = await fetchOne(db as any, source, {} as never, { skipSideEffects: true });
expect(first.releasesInserted).toBe(1);
```

Key conventions this plan must honor:

- **`skipSideEffects: true` on `fetchOne`** — skips embeds/AI/event-publish so
  no Anthropic key, Vectorize binding, or queue is needed. Every new
  poll-fetch test must pass it.
- **No `mock.module`, ever.** bun's `mock.module` is process-global and
  non-restorable; the repo isolates `workers/api` into its own `bun test`
  process precisely to contain existing leaks. Stub `globalThis.fetch`
  (restored via `restoreGlobalFetch()`) and use `skipSideEffects` instead.
- **Route tests** invoke the Hono app in-process. Find an existing route test
  that hits source routes with a real test DB — e.g.
  `grep -l "createTestDb" workers/api/test/*.test.ts | head`, then open 1–2
  (e.g. `collections.test.ts`, `source-workflow-route.test.ts`) and copy how
  they construct the env (`DB` binding from the test sqlite) and call
  `app.request(...)`/`routes.request(...)`. Fake Secrets Store bindings as
  `{ get: async () => "value" }` where a route requires one.
- Typed IDs: sources are `src_…`, orgs `org_…`, releases `rel_…` — seed rows
  with explicit ids as the exemplar does.
- The dedup invariant: `UNIQUE(source_id, url)` + the `RELEASE_URL_UPSERT`
  config (`packages/core-internal`, re-exported where the upsert runs) —
  re-fetching identical content must not duplicate rows.

## Commands you will need

| Purpose        | Command                                    | Expected on success |
| -------------- | ------------------------------------------ | ------------------- |
| Install        | `bun install` (repo root; only if needed)  | exit 0              |
| Lint + types   | `bun run check`                            | exit 0              |
| API tests only | `bun test workers/api`                     | all pass            |
| One file       | `bun test workers/api/test/<file>.test.ts` | all pass            |
| Full suite     | `bun run test`                             | all pass            |

## Scope

**In scope** (create only; modify nothing outside `workers/api/test/`):

- `workers/api/test/sources-crud-characterization.test.ts` (create)
- `workers/api/test/releases-batch-characterization.test.ts` (create)
- `workers/api/test/poll-fetch-feed-characterization.test.ts` (create)

**Out of scope** (do NOT touch):

- ANY file under `workers/api/src/` — this plan is characterization only. If
  current behavior looks wrong, pin it with a test named
  `("characterizes current behavior: …")` plus a comment, and list it in your
  final report.
- The AI passes (summarization, marketing classifier, breaking
  classification) — not testable without a model; `skipSideEffects` bypasses
  them. Do not try to build a model harness (a known dead end: model
  resolution is not injectable without the forbidden `mock.module`).
- Scrape/agent-type sources and the discovery worker — feed + github +
  appstore adapters cover the deterministic surface; scrape needs Browser
  Rendering and is not unit-testable here.
- `tests/evals/` — paid, manual, unrelated.

## Git workflow

- Branch: `advisor/005-ingest-characterization-tests`
- Conventional commits, e.g. `test(api): characterization tests for source CRUD + batch upsert (#1652)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Scout the exact route-test invocation pattern

Open `workers/api/test/appstore-poll-fetch.test.ts` fully, plus two route
tests found via `grep -l "createTestDb" workers/api/test/*.test.ts`. Write
down (in a scratch comment, removed later): how the test env object is built,
how auth is satisfied on mutating routes (root key? fake binding?), and the
exact request helper used. Do not proceed on guesses.

**Verify**: you can run one of the existing route tests standalone:
`bun test workers/api/test/collections.test.ts` → passes.

### Step 2: Source CRUD characterization (`sources-crud-characterization.test.ts`)

Cover, via route invocations against a `createTestDb()` DB:

1. Create a source (org-scoped route) → row exists with expected slug/type/metadata.
2. List + detail read back what was created (including org/product association fields).
3. Update (PATCH) source metadata → merged/replaced per current behavior (assert whichever the code does — this is characterization).
4. Delete a source → releases cascade per current behavior (seed 2 releases first; assert what actually happens to them).
5. A bare-slug lookup on an org-scoped route rejects (`bare_slug_rejected` — see `docs/architecture/routing.md`) — one negative case.

**Verify**: `bun test workers/api/test/sources-crud-characterization.test.ts` → all pass.

### Step 3: Batch upsert characterization (`releases-batch-characterization.test.ts`)

Against the batch releases route (`POST` `/v1/orgs/:orgSlug/sources/:sourceSlug/releases/batch` — confirm exact path in `sources.ts`):

1. Insert N new releases → all inserted, response counts match.
2. Re-POST the same payload → 0 inserted (dedup on `(source_id, url)`), no duplicate rows.
3. Re-POST with changed body content for an existing URL → assert current upsert behavior (which fields update vs. stick — check `RELEASE_URL_UPSERT` and pin what it does, e.g. stored-empty media backfills but populated media is not clobbered).
4. A batch bigger than one D1 chunk (e.g. 20 rows) → all rows land (exercises the chunked insert).

**Verify**: `bun test workers/api/test/releases-batch-characterization.test.ts` → all pass.

### Step 4: Feed fetch-cycle characterization (`poll-fetch-feed-characterization.test.ts`)

Using `fetchOne(db as any, source, {} as never, { skipSideEffects: true })`
with a seeded `type: "feed"` source (`metadata.feedUrl` set) and a stubbed
`globalThis.fetch` returning a small RSS/Atom fixture (inline string, 2–3
items):

1. First fetch inserts the feed items as releases (assert count + one row's url/title/publishedAt mapping).
2. Second fetch with identical fixture inserts 0 (dedup).
3. Fetch where the stub returns HTTP 500 → returned status is an error, `sources.consecutive_errors` incremented and `next_fetch_after` set in the DB (the backoff write — this also guards plan 004's touched lines).
4. Fetch where the stub returns HTTP 429 with `Retry-After` → assert the transient-feed branch behavior (backoff respects retry-after; see the `feed-rate-limited` branch near `poll-fetch.ts:2010`).

**Verify**: `bun test workers/api/test/poll-fetch-feed-characterization.test.ts` → all pass.

### Step 5: Full-suite regression

**Verify**: `bun run check` → exit 0, then `bun run test` → all pass (the new
files run inside the `bun test workers/api` leg).

## Test plan

This plan IS the test plan. Target: ~15–25 focused `it(...)` cases across the
three files, each asserting observable behavior (DB rows, response bodies,
status codes) — no snapshot tests, no asserting on log output, no mocking
beyond `globalThis.fetch` and fake bindings.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] Three new test files exist under `workers/api/test/` and pass
- [ ] `bun test workers/api` exits 0
- [ ] `bun run check` exits 0
- [ ] `git diff --name-only` shows ONLY the three new test files (plus the plans/README.md status row)
- [ ] Zero occurrences of `mock.module` in the new files: `grep -c "mock.module" workers/api/test/*characterization*.test.ts` → 0 matches
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Satisfying auth on the mutating routes requires anything beyond the pattern
  existing tests use (fake root-key binding / test helper) — do not invent an
  auth bypass.
- A characterization test reveals behavior that looks like a genuine bug
  (e.g. dedup inserting duplicates, cascade deleting the wrong rows). Pin it
  with a clearly-named test if it is deterministic, and report it prominently
  — do NOT change `src/` to "fix" it.
- `fetchOne`'s signature or `skipSideEffects` option no longer matches the
  exemplar (drift since `3238d540`).
- You need a real network call, an Anthropic key, or a Vectorize/queue
  binding to make a test pass — the scope is wrong; report back.

## Maintenance notes

- These tests exist to be the safety net for the deferred decomposition of
  `sources.ts`/`orgs.ts` (god-file split). When that refactor happens, these
  suites must pass unmodified — if a refactor PR edits a characterization
  assertion, that is a behavior change and needs explicit review.
- Tests that pin arguably-wrong behavior are labeled
  `"characterizes current behavior: …"` — reviewers should treat each as a
  candidate bug report, tracked separately from this plan.
- Follow-up deliberately deferred: scrape-path and discovery-worker coverage,
  and any harness for the AI passes.
