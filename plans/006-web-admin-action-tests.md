# Plan 006: Tests for the web admin server actions (`web/src/app/actions/`)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 3238d540..HEAD -- web/src/app/actions/ web/src/lib/admin-action.ts web/src/lib/local-admin-flag.ts`
> If any of these changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW–MED (test-only, but introduces module mocks into the shared web test process — see Step 1)
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `3238d540`, 2026-07-02

## Why this matters

`web/src/app/actions/` holds 7 server-action files (org-admin, source-admin,
product-admin, release-admin, collection-admin, api-tokens, site-notice) that
perform privileged mutations against the API — hide an org, suppress a
release, mint tokens, publish the site-wide notice — and then revalidate
cached pages. They have zero tests and heavy recent churn (the #1624 per-user
admin JWT migration rewired how every one of them authenticates). A regression
here fails silently in the worst way: the action returns `ok`, but the page
was never revalidated (stale cache served), or the error branch swallows a
403. These tests pin the contract: correct URL/method/headers to the API,
correct `ActionResult` mapping for success / API error / network error, and
`revalidatePath` called with the right paths on success only.

## Current state

Relevant files:

- `web/src/app/actions/*.ts` — 7 files, all `"use server"`, all following the
  same shape (excerpt from `site-notice.ts`, verbatim at `3238d540`):

```ts
"use server";
import { revalidatePath } from "next/cache";
import { webApiHeaders } from "@/lib/api";
import { adminActionEnv } from "@/lib/admin-action";

type ActionResult = { ok: true } | { ok: false; error: string };

export async function setSiteNoticeAction(notice: SiteNotice): Promise<ActionResult> {
  const env = await adminActionEnv();
  if ("error" in env) return { ok: false, error: env.error };
  let res: Response;
  try {
    res = await fetch(`${env.apiUrl}/v1/site-notice`, {
      method: "PUT",
      headers: webApiHeaders({ "Content-Type": "application/json", Authorization: `Bearer ${env.bearer}` }),
      body: JSON.stringify(notice),
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Network error" };
  }
  // ... non-ok mapping, then revalidatePath(...) on success
```

- `web/src/lib/admin-action.ts` — `adminActionEnv()` resolves
  `{ apiUrl, bearer }`. **Two modes**: when `isLocalAdminEnabled()` is true it
  returns the static `RELEASES_API_KEY` and never touches request context;
  otherwise it mints a per-user JWT via `next/headers` `cookies()`. It also
  `import "server-only"`.
- `web/src/lib/local-admin-flag.ts` — `isLocalAdminEnabled()` returns true iff
  `NODE_ENV !== "production"`, `VERCEL_ENV !== "production"`, and
  `serverApiKey()` (reads `RELEASES_API_KEY` / legacy `RELEASED_API_KEY`) is
  set. **This is the test lever**: with a fake `RELEASES_API_KEY` env var set
  in the test, `adminActionEnv()` takes the local branch and `next/headers` is
  never called.
- Existing web tests (`web/src/lib/*.test.ts`, e.g.
  `account-api-proxy.test.ts`) are plain `bun:test` unit tests. They run in
  the SHARED root test process (`bun test tests/ web/ workers/discovery
  workers/mcp workers/webhooks`) — see "the mock leak rule" below.

**The two import obstacles** (why these files aren't trivially importable in
bun:test) and their required mocks:

1. `server-only` — throws on import outside a React Server environment.
2. `next/cache` — `revalidatePath` throws outside a Next request scope.

**The mock leak rule (critical)**: bun's `mock.module()` is process-global,
keyed by resolved module path, and NOT restorable. Mocking `server-only` and
`next/cache` will affect every other test in the shared process that imports
those specifiers. Today none do (verify in Step 1) — a no-op `server-only` and
a recording `revalidatePath` are behavior-compatible for any future test that
would otherwise crash on the real ones, but the mocks must live in ONE shared
helper file so there is exactly one mock implementation, and must NOT touch
any other specifier (`next/headers` especially — avoid needing it by testing
through the local-admin branch).

## Commands you will need

| Purpose        | Command                                                     | Expected on success |
|----------------|-------------------------------------------------------------|---------------------|
| Install        | `bun install` (repo root; only if needed)                   | exit 0              |
| Lint + types   | `bun run check`                                             | exit 0              |
| Web leg only   | `bun test web/`                                             | all pass            |
| Shared process | `bun test tests/ web/ workers/discovery workers/mcp workers/webhooks` | all pass (leak check) |
| Full suite     | `bun run test`                                              | all pass            |

## Scope

**In scope** (the only files you should create/modify):
- `web/src/app/actions/test-helpers.ts` (create — the single mock + fetch-stub helper)
- `web/src/app/actions/site-notice.test.ts` (create)
- `web/src/app/actions/org-admin.test.ts` (create)
- `web/src/app/actions/release-admin.test.ts` (create)
- `web/src/app/actions/api-tokens.test.ts` (create)

(Four action files covered directly; source-admin/product-admin/collection-admin
share the identical shape — cover them only if time allows, they are P3 within
this plan.)

**Out of scope** (do NOT touch):
- ANY file under `web/src/app/actions/` other than new `*.test.ts` +
  `test-helpers.ts` — no refactoring the actions "to make them testable".
- `web/src/lib/admin-action.ts`, `local-admin-flag.ts`, `env.ts` — read-only.
- The production (JWT/cookies) branch of `adminActionEnv` — it requires
  `next/headers` mocking; explicitly deferred (see Maintenance notes).
- `next-env.d.ts` — never commit dev-server rewrites to it.

## Git workflow

- Branch: `advisor/006-web-admin-action-tests`
- Conventional commits, e.g. `test(web): pin admin server-action contracts (fetch shape, ActionResult, revalidate)`
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Confirm the leak surface is clear, then write the shared helper

First verify no existing test in the shared process imports the specifiers you
are about to mock:

```
grep -rn "server-only\|next/cache" tests/ web/src --include='*.test.ts' --include='*.test.tsx'
```

Expected: no matches (only non-test source files import them). If there ARE
matches, STOP (see STOP conditions).

Create `web/src/app/actions/test-helpers.ts`:

```ts
import { mock } from "bun:test";

// Process-global module mocks (bun mock.module is not restorable — these are
// deliberately benign, shared, and defined ONCE here; do not duplicate them
// in individual test files).
mock.module("server-only", () => ({}));

export const revalidatedPaths: string[] = [];
mock.module("next/cache", () => ({
  revalidatePath: (path: string, _type?: string) => {
    revalidatedPaths.push(path);
  },
}));

/** Route adminActionEnv() down its local-admin branch (no next/headers). */
export function enableLocalAdminEnv(): void {
  process.env.RELEASES_API_KEY = "test-admin-key";
  process.env.NEXT_PUBLIC_RELEASES_API_URL ??= "http://api.test.local";
}

export interface RecordedRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

/** Stub globalThis.fetch; records requests, returns the queued responses. */
export function stubFetch(responses: Response[]): RecordedRequest[] { /* records into an array, shifts responses, throws if queue empty */ }
```

Implement `stubFetch` fully (save/restore of the original fetch via an
exported `restoreFetch()` used in `afterEach`). Check `web/src/lib/env.ts`
for the exact env var `apiBaseUrl()` reads and set that one in
`enableLocalAdminEnv()` — do not guess the name; open the file.

**Verify**: `bun run check` → exit 0.

### Step 2: site-notice tests (the template)

`web/src/app/actions/site-notice.test.ts` — import the helper FIRST (so mocks
register before the action module loads), then the action. Cases:

1. Happy path: stub 200 → returns `{ ok: true }`; recorded request has method
   `PUT`, URL `<apiUrl>/v1/site-notice`, `Authorization: Bearer test-admin-key`,
   JSON body matching the input; `revalidatedPaths` contains `"/"`.
2. API error: stub 403 with an error-envelope JSON body → `{ ok: false, error: … }`
   and `revalidatedPaths` is empty (clear the array in `beforeEach`).
3. Network error: stub fetch that rejects → `{ ok: false, error }` and no revalidation.
4. Gate closed: unset `RELEASES_API_KEY` for this case (and restore after) →
   the action returns the env error without any fetch recorded. NOTE: with the
   key unset AND no cookies, `adminActionEnv` hits `mintUserJwt` →
   `cookies()` from `next/headers`, which will throw in bun:test. If that is
   what happens, assert the throw-or-error behavior you actually observe and
   label the test `"characterizes current behavior"` — or skip case 4 and note
   it; do NOT add a `next/headers` mock for one case.

**Verify**: `bun test web/src/app/actions/site-notice.test.ts` → all pass.

### Step 3: Replicate for org-admin, release-admin, api-tokens

Same four-case shape per exported action (happy / API error / network error —
gate-closed once per file is enough). Assert the action-specific contract:
exact endpoint path + method, and the exact `revalidatePath` arguments (e.g.
`org-admin` revalidates `"/"` and `` `/${input.slug}` ``; `release-admin`
revalidates `` `/release/${input.id}` `` and conditionally `input.redirectTo`).
Read each action file and enumerate its exported functions; cover every
exported mutating function with at least the happy path, and the shared error
mapping once per file.

**Verify**: `bun test web/src/app/actions/` → all pass.

### Step 4: Leak check + full suite

Run the exact shared-process invocation to prove the module mocks didn't break
a neighbor: `bun test tests/ web/ workers/discovery workers/mcp workers/webhooks`
→ all pass. Then `bun run test` → all pass, `bun run check` → exit 0.

## Test plan

Covered above — ~4 cases × 4 files plus per-action happy paths (~20–30 `it`
cases). Model file layout and naming on `web/src/lib/account-api-proxy.test.ts`
(plain bun:test, `describe` per unit).

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `bun test web/` exits 0, including ≥4 new action test files
- [ ] `bun test tests/ web/ workers/discovery workers/mcp workers/webhooks` exits 0 (no mock leak fallout)
- [ ] `bun run check` exits 0
- [ ] `mock.module` appears ONLY in `web/src/app/actions/test-helpers.ts`: `grep -rln "mock.module" web/src` → exactly that one file
- [ ] `git status` shows no modified files outside the in-scope list
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Step 1's grep finds an existing test importing `server-only` or
  `next/cache` — the leak calculus changes; report before mocking anything.
- Importing an action file still fails after the two mocks (a third
  Next-runtime dependency has appeared since `3238d540`).
- The shared-process invocation in Step 4 fails in a file you did not create —
  that is the mock leaking; report which file and stop.
- You feel the need to modify any action or lib source file to make a test
  pass.

## Maintenance notes

- The production-mode branch of `adminActionEnv` (per-user JWT via
  `cookies()`) is deliberately untested here — testing it means mocking
  `next/headers`, which widens the process-global mock surface. If someone
  later builds a web integration harness, that branch is the first candidate.
- Anyone adding a new server action should copy the four-case template; the
  helper in `test-helpers.ts` is the single place the Next mocks live — never
  add a second `mock.module` call site in `web/`.
- Reviewers should scrutinize: tests assert the recorded request (URL, method,
  auth header, body) — not just the `ActionResult` — since the request shape
  is the actual API contract.
