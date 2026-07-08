# Plan 011: Characterization tests for webhook queue delivery branches

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b1c2e87a..HEAD -- workers/webhooks/src/index.ts workers/webhooks/src/index.test.ts workers/webhooks/src/deliver.ts`

## Status

- **Priority**: P1 (test prerequisite)
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `b1c2e87a`, 2026-07-03

## Why this matters

The webhook queue consumer (`workers/webhooks/src/index.ts` ~176-258) handles success ack, 5xx retry, 4xx perm_fail, disabled/missing subscription skip, auto-disable after threshold, and master-key-missing batch retry. Only DLQ routing and rate-limit retry are tested (`index.test.ts`). Plan 012 adds delivery-time SSRF checks in `deliver()` — these tests pin the queue branches so that change cannot regress ack/retry/auto-disable behavior.

## Current state

- `workers/webhooks/src/index.ts` — `queue` handler with sequential per-message loop.
- `workers/webhooks/src/index.test.ts` — 2 queue tests + fetch handler tests; uses `fakeEnv`, `batch()`, `deliveryMsg()`.
- `workers/webhooks/src/deliver.test.ts` — unit tests for `deliver()` in isolation.
- `workers/webhooks/src/deliver.ts` — accepts `fetchImpl` injectable (pattern for mocking HTTP).

Queue imports `deliver` directly — tests should `mock.module("./deliver.js", ...)` **at top of test file** (before importing `index.js`) or use dynamic import after mock. Follow existing `workers/webhooks` test style; webhooks runs in root multi-dir `bun test` (not isolated api process).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Webhook tests | `bun test workers/webhooks` | all pass |
| Lint | `bun run check` | exit 0 |

## Scope

**In scope**:
- `workers/webhooks/src/index.test.ts` (extend)
- Optional tiny test helper exports in `index.ts` — **avoid**; prefer mocks

**Out of scope**:
- `deliver.ts` behavior changes (plan 012)
- D1 schema / subscription CRUD
- Email notification content

## Git workflow

- Branch: `advisor/011-webhook-queue-characterization-tests`
- Commit: `test(webhooks): characterize queue delivery outcomes`

## Steps

### Step 1: Mock deliver and DB layer

At the top of `index.test.ts` (or a new `index.queue.test.ts` if cleaner), use `mock.module`:

1. `./deliver.js` — export `deliver` returning configurable outcomes.
2. `./queries.js` — stub `getWebhookSubscriptionById`, `updateWebhookSubscriptionSummary`, `setWebhookSubscriptionEnabled` with in-memory state.

Alternatively stub via `fakeEnv` extension if queries are not mockable — prefer `mock.module` on `./queries.js` since `index.ts` imports named functions.

Study `workers/webhooks/src/queries.ts` exports used by the queue handler.

**Verify**: `bun test workers/webhooks/src/index.test.ts` → existing tests still pass.

### Step 2: Add success path test

Mock `deliver` → `{ outcome: "success", httpStatus: 200, ... }`. Stub subscription as enabled. Assert `msg.ack()` called, `retried` empty.

### Step 3: Add perm_fail (4xx) test

Mock `deliver` → `{ outcome: "perm_fail", httpStatus: 400, ... }`. Assert `ack()`, not `retry()`.

### Step 4: Add retry (5xx) test

Mock `deliver` → `{ outcome: "retry", httpStatus: 503, ... }`. Assert `retry()` called.

### Step 5: Add disabled subscription skip test

Stub `getWebhookSubscriptionById` → `{ enabled: false, ... }`. Assert `ack()` without calling deliver (deliver mock call count 0).

### Step 6: Add master key missing test

`fakeEnv({ WEBHOOK_HMAC_MASTER: { get: async () => null } })`. Assert all messages `retry()`, deliver not called.

### Step 7: Add auto-disable threshold test (optional if complex)

Stub subscription with `consecutiveFailures` at threshold-1; deliver returns retry; `setWebhookSubscriptionEnabled` called with `false`. Assert ack/retry per handler logic.

**Verify**: `bun test workers/webhooks` → all pass, ≥6 queue branch tests total.

## Test plan

Cases: success ack, perm_fail ack, 5xx retry, disabled skip, missing master retry, (optional) auto-disable.

Pattern: existing `index.test.ts` `batch()` / `fakeEnv()` helpers.

## Done criteria

- [ ] ≥4 new queue handler branch tests (success, perm_fail, retry, disabled or master-key)
- [ ] `bun test workers/webhooks` exit 0
- [ ] `bun run check` exit 0
- [ ] No production code changes unless required for testability (document in PR if any)
- [ ] `plans/README.md` updated

## STOP conditions

- `mock.module` on queries breaks module resolution from webhooks cwd — try `index.queue.test.ts` with explicit mock ordering per AGENTS.md bun test note.
- Queue handler structure refactored to batch/async — re-read handler and adjust tests; stop if wildly different.

## Maintenance notes

- Plan 012 should run after this lands; re-run full webhooks test suite after SSRF change.