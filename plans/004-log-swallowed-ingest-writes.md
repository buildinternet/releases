# Plan 004: Surface swallowed write failures on the ingest path (log-or-justify every bare `.catch(() => {})`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3238d540..HEAD -- workers/api/src/cron/poll-fetch.ts workers/api/src/routes/search.ts workers/api/src/org-actor.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition. Line numbers below are from commit
> `3238d540` — always re-locate sites with the grep commands given, never by
> raw line number.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug (observability / silent failure)
- **Planned at**: commit `3238d540`, 2026-07-02

## Why this matters

The cron ingest path (`poll-fetch.ts`) persists two kinds of state with
fire-and-forget D1 writes wrapped in bare `.catch(() => {})`: `fetch_log` rows
(the observability trail operators use to see whether a source was fetched) and
`sources` backoff state (`consecutive_errors`, `next_fetch_after`,
`feed4xxStreak`). When one of those writes fails — a transient D1 error, a
constraint violation, a bind-count bug — the failure vanishes: the fetch
attempt is missing from the log, or worse, the backoff never lands and the
next cron tick re-fetches a rate-limiting origin at full cadence. The same
pattern hides FTS query errors in `/v1/search` (a failed query is
indistinguishable from zero results) and malformed JSON from the discovery
worker in the OrgActor. This plan keeps every site fail-open (no behavior
change on the happy path) but makes every swallowed error visible in Workers
Logs.

This plan deliberately does NOT make any of these writes fail-closed — the
current fail-open semantics are correct for a cron path (one lost log row must
not abort a fetch cycle). Visibility only.

## Current state

Relevant files:

- `workers/api/src/cron/poll-fetch.ts` — the cron fetch/parse/upsert pipeline; contains 8 bare `.catch(() => {})` sites.
- `workers/api/src/routes/search.ts` — `/v1/search`; one `.catch(() => [] as RawSearchReleaseRow[])` site that hides FTS errors.
- `workers/api/src/org-actor.ts` — OrgActor Durable Object (drain dispatch, #1777); one `.catch(() => ({}))` on the discovery response JSON parse.
- `packages/lib/src/log-event.ts` — the worker logging helper. Worker code MUST log via `logEvent()` from `@releases/lib/log-event` (structured JSON; `warn` level dispatches to `console.warn`). It already unwraps `Error` values via a replacer, so you can pass the raw error as a payload field.

Find the poll-fetch sites (at `3238d540` these are lines 1038, 1619, 1680, 1988, 2020, 2062, 2069, 2090):

```
grep -n 'catch(() => {})' workers/api/src/cron/poll-fetch.ts
```

Classify them in two groups:

**Group A — `fetch_log` inserts (observability-only): lines 1038, 1619, 1680, 1988.** Shape:

```ts
// poll-fetch.ts:1610-1619 (video-source misconfig branch; the others are identical in shape)
await db
  .insert(fetchLog)
  .values({
    sourceId: source.id,
    sessionId,
    releasesFound: 0,
    releasesInserted: 0,
    durationMs: dur,
    status: "error",
    error: "Missing feedUrl or video.provider in source metadata",
  })
  .catch(() => {});
```

**Group B — `sources` state writes (behavioral): lines 2020, 2062, 2069, 2090.** These persist backoff/streak state; a silent failure here means no backoff. Shape:

```ts
// poll-fetch.ts:2084-2090 (error-backoff write; 2020 is the transient-feed variant,
// 2062/2069 are the feed4xxStreak metadata writes)
await db
  .update(sources)
  .set({
    consecutiveErrors: newErrors,
    nextFetchAfter: nextFetch,
  })
  .where(eq(sources.id, source.id))
  .catch(() => {});
```

Do NOT touch the `.catch(() => null)` fallbacks near lines 1000–1021
(`getSecret(...)`/`fetchCloudflareMarkdown(...)`) — those feed explicitly
handled `null` paths and are intentional.

`poll-fetch.ts` already imports and uses `logEvent` with
`component: "cron-poll-fetch"` (see the `feed-rate-limited` warn near line
2022) — match that convention.

The search site (`workers/api/src/routes/search.ts:645` at `3238d540`; find it
with `grep -n 'catch(() => \[\]' workers/api/src/routes/search.ts`):

```ts
// search.ts:641-647 — a thrown FTS error silently becomes "no results"
  }).catch(() => [] as RawSearchReleaseRow[]);
  let rawReleases = ftsRows;
  if (rawReleases.length === 0 && (orgs.length > 0 || catalog.length > 0)) {
```

`search.ts` does NOT currently import `logEvent` — add the import
(`import { logEvent } from "@releases/lib/log-event";`) and use
`component: "search"`.

The OrgActor site (`workers/api/src/org-actor.ts:149`):

```ts
// org-actor.ts:149 — malformed discovery JSON becomes {}, so the subsequent
// log reports sessionId: null instead of the real cause
const { sessionId } = (await res.json().catch(() => ({}))) as { sessionId?: string };
```

`org-actor.ts` uses `logEvent` with `component: "org-actor"` throughout — match it.

## Commands you will need

| Purpose        | Command                                              | Expected on success |
|----------------|------------------------------------------------------|---------------------|
| Install        | `bun install` (repo root; only if node_modules missing) | exit 0           |
| Lint + types   | `bun run check`                                      | exit 0              |
| API tests      | `bun test workers/api`                               | all pass            |
| Full suite     | `bun run test`                                       | all pass            |

Note: `bun run test` is a three-invocation chain (deliberate process isolation
for module mocks) — run it exactly via the script, not by hand-rolling the
directory list.

## Scope

**In scope** (the only files you should modify):
- `workers/api/src/cron/poll-fetch.ts`
- `workers/api/src/routes/search.ts`
- `workers/api/src/org-actor.ts`
- `workers/api/src/lib/log-swallowed.ts` (create)
- `workers/api/test/log-swallowed.test.ts` (create)

**Out of scope** (do NOT touch, even though they look related):
- The `.catch(() => null)` fallbacks in `poll-fetch.ts` (~lines 1000–1021) — handled-null paths, intentional.
- `workers/api/src/lib/feed-cache.ts`, `routes/feed.ts`, `routes/firecrawl.ts`, `routes/admin-emails.ts`, `routes/changelog.ts` — their catch sites were audited and are documented-intentional or feed handled fallbacks. Leave them.
- `workers/api/src/auth/index.ts` — its best-effort catches are commented by design.
- Any change to fail-open vs fail-closed semantics: every site must still swallow the error after logging. Do not rethrow anywhere.

## Git workflow

- Branch: `advisor/004-log-swallowed-ingest-writes`
- Conventional commits, e.g. `fix(api): log swallowed fetch-log and backoff write failures (#advisor-004)` — match the style visible in `git log --oneline -10`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the shared catch-handler helper

Create `workers/api/src/lib/log-swallowed.ts`:

```ts
import { logEvent } from "@releases/lib/log-event";

/**
 * `.catch()` handler for best-effort writes: keeps fail-open semantics
 * (resolves to undefined, never rethrows) but surfaces the failure in
 * Workers Logs instead of dropping it.
 */
export function logSwallowed(
  component: string,
  event: string,
  context: Record<string, unknown> = {},
): (err: unknown) => undefined {
  return (err) => {
    logEvent("warn", { component, event, ...context, error: err });
    return undefined;
  };
}
```

**Verify**: `bun run check` → exit 0.

### Step 2: Instrument the poll-fetch sites

In `workers/api/src/cron/poll-fetch.ts`, import the helper and replace each of
the 8 bare `.catch(() => {})` with a call that names the site. Event names:

- Group A (fetch_log inserts, 4 sites): `.catch(logSwallowed("cron-poll-fetch", "fetch-log-write-failed", { sourceSlug: source.slug }))`
- Group B backoff writes (lines 2020, 2090): `event: "backoff-write-failed"` — same shape, include `sourceSlug: source.slug`.
- Group B metadata/streak writes (lines 2062, 2069): `event: "source-metadata-write-failed"`, include `sourceSlug: source.slug`.

Use the enclosing scope's actual source identifier variable (it is
`source.slug` in all eight enclosing scopes at `3238d540`; if a site's scope
differs after drift, use whatever slug/id is in scope — never a token or URL
with credentials).

**Verify**: `grep -c 'catch(() => {})' workers/api/src/cron/poll-fetch.ts` → `0`, and `bun test workers/api` → all pass.

### Step 3: Instrument the search FTS fallback

In `workers/api/src/routes/search.ts`, replace the `.catch(() => [] as RawSearchReleaseRow[])` with:

```ts
.catch((err) => {
  logEvent("warn", { component: "search", event: "fts-query-failed", error: err });
  return [] as RawSearchReleaseRow[];
});
```

(Direct inline here rather than the helper, because the site needs a typed
array fallback, not `undefined`.) Add the `logEvent` import at the top of the
file.

**Verify**: `bun run check` → exit 0; `bun test workers/api` → all pass (search route tests exist and must stay green).

### Step 4: Instrument the OrgActor JSON parse

In `workers/api/src/org-actor.ts`, replace the `res.json().catch(() => ({}))` with:

```ts
const { sessionId } = (await res.json().catch((err) => {
  logEvent("warn", { component: "org-actor", event: "drain-response-bad-json", orgId, error: err });
  return {};
})) as { sessionId?: string };
```

(`orgId` is in scope in the alarm handler.)

**Verify**: `bun test workers/api/test/org-actor.test.ts` → all 7 existing tests pass.

### Step 5: Unit-test the helper

Create `workers/api/test/log-swallowed.test.ts` using `bun:test` (`describe`/`it`/`expect`, `spyOn`):

- `logEvent`'s `warn` level writes one line via `console.warn` (see `packages/lib/src/log-event.ts`). Use `spyOn(console, "warn")`, call `logSwallowed("test-comp", "test-event", { sourceSlug: "x" })(new Error("boom"))`, and assert: the handler returns `undefined`, does not throw, and the logged JSON line parses to an object containing `component: "test-comp"`, `event: "test-event"`, `sourceSlug: "x"`, and an `error` field whose `message` is `"boom"` (logEvent's replacer unwraps Errors into `{ name, message, stack }`).
- Restore the spy (`mockRestore()`) in `afterEach` — do NOT use `mock.module` anywhere in this test (process-global in bun, leaks across files).

**Verify**: `bun test workers/api/test/log-swallowed.test.ts` → new tests pass.

## Test plan

- New: `workers/api/test/log-swallowed.test.ts` — handler returns undefined, never throws, emits a parseable warn line with component/event/context/error.message (2–3 cases: Error input, string input).
- Regression: the existing suites already exercise every touched code path (`workers/api/test/org-actor.test.ts`, the search route tests, `appstore-poll-fetch.test.ts`). They must all stay green — `bun test workers/api`.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun run check` exits 0
- [ ] `bun test workers/api` exits 0, including the new `log-swallowed.test.ts`
- [ ] `grep -c 'catch(() => {})' workers/api/src/cron/poll-fetch.ts` → 0
- [ ] `grep -c 'catch(() => \[\]' workers/api/src/routes/search.ts` → 0
- [ ] `grep -c 'catch(() => ({}))' workers/api/src/org-actor.ts` → 0
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The grep in Step 2 finds a different number of sites than 8, or a site's
  enclosing scope has no source slug/id variable — the file has drifted;
  re-confirm each site's group (A vs B) before instrumenting, and report if
  any site looks like it became load-bearing (its result is now awaited into
  a variable that is used).
- Any existing test fails after a change and the failure is not obviously a
  log-line assertion — that means one of these catches was masking a real
  error that a test now surfaces. That is a genuine bug find: report it, do
  not paper over it.
- You find yourself wanting to rethrow or change control flow at any site.

## Maintenance notes

- If `fetch-log-write-failed` or `backoff-write-failed` shows up recurrently
  in Axiom (dataset `releases-cloudflare-logs`, filter on the `event` field),
  that is the signal to revisit fail-open — particularly the backoff writes,
  where repeated failure means a source is hammering a rate-limiting origin.
- Reviewers should scrutinize: no site changed from swallow to rethrow, and no
  logged payload carries a URL with embedded credentials or a token.
- Deferred (deliberately): the same sweep for `workers/discovery` — its catch
  sites were not audited in this pass.
