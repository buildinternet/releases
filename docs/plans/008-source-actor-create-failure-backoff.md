# Plan 008: SourceActor short backoff on workflow create failure

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b1c2e87a..HEAD -- workers/api/src/source-actor.ts workers/api/test/source-actor.test.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b1c2e87a`, 2026-07-03

## Why this matters

Actor-managed sources are excluded from the hourly cron fan-out (`workers/api/src/index.ts` ~1447–1452). When `POLL_AND_FETCH_WORKFLOW.create()` fails for a transient reason (control-plane blip, binding hiccup), `fireWorkflow` returns `fired: false` and the alarm schedules the **next tier interval** (4h normal / 24h low). The source stays due in D1 but may not fetch for hours. A short retry alarm (minutes, not hours) recovers without spawning duplicate ingests — the existing in-flight guard and deterministic instance IDs still apply.

## Current state

- `workers/api/src/source-actor.ts` — SourceActor DO; `alarm()` fires workflow then schedules:
  ```ts
  // lines 285-291 (approx)
  const fired = await this.fireWorkflow(sourceId, now);
  const intervalMs = (plan.intervalHours ?? 4) * 3_600_000;
  await this.scheduleAt(row, now + intervalMs, fired, fired ? now : (prev?.lastFiredAt ?? null));
  ```
- `fireWorkflow` returns `false` on binding missing or `create` throw (lines 341–373).
- `workers/api/test/source-actor.test.ts` — harness with `failCreateIds` on workflow mock; no test for non-duplicate create failure retry timing.
- Logging: use `logEvent()` from `@releases/lib/log-event` (worker convention per AGENTS.md).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint + format | `bun run check` | exit 0 |
| SourceActor tests | `bun test workers/api/test/source-actor.test.ts` | all pass |
| API worker tests | `bun test workers/api` | all pass (isolated process) |

## Scope

**In scope**:
- `workers/api/src/source-actor.ts`
- `workers/api/test/source-actor.test.ts`

**Out of scope**:
- Cron fan-out logic in `workers/api/src/index.ts`
- In-flight guard window (`SAFETY_WINDOW_MS`) — do not change
- OrgActor / discovery workers

## Git workflow

- Branch: `advisor/008-source-actor-create-failure-backoff`
- Commit message style: `fix(api): short backoff when SourceActor workflow create fails`
- Do NOT push or open a PR unless instructed.

## Steps

### Step 1: Add a create-failure retry constant

At module scope in `source-actor.ts`, near `SAFETY_WINDOW_MS`, add:

```ts
/** Retry alarm after a failed workflow.create — short enough to recover from
 *  transient control-plane errors, far shorter than the tier interval. */
const CREATE_FAILURE_RETRY_MS = 10 * 60 * 1000; // 10 minutes
```

**Verify**: `grep -n CREATE_FAILURE_RETRY_MS workers/api/src/source-actor.ts` → one match.

### Step 2: Schedule short retry when create fails

In `alarm()`, replace the unconditional `now + intervalMs` schedule with:

```ts
const intervalMs = (plan.intervalHours ?? 4) * 3_600_000;
const nextAlarmMs = fired ? now + intervalMs : now + CREATE_FAILURE_RETRY_MS;
await this.scheduleAt(row, nextAlarmMs, fired, fired ? now : (prev?.lastFiredAt ?? null));
```

On failure, log at `info` with `event: "create-failure-retry-scheduled"` and `retryMs: CREATE_FAILURE_RETRY_MS` (additive to existing `workflow-create-failed` warn).

**Verify**: `bun run check` → exit 0.

### Step 3: Add regression test for create-failure retry

Extend `mkActor` workflow mock to support `throwOnCreate?: boolean` (throw on every create that is NOT a duplicate-id collision). Or reuse `failCreateIds` with a wildcard: throw when id matches `source-actor-${sourceId}-*` except duplicate message.

Add test `schedules short retry when workflow.create fails (non-duplicate)`:

1. Seed a due source (`lastPolledAt` 10h ago, normal tier).
2. Mock `create` to throw `new Error("control plane unavailable")` for any id.
3. Run `alarm()`.
4. Assert `created` is empty.
5. Assert `alarmAt()` is within `now + 9min` .. `now + 11min` (not ~4h).

Model after existing `SourceActor.alarm` tests in the same file.

**Verify**: `bun test workers/api/test/source-actor.test.ts` → new test passes.

### Step 4: Confirm success path unchanged

Re-run existing test `fires the workflow once when due and schedules ~one tier interval out` — alarm must still be ~4h out on success.

**Verify**: full `bun test workers/api/test/source-actor.test.ts` → all pass.

## Test plan

- New: create-failure schedules ~10min retry, not tier interval.
- Existing: success path still ~4h; in-flight guard tests unchanged.

**Verify**: `bun test workers/api` → exit 0.

## Done criteria

- [ ] `CREATE_FAILURE_RETRY_MS` defined and used when `fired === false`
- [ ] New unit test passes; existing SourceActor tests pass
- [ ] `bun run check` exits 0
- [ ] `bun test workers/api` exits 0
- [ ] No files outside scope modified
- [ ] `plans/README.md` status row updated

## STOP conditions

- `alarm()` scheduling logic already branches on failure differently than excerpted — report drift.
- Test harness cannot mock non-duplicate create failures without refactoring `mkActor` — report before improvising a different approach.
- Changing `CREATE_FAILURE_RETRY_MS` below 5 minutes (too aggressive) or above `SAFETY_WINDOW_MS` (risks overlapping in-flight guard) — stop and ask.

## Maintenance notes

- If tier intervals change, retry stays independent — only success path uses `intervalMs`.
- Reviewers: confirm duplicate-id collision still returns `fired: false` and gets the short retry (benign — next alarm re-reads D1; acceptable).