# Plan 012: Re-validate webhook URLs at delivery time

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat b1c2e87a..HEAD -- workers/webhooks/src/deliver.ts workers/webhooks/src/deliver.test.ts workers/api/src/webhooks/url-safety.ts`

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: plans/011-webhook-queue-characterization-tests.md
- **Category**: security
- **Planned at**: commit `b1c2e87a`, 2026-07-03

## Why this matters

Webhook URLs are validated at subscription create/patch via `assertPublicWebhookTarget()` (DNS + blocked hosts). At delivery, `deliver()` POSTs to `message.url` with no re-check. DNS rebinding can point a previously-public hostname at private/reserved addresses after registration. Delivery-time validation closes SSRF from the webhooks worker egress.

## Current state

- `workers/webhooks/src/deliver.ts:61` — `new Request(message.url, { method: "POST", ... })` then `fetchImpl(request)`.
- `workers/api/src/webhooks/url-safety.ts:154` — `assertPublicWebhookTarget(url, opts?)` returns error string or null; accepts injectable `resolveDns` for tests.
- `deliver.ts` already imports types from `../../api/src/webhooks/types.js` — cross-worker import from api is established.
- Slack format (`message.format === "slack"`) uses `hooks.slack.com` — still run host validation (existing `validateSlackWebhookUrl` / blocked hosts).

Tests: `workers/webhooks/src/deliver.test.ts` — injectable `fetchImpl`; extend with DNS mock.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Deliver tests | `bun test workers/webhooks/src/deliver.test.ts` | all pass |
| Webhook tests | `bun test workers/webhooks` | all pass |
| URL safety tests | `bun test workers/api/src/webhooks/url-safety.test.ts` | all pass |
| Lint | `bun run check` | exit 0 |

## Scope

**In scope**:
- `workers/webhooks/src/deliver.ts`
- `workers/webhooks/src/deliver.test.ts`
- `workers/webhooks/src/index.ts` — only if new `errorCode` needs queue handling (prefer handling entirely in deliver)

**Out of scope**:
- Moving `url-safety.ts` to a shared package (use relative import unless bundler rejects)
- Subscription create/patch validation (already correct)
- Disabling subscriptions automatically on SSRF block (return perm_fail; queue handler already acks perm_fail)

## Git workflow

- Branch: `advisor/012-webhook-delivery-ssrf-revalidation`
- Commit: `fix(webhooks): re-validate subscriber URL before delivery`

## Steps

### Step 1: Import assertPublicWebhookTarget

In `deliver.ts`:

```ts
import { assertPublicWebhookTarget } from "../../api/src/webhooks/url-safety.js";
```

Extend `DeliverOptions`:

```ts
resolveDns?: (host: string) => Promise<string[]>;
```

### Step 2: Validate before fetch

At start of `deliver()`, before building the request:

```ts
const targetError = await assertPublicWebhookTarget(message.url, {
  resolveDns: opts.resolveDns,
});
if (targetError) {
  return {
    outcome: "perm_fail",
    httpStatus: 0,
    latencyMs: 0,
    errorMessage: targetError,
    errorCode: "ssrf_blocked",
  };
}
```

Add `"ssrf_blocked"` to `ErrorCode` in `workers/webhooks/src/ae.ts` if the union is closed — or use an existing perm_fail code if adding types is heavy (prefer new code for observability).

**Verify**: `bun run check` → exit 0 (run webhooks `tsc` if needed: `cd workers/webhooks && bun run typecheck`).

### Step 3: Add deliver tests

In `deliver.test.ts`:

1. `blocks delivery when DNS resolves to private IP` — mock `resolveDns` returning `["127.0.0.1"]`, assert `outcome: "perm_fail"`, `fetchImpl` not called.
2. `allows delivery when DNS resolves public` — mock returning `["93.184.216.34"]`, `fetchImpl` returns 200, success.

**Verify**: `bun test workers/webhooks/src/deliver.test.ts` → all pass.

### Step 4: Re-run queue characterization tests

**Verify**: `bun test workers/webhooks` → all pass including plan 011 tests.

## Test plan

- deliver: private DNS → perm_fail, no fetch
- deliver: public DNS → success path unchanged
- queue: plan 011 suite still green

## Done criteria

- [ ] `assertPublicWebhookTarget` called in `deliver()` before `fetch`
- [ ] New deliver tests pass
- [ ] `bun test workers/webhooks` exit 0
- [ ] `plans/README.md` updated

## STOP conditions

- Wrangler bundle fails to resolve `../../api/src/webhooks/url-safety.js` from webhooks worker — stop and propose extracting `url-safety` to `@releases/lib` (out of scope here).
- `ErrorCode` type change breaks Analytics Engine writes — adjust AE schema or map to existing code.

## Maintenance notes

- Legitimate DNS changes may perm_fail until subscriber updates URL — same as registration-time validation.
- Reviewers: Slack URLs must still pass validation path.