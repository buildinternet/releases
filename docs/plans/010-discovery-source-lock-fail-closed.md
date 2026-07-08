# Plan 010: Fail-closed discovery source-lock on SourceActor RPC errors

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b1c2e87a..HEAD -- workers/discovery/src/source-lock.ts workers/discovery/test/source-lock.test.ts workers/discovery/src/index.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `b1c2e87a`, 2026-07-03

## Why this matters

Before minting a managed-agent session, discovery calls `tryAcquireSourceLocks` to serialize per-source MA work via the SourceActor DO. On RPC throw, the catch block treats the source as **acquired** (`acquired.push(id)`), so an empty conflict list allows session minting even though no lock was taken — concurrent sessions for the same source can start during DO outages. Ingest dedups on URL, but duplicate sessions waste inference spend and violate the #1814 serialization intent.

This plan changes **RPC-error** behavior only. **Binding absent** stays fail-open (documented: lock disabled, warn once).

## Current state

`workers/discovery/src/source-lock.ts` lines 76-84:

```ts
} catch (err) {
  logEvent("error", { component: "discovery", event: "source-lock-acquire-failed", ... });
  acquired.push(id); // fail-open: treat as acquired
}
```

Caller `workers/discovery/src/index.ts` ~248-261 rejects when `lockedSources.length > 0`.

Tests `workers/discovery/test/source-lock.test.ts` line 69: `fails open: a throwing acquire treats that source as acquired` — must be **updated** to expect fail-closed.

Logging: `logEvent()` from `@releases/lib/log-event`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Lint + format | `bun run check` | exit 0 |
| Discovery tests | `bun test workers/discovery` | all pass |

## Scope

**In scope**:
- `workers/discovery/src/source-lock.ts`
- `workers/discovery/test/source-lock.test.ts`
- Module header comment in `source-lock.ts` (update fail-open wording)

**Out of scope**:
- SourceActor DO implementation (`workers/api/src/source-actor.ts`)
- Spend-cap fail-open (`spend-cap.ts`)
- Binding-absent path (must remain fail-open)

## Git workflow

- Branch: `advisor/010-discovery-source-lock-fail-closed`
- Commit: `fix(discovery): fail-closed source-lock acquire on SourceActor RPC errors`

## Steps

### Step 1: Change RPC error handling to surface a conflict

In the `catch` block of `tryAcquireSourceLocks`, **remove** `acquired.push(id)`. Instead:

```ts
conflicts.push({ id, sessionId: "__lock_unavailable__" });
```

Keep the existing `logEvent("error", ...)` unchanged.

Update the file header comment: RPC errors now **block** delegation (fail-closed); binding absent still fail-open.

**Verify**: `grep -n '__lock_unavailable__' workers/discovery/src/source-lock.ts` → one match; no `fail-open: treat as acquired` in catch block.

### Step 2: Update tests

Replace test `fails open: a throwing acquire treats that source as acquired` with `fails closed: a throwing acquire surfaces a conflict`:

```ts
const conflicts = await tryAcquireSourceLocks(env, ["src_a", "src_b"], "sess_1");
expect(conflicts).toEqual([{ id: "src_a", sessionId: "__lock_unavailable__" }]);
```

Keep test `is a no-op (fail-open) when the SOURCE_ACTOR binding is absent` **unchanged**.

**Verify**: `bun test workers/discovery/test/source-lock.test.ts` → all pass.

### Step 3: Verify caller behavior

Read `workers/discovery/src/index.ts` — confirm non-empty `lockedSources` returns `{ ok: false, error: ... }` without minting. No code change expected; if error message exposes `__lock_unavailable__` to users, optionally map to a friendlier string in the caller — only if the existing message is too raw (optional, out of scope unless product asks).

**Verify**: `bun test workers/discovery` → exit 0.

## Test plan

- Updated: RPC throw → conflict returned, session would be blocked.
- Unchanged: binding absent → `[]` conflicts; partial acquire rollback.

## Done criteria

- [ ] RPC catch pushes conflict, not `acquired`
- [ ] Absent-binding fail-open preserved
- [ ] Tests updated and passing
- [ ] `bun run check` and `bun test workers/discovery` exit 0
- [ ] `plans/README.md` updated

## STOP conditions

- Source-lock file already fail-closed on RPC — plan is done, mark DONE.
- Operators require fail-open during DO incidents — stop and report (product tradeoff).
- Caller doesn't check conflicts before mint in a code path you discover — extend scope only with approval.

## Maintenance notes

- During SourceActor outages, MA session starts for affected sources will be **blocked** until RPC recovers — preferable to duplicate sessions.
- Reviewers: confirm `__lock_unavailable__` is not confused with a real `sessionId` in logs (it's a sentinel).