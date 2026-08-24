# HTTP Request Idempotency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a 24-hour, optional `Idempotency-Key` contract to the eight approved effectful POST routes, with atomic D1 admission, encrypted exact-response replay, strict principal isolation, and bounded cleanup.

**Architecture:** Paired D1 tables own the state machine: authoritative
`idempotency_guards` controls admission, state, expiry, and cleanup, while
trigger-synchronized `idempotency_records` holds mutable encrypted responses. A
route-level Hono helper runs pre-claim validation, atomically admits one winner,
captures and encrypts bounded responses, and replays completed results; each
route supplies an explicit principal plus pre-claim and winner-only callbacks.
Authentication remains outside the helper, while a dedicated principal adapter
prevents session, machine-token, root, OAuth M2M, local-development, and
anonymous namespaces from collapsing together.

**Tech Stack:** Bun, TypeScript strict mode, Hono, Cloudflare Workers Web Crypto, D1 + Drizzle ORM, `bun:test`, `hono-openapi`.

**Spec:** `docs/superpowers/specs/2026-08-24-http-idempotency-design.md`

## Global Constraints

- Use strict TDD for every behavior: write a real failing test, run it and capture the expected failure, implement the minimum code, then run it green.
- The supported routes are exactly `POST /v1/tokens`, `/v1/api-keys`, `/v1/me/webhooks`, `/v1/me/webhooks/:id/rotate-secret`, `/v1/me/webhooks/:id/test`, `/v1/webhooks/:id/test`, `/v1/recommendations`, and `/v1/feedback`.
- `Idempotency-Key` remains optional. A request without it must keep the existing execution path and must not require the encryption secret.
- Keys are 16–255 visible ASCII bytes (`0x21`–`0x7e`) with no whitespace; raw keys and raw principal identifiers are never logged or stored.
- The retention and processing barrier are exactly 24 hours from the initial claim; no lease stealing occurs inside that window.
- Fingerprints cover method, URL pathname, exact query string, trimmed/lowercased `Content-Type`, and exact request bytes. JSON is not canonicalized and `User-Agent` is excluded.
- Opted-in request bodies are capped at 64 KiB while streaming. Opted-in rotate/test routes reject non-empty bodies.
- Only 2xx JSON or UTF-8 text responses up to 64 KiB complete. Replay restores the exact status/body plus persisted `Content-Type`/`Location`, and adds `Idempotency-Replayed: true`.
- Normal 3xx/4xx returns and typed 4xx throws release the claim. Returned 5xx, unexpected throws, capture/encryption failures, and completion failures retain `processing` until expiry.
- A release that throws or affects zero rows replaces the would-be 3xx/4xx with `503 idempotency_unavailable`; the helper never claims corrected-key reuse when release was not confirmed.
- A handler-produced 2xx is returned only after exactly one guarded completion update succeeds; otherwise return `503 idempotency_unavailable`.
- Completed response bodies use AES-256-GCM with a base64-encoded 32-byte `IDEMPOTENCY_ENCRYPTION_KEY`. AAD binds version, principal hash, key hash, request hash, and status.
- Missing/invalid encryption configuration, missing deployed principal identity, subjectless OAuth without a stable verified client claim, key-fingerprint mismatch, and decrypt/authentication failure return `503 idempotency_unavailable` before any repeated effect.
- D1 admission, expiry reclaim, completion, and release invariants are single atomic SQL statements guarded by primary key, state, attempt ID, and expiry as applicable. Do not depend on the Bun SQLite shim's transaction behavior.
- Every non-2xx response uses the nested error envelope through `respondError`; never hand-roll `{ error: ... }`.
- Worker logging uses `logEvent()` only and never includes the raw idempotency key, raw principal, plaintext response, IV/ciphertext, or encryption key.
- No feature flag. Do not edit `.env`/`.dev.vars` files. Do not run migrations; create the migration file and leave application to the user.
- The repo is public: no absolute home paths, personal addresses, customer data, tokens, or secrets in committed files.
- Baseline on 2026-08-24: `bun run check` exits 0 with existing warnings; `bun run test` has 12 unrelated changelog/config failures before the isolated API process; `bun test workers/api` has 3 unrelated Slack-host/DNS failures in `me-webhooks.test.ts`. Focused task tests must be green; final reporting must distinguish these baseline failures from new failures.

## File Structure

- `workers/api/src/lib/idempotency-store.ts`: D1-only claim/read/complete/release/sweep operations and state types.
- `workers/api/src/lib/idempotency-crypto.ts`: key parsing, versioned AES-GCM response envelope, AAD construction, encrypt/decrypt.
- `workers/api/src/lib/idempotency-principal.ts`: explicit principal constructors/resolution; no request execution.
- `workers/api/src/middleware/idempotency.ts`: key/body validation, fingerprinting, route pre-claim/winner orchestration, response capture/replay.
- `workers/api/src/lib/idempotency-openapi.ts`: one reusable OpenAPI header/error fragment for all supported routes.
- `workers/api/src/cron/sweep-idempotency-records.ts`: bounded daily expiry cleanup and cron-run observability.
- Existing route files retain authorization and domain behavior; they are refactored only enough to separate pre-claim work from winner-only effects.

---

### Task 1: Atomic D1 idempotency state

**Files:**

- Modify: `packages/core/src/schema.ts`
- Create: `workers/api/migrations/20260824000000_add_idempotency_records.sql` (the retained migration name creates both tables and synchronization triggers)
- Create: `workers/api/src/lib/idempotency-store.ts`
- Create: `workers/api/test/idempotency-store.test.ts`
- Modify: `tests/db-helper.ts`

**Interfaces:**

- Consumes: `createDb()` and the existing `createTestDb()` fully migrated fixture.
- Produces:

```ts
export type IdempotencyState = "processing" | "completed";

export interface CompletedIdempotencyRecord {
  requestHash: string;
  responseStatus: number;
  responseHeaders: string;
  responseBody: string;
  expiresAt: string;
}

export type ClaimResult =
  | { kind: "claimed"; attemptId: string }
  | { kind: "completed"; record: CompletedIdempotencyRecord }
  | { kind: "processing" }
  | { kind: "conflict" }
  | { kind: "unavailable" };

export async function claimIdempotency(
  db: ReturnType<typeof createDb>,
  input: {
    principalHash: string;
    keyHash: string;
    requestHash: string;
    attemptId: string;
    now: string;
    expiresAt: string;
  },
): Promise<ClaimResult>;

export async function completeIdempotency(
  db: ReturnType<typeof createDb>,
  input: {
    principalHash: string;
    keyHash: string;
    attemptId: string;
    responseStatus: number;
    responseHeaders: string;
    responseBody: string;
    completedAt: string;
  },
): Promise<boolean>;

export async function releaseIdempotency(
  db: ReturnType<typeof createDb>,
  input: { principalHash: string; keyHash: string; attemptId: string },
): Promise<boolean>;

export async function sweepExpiredIdempotency(
  db: ReturnType<typeof createDb>,
  input: { now: string; limit: number },
): Promise<number>;
```

- Final storage shape: `idempotencyGuards` is the authoritative admission,
  state, expiry, and cleanup table, with the composite primary key, state
  check, and `idx_idempotency_guards_expires_at`. `idempotencyRecords` is its
  mutable encrypted-response partner with the same identity/attempt metadata
  and nullable response fields. Guard-insert, guard-delete, and
  response-completion triggers respectively create, remove, and complete the
  paired rows; no response-table expiry index is needed. A completed guard with
  a missing/incomplete/mismatched response is unavailable and must not rerun.

- [ ] **Step 1: Write the failing store tests**

Add tests that prove: one guard insert claims and creates its paired response
row; a matching duplicate is `processing`; a different request hash is
`conflict`; a completed guard returns stored response fields; a missing response
for a completed guard is `unavailable`; expired guards can be conditionally
reclaimed; an old attempt cannot complete/release a new claim; successful
complete/release affect exactly one guard; sweep deletes at most `limit` expired
guards and keeps live rows. Add a deterministic scripted-adapter test for the
reclaim interleaving `insert conflict → read missing → retry insert wins`, and a
second case that exhausts exactly three admission attempts and returns
`unavailable`.

Use literal hashes and ISO timestamps so expectations do not reuse production hash helpers:

```ts
const BASE = {
  principalHash: "p".repeat(64),
  keyHash: "k".repeat(64),
  requestHash: "r".repeat(64),
  attemptId: "attempt-one",
  now: "2026-08-24T12:00:00.000Z",
  expiresAt: "2026-08-25T12:00:00.000Z",
};
```

- [ ] **Step 2: Run RED**

Run: `bun test workers/api/test/idempotency-store.test.ts`

Expected: FAIL because `idempotency-store.ts` and the guard/response tables do
not exist.

- [ ] **Step 3: Add the guard/response tables and migration**

Import `primaryKey` from `drizzle-orm/sqlite-core`, add the authoritative guard
table with the exact fields/index/check above plus its mutable response table,
and write matching `CREATE TABLE`/`CREATE INDEX`/trigger SQL. Add both tables to
`clearAllTables()`.

- [ ] **Step 4: Implement the minimum store state machine**

Use `insert(...).onConflictDoNothing().returning({ attemptId })` on guards for
admission. On conflict, read the guard; if it disappeared between the losing
insert and read, retry admission. For an expired guard, delete only when the
same PK still has `expires_at <= now`, then retry whether this contender deleted
it or lost that delete race. Bound the full admission/read/reclaim loop to
exactly three insert attempts; return `unavailable` instead of executing after
exhaustion. Completion updates the paired response row, whose trigger must
complete exactly one matching processing guard; release deletes that guard and
its trigger deletes the paired response. A completed guard lacking a matching
complete response fails closed as `unavailable`. Implement the bounded sweep as
one atomic SQLite/D1 delete of guard rowids selected by `expires_at <= now ORDER
BY expires_at LIMIT limit`, and reject non-positive limits in TypeScript before
SQL.

- [ ] **Step 5: Run GREEN and schema gates**

Run:

```bash
bun test workers/api/test/idempotency-store.test.ts
bash scripts/check-migration-filenames.sh
```

Expected: all exit 0; do not apply the migration with Wrangler.

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/schema.ts tests/db-helper.ts workers/api/migrations/20260824000000_add_idempotency_records.sql workers/api/src/lib/idempotency-store.ts workers/api/test/idempotency-store.test.ts
git commit -m "feat(api): add atomic idempotency state store"
```

### Task 2: Principal isolation and OAuth M2M identity

**Files:**

- Modify: `packages/lib/src/oauth-jwt.ts`
- Modify: `packages/lib/src/oauth-jwt.test.ts`
- Modify: `workers/api/src/middleware/auth.ts`
- Modify: `workers/api/test/auth-oauth-jwt.test.ts`
- Modify: `workers/api/test/auth-middleware.test.ts`
- Create: `workers/api/src/lib/idempotency-principal.ts`
- Create: `workers/api/test/idempotency-principal.test.ts`

**Interfaces:**

- Consumes: the verified JWT payload and `AuthContext` already attached by API auth middleware.
- Produces:

```ts
export type IdempotencyPrincipal =
  | { namespace: "user"; id: string }
  | { namespace: "token"; id: string }
  | { namespace: "root"; id: "root" }
  | { namespace: "oauth-client"; id: string }
  | { namespace: "local-root"; id: "local-root" }
  | { namespace: "anonymous"; id: "anonymous" };

export function userIdempotencyPrincipal(userId: string): IdempotencyPrincipal;
export function anonymousIdempotencyPrincipal(): IdempotencyPrincipal;
export function authenticatedIdempotencyPrincipal(input: {
  auth?: AuthContext;
  localAuthSkip?: boolean;
  environment?: string;
}): IdempotencyPrincipal | null;
```

- `VerifiedOAuthToken` gains `clientId: string | null`, extracted only from a non-empty signed string `azp`, `client_id`, or `clientId` claim, in that order.
- Token `AuthContext` gains optional `oauthClientId`; subjectless OAuth keeps normal auth compatibility but idempotency refuses it when `oauthClientId` is absent.
- Hono variables gain `localAuthSkip?: true`; only the existing no-secret auth skip sets it. The principal helper accepts it only when `ENVIRONMENT` is absent, never for production/staging.

- [ ] **Step 1: Write failing JWT and principal tests**

Add signed JWT fixtures proving the client claim projection order and null result for missing/non-string claims. Add principal tests proving distinct user/token/root/OAuth/local/anonymous outputs; subjectless `oauth_m2m` without `oauthClientId` returns null; local skip with `ENVIRONMENT=production|staging` returns null.

- [ ] **Step 2: Run RED**

Run:

```bash
bun test packages/lib/src/oauth-jwt.test.ts workers/api/test/idempotency-principal.test.ts workers/api/test/auth-oauth-jwt.test.ts workers/api/test/auth-middleware.test.ts
```

Expected: FAIL on absent `clientId`, principal helpers, and local-skip context.

- [ ] **Step 3: Implement verified client projection and auth context**

Project the signed claim in `verifyOAuthJwt()`. When a subjectless JWT is accepted, retain the existing token lane but attach `oauthClientId`. Mark only the no-root-secret middleware branch as `localAuthSkip` before `next()`.

- [ ] **Step 4: Implement explicit principal constructors**

The helper must never read bearer/cookie values. Session routes call `userIdempotencyPrincipal(session.user.id)`; anonymous routes call the fixed constructor; admin/token routes pass `c.get('auth')`, `c.get('localAuthSkip')`, and `c.env.ENVIRONMENT` to the authenticated resolver.

- [ ] **Step 5: Run GREEN**

Run the Step 2 command again. Expected: all named files pass with no new warning/error output.

- [ ] **Step 6: Commit**

```bash
git add packages/lib/src/oauth-jwt.ts packages/lib/src/oauth-jwt.test.ts workers/api/src/middleware/auth.ts workers/api/src/lib/idempotency-principal.ts workers/api/test/auth-oauth-jwt.test.ts workers/api/test/auth-middleware.test.ts workers/api/test/idempotency-principal.test.ts
git commit -m "feat(api): isolate idempotency principals"
```

### Task 3: Encrypted route-level idempotency orchestration

**Files:**

- Modify: `packages/core/src/errors.ts`
- Modify: `packages/core/src/errors.test.ts`
- Modify: `packages/lib/src/releases-error.ts`
- Modify: `packages/lib/src/releases-error.test.ts`
- Create: `workers/api/src/lib/idempotency-crypto.ts`
- Create: `workers/api/test/idempotency-crypto.test.ts`
- Create: `workers/api/src/middleware/idempotency.ts`
- Create: `workers/api/test/idempotency.test.ts`
- Modify: `workers/api/src/index.ts` (binding/variable types only)

**Interfaces:**

- Consumes: Task 1 store operations and Task 2 `IdempotencyPrincipal`.
- Produces:

```ts
export interface IdempotencyBinding {
  get(): Promise<string>;
}

export interface ResponseBinding {
  principalHash: string;
  keyHash: string;
  requestHash: string;
  status: number;
}

export async function encryptIdempotencyBody(
  plaintext: Uint8Array,
  rawKey: string,
  binding: ResponseBinding,
): Promise<string>;

export async function decryptIdempotencyBody(
  envelope: string,
  rawKey: string,
  binding: ResponseBinding,
): Promise<Uint8Array>;

export async function idempotentPost<T>(
  c: Context<Env>,
  options: {
    principal: IdempotencyPrincipal | null;
    body: "json" | "empty";
    preclaim: () => Promise<T | Response>;
    execute: (input: T) => Promise<Response>;
  },
): Promise<Response>;
```

- Add error codes `idempotency_conflict`, `idempotency_in_progress`, and `idempotency_unavailable`.
- Add an additive `too_large` `ErrorType` mapped to 413 plus `PayloadTooLargeError`, preserving the invariant that a typed error's status derives from its type. Existing non-idempotent payload-limit producers are not migrated in this task.
- `Env.Bindings` gains `IDEMPOTENCY_ENCRYPTION_KEY?: SecretBinding`; Hono variables include Task 2's local marker.

- [ ] **Step 1: Write failing crypto tests**

Prove a literal 32-byte base64 key round-trips arbitrary bytes; ciphertext does not contain plaintext; IVs differ across encryptions; malformed base64/wrong length fail; changed status/principal/key/request AAD fails; tampered IV/ciphertext and wrong key fingerprint fail.

- [ ] **Step 2: Run crypto RED**

Run: `bun test workers/api/test/idempotency-crypto.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 3: Implement versioned AES-GCM envelope**

Use Web Crypto only. Encode the stored JSON envelope as `{ v: 1, kid, iv, ciphertext }`, with base64 fields and `kid` derived from SHA-256 of the raw 32 key bytes. Build AAD from a length-prefixed/versioned binary encoding of the five bound values; never concatenate with an ambiguous delimiter.

- [ ] **Step 4: Run crypto GREEN**

Run the Step 2 command again. Expected: all crypto tests pass.

- [ ] **Step 5: Write failing orchestration tests**

Mount a small Hono test app around the real helper and migrated test DB. Prove: no-header bypass; malformed key; streamed request >64 KiB; bodyless non-empty rejection; missing/malformed/wrong-length secret returns 503 before `execute` and leaves zero idempotency rows; exact method/path/query/content-type/body conflicts; principal isolation; concurrent matching claims admit one execution; exhausted claim contention returns unavailable; `Retry-After: 1`; completed exact status/body/header replay; header allowlist; typed/returned 4xx release; a release that returns false or throws replaces that response with 503; returned 5xx and unknown throw retain processing; capture/encrypt/zero-row completion failures return 503; 2xx is not returned before completion; expired reclaim; decrypt/AAD failure returns 503 without execution.

- [ ] **Step 6: Run orchestration RED**

Run:

```bash
bun test workers/api/test/idempotency.test.ts packages/core/src/errors.test.ts packages/lib/src/releases-error.test.ts packages/api-types/src/schemas/errors.test.ts
```

Expected: FAIL on the absent helper/error types/codes.

- [ ] **Step 7: Implement the minimum helper and taxonomy**

Validate/hash the key and principal with SHA-256; resolve and fully validate the encryption binding before any claim; clone and stream-read the request with a 64 KiB cutoff; hash the versioned fingerprint; call `preclaim`; claim; branch on conflict/processing/completed/unavailable; call `execute` only for the winner. Capture `Response.clone()` bytes, restrict media type to JSON/text and safe headers to `Content-Type`/`Location`, encrypt, require one completion row, and replay from decrypted bytes with `Idempotency-Replayed: true`. For returned/thrown client responses, return the original response only when `releaseIdempotency()` confirms one deletion; map false/throw to `503 idempotency_unavailable`. Use `respondError` with typed errors for every helper-generated failure.

- [ ] **Step 8: Run orchestration GREEN and focused check**

Run:

```bash
bun test workers/api/test/idempotency.test.ts workers/api/test/idempotency-crypto.test.ts packages/core/src/errors.test.ts packages/lib/src/releases-error.test.ts packages/api-types/src/schemas/errors.test.ts
bun run check
```

Expected: focused tests pass; check exits 0 with only baseline warnings.

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/errors.test.ts packages/lib/src/releases-error.ts packages/lib/src/releases-error.test.ts workers/api/src/index.ts workers/api/src/lib/idempotency-crypto.ts workers/api/src/middleware/idempotency.ts workers/api/test/idempotency-crypto.test.ts workers/api/test/idempotency.test.ts
git commit -m "feat(api): add encrypted idempotency orchestration"
```

### Task 4: Secret-returning route integrations

**Files:**

- Modify: `workers/api/src/routes/api-tokens.ts`
- Modify: `tests/api/api-tokens-route.test.ts`
- Modify: `workers/api/src/routes/user-api-keys.ts`
- Modify: `tests/api/user-api-keys-route.test.ts`
- Modify: `workers/api/src/routes/me-webhooks.ts`
- Modify: `workers/api/test/me-webhooks.test.ts`

**Interfaces:**

- Consumes: Task 2 principal constructors and Task 3 `idempotentPost()`.
- Produces: idempotent create/replay for token, API-key, webhook-create, and webhook-rotation responses; explicit bounded echoed fields.
- Input caps apply to all calls: token/API-key name ≤200 UTF-8 bytes, token `principalId` ≤255 UTF-8 bytes, webhook URL ≤2,048 UTF-8 bytes, webhook description ≤1,000 UTF-8 bytes. Token scopes are deduplicated in `API_SCOPES` order and cannot exceed the three known scopes.

- [ ] **Step 1: Write failing token and API-key route tests**

For each route prove: same key/body returns the original reveal-once credential and only one stored credential; changed body conflicts; no header still creates independently; missing secret prevents creation. Add byte-boundary tests with multibyte strings, token principal-ID cap, and duplicate-scope normalization.

- [ ] **Step 2: Run token/API-key RED**

Run:

```bash
bun test tests/api/api-tokens-route.test.ts tests/api/user-api-keys-route.test.ts
```

Expected: new idempotency/cap assertions fail while existing tests remain green.

- [ ] **Step 3: Refactor token/API-key handlers into pre-claim and winner phases**

Keep session/admin middleware outside. Parse and validate/cap inputs in `preclaim`; generate secret, quota-check where effect-specific, and insert/create only in `execute`. `/tokens` resolves authenticated/root/local/OAuth principal and fails unavailable when null; `/api-keys` uses the session user principal.

- [ ] **Step 4: Run token/API-key GREEN**

Run the Step 2 command again. Expected: all named tests pass.

- [ ] **Step 5: Write failing webhook create/rotation tests**

Prove exact signing-key replay and one subscription/one version increment; same key with a different subscription target/body conflicts; missing secret prevents mutation; normal 4xx validation does not consume the key; URL/description byte caps; no-header behavior remains. Rotation uses `body: 'empty'` and a non-empty opted-in body fails before version change.

- [ ] **Step 6: Run webhook RED**

Run only the new test names with Bun's filter so the three baseline Slack/DNS failures do not obscure the signal:

```bash
bun test workers/api/test/me-webhooks.test.ts --test-name-pattern "idempotency|byte cap"
```

Expected: new tests fail because the routes are not integrated.

- [ ] **Step 7: Refactor webhook create/rotation handlers**

Keep session/master-key/ownership/URL/filter validation in `preclaim`; insert and derive the created signing key in the winner callback. For rotation, load the owned subscription in pre-claim and increment only in the winner. Do not change unrelated webhook methods.

- [ ] **Step 8: Run route GREEN and focused aggregate**

Run:

```bash
bun test workers/api/test/me-webhooks.test.ts --test-name-pattern "idempotency|byte cap"
bun test tests/api/api-tokens-route.test.ts tests/api/user-api-keys-route.test.ts workers/api/test/idempotency.test.ts
```

Expected: all focused tests pass.

- [ ] **Step 9: Commit**

```bash
git add workers/api/src/routes/api-tokens.ts tests/api/api-tokens-route.test.ts workers/api/src/routes/user-api-keys.ts tests/api/user-api-keys-route.test.ts workers/api/src/routes/me-webhooks.ts workers/api/test/me-webhooks.test.ts
git commit -m "feat(api): make credential writes idempotent"
```

### Task 5: Queue and anonymous route integrations

**Files:**

- Modify: `workers/api/src/routes/me-webhooks.ts`
- Modify: `workers/api/test/me-webhooks.test.ts`
- Modify: `workers/api/src/routes/webhooks.ts`
- Modify: `workers/api/test/webhooks.test.ts`
- Modify: `workers/api/src/routes/recommendations.ts`
- Modify: `workers/api/test/recommendations.test.ts`
- Modify: `workers/api/src/routes/feedback.ts`
- Modify: `workers/api/test/feedback.test.ts`

**Interfaces:**

- Consumes: Task 3 helper; Task 4's established webhook route integration style.
- Produces: idempotent webhook-test enqueue and anonymous submission behavior.
- Pre-claim work on every attempt: feature availability, anonymous IP limiter, existing capped parse/sanitization/validation, subscription ownership/existence. Winner-only work: webhook-test user/subscription effect limiters, fresh event ID, queue send, D1 insert, and email/ack `waitUntil` scheduling.

- [ ] **Step 1: Write failing webhook-test tests**

For self-serve and admin routes prove: same key queues one message and replays the same event ID; changed target conflicts; matching duplicate while the first execution is pending returns in-progress; winner-only limiter runs once; a non-empty opted-in body fails before enqueue; no-header requests enqueue independently.

- [ ] **Step 2: Run webhook-test RED**

Run:

```bash
bun test workers/api/test/me-webhooks.test.ts --test-name-pattern "test idempotency"
bun test workers/api/test/webhooks.test.ts --test-name-pattern "test idempotency"
```

Expected: new tests fail because retries still enqueue twice.

- [ ] **Step 3: Integrate both test routes**

Put owned/admin subscription lookup in `preclaim`. Put per-user/per-subscription limits, event creation, and `queue.send()` in `execute`. Use session user principal for `/me` and authenticated/root/local/OAuth principal for the admin route.

- [ ] **Step 4: Run webhook-test GREEN**

Run the Step 2 commands again. Expected: all filtered tests pass.

- [ ] **Step 5: Write failing recommendation/feedback tests**

For each anonymous route prove: same key creates one row and schedules each notification/ack once; replay returns the original row ID; a changed body or reuse across the other anonymous route conflicts; IP limiter evaluates on replay; normal validation leaves the key reusable; missing secret prevents insert; no-header behavior remains unchanged.

- [ ] **Step 6: Run anonymous RED**

Run:

```bash
bun test workers/api/test/recommendations.test.ts workers/api/test/feedback.test.ts
```

Expected: new duplicate/replay assertions fail.

- [ ] **Step 7: Integrate anonymous routes**

Run feature-availability checks and the anonymous IP limiter at handler ingress
before `idempotentPost()` so they evaluate on every attempt, including replay.
Keep capped parsing, sanitization, and validation in `preclaim`; insert and
schedule emails only in `execute`. Use the fixed anonymous principal. Preserve
the winning request's `User-Agent` in the inserted recommendation without
adding it to the fingerprint.

- [ ] **Step 8: Run GREEN and focused aggregate**

Run:

```bash
bun test workers/api/test/recommendations.test.ts workers/api/test/feedback.test.ts
bun test workers/api/test/webhooks.test.ts --test-name-pattern "test idempotency"
bun test workers/api/test/me-webhooks.test.ts --test-name-pattern "test idempotency"
```

Expected: all focused tests pass.

- [ ] **Step 9: Commit**

```bash
git add workers/api/src/routes/me-webhooks.ts workers/api/test/me-webhooks.test.ts workers/api/src/routes/webhooks.ts workers/api/test/webhooks.test.ts workers/api/src/routes/recommendations.ts workers/api/test/recommendations.test.ts workers/api/src/routes/feedback.ts workers/api/test/feedback.test.ts
git commit -m "feat(api): make queued and anonymous writes idempotent"
```

### Task 6: Cleanup, OpenAPI, CORS, deployment contract, and final verification

**Files:**

- Create: `workers/api/src/cron/sweep-idempotency-records.ts`
- Create: `workers/api/test/sweep-idempotency-records.test.ts`
- Modify: `workers/api/src/index.ts`
- Modify: `workers/api/src/auth/index.ts`
- Modify: `workers/api/test/auth.test.ts`
- Create: `workers/api/src/lib/idempotency-openapi.ts`
- Create: `workers/api/test/idempotency-openapi.test.ts`
- Modify: all six route files from Tasks 4–5 to attach the shared docs fragment
- Modify: `workers/api/wrangler.jsonc`
- Create: `docs/architecture/idempotency.md`
- Modify: `docs/architecture/errors.md`
- Modify: `docs/architecture/deploy-coupling.md`
- Modify: `AGENTS.md`

**Interfaces:**

- Consumes: Task 1 `sweepExpiredIdempotency`, Task 3 binding/error contract, all integrated routes.
- Produces: daily bounded cleanup, browser-visible replay header, generated OpenAPI coverage, and deployment documentation.

- [ ] **Step 1: Write failing sweep tests**

Model the existing cron-run tests. Prove `CRON_ENABLED=false` no-ops; a fixed
`_now` deletes only expired guards in batches of 500 (and their trigger-managed
response rows); live guards remain; the cron-run row records candidate/deleted
counts; deletion failure finalizes aborted then rethrows.

- [ ] **Step 2: Run sweep RED**

Run: `bun test workers/api/test/sweep-idempotency-records.test.ts`

Expected: FAIL because the cron module does not exist.

- [ ] **Step 3: Implement and register cleanup**

Create the cron module with `logEvent`, `_drizzleOverride`, and `_now` seams.
Dispatch it alongside `sweepSearchQueries` in the existing `0 5 * * *` branch
so no new Wrangler trigger is needed; give it its own `cron_runs` name and
`waitUntil`/`loggedDispatch` call. The bounded delete targets expired guards;
their delete trigger removes paired response rows.

- [ ] **Step 4: Run sweep GREEN**

Run the Step 2 command again. Expected: all sweep tests pass.

- [ ] **Step 5: Write failing CORS/OpenAPI tests**

Extend the established CORS test to assert `Access-Control-Expose-Headers` includes `Idempotency-Replayed` on finalized non-OPTIONS responses. Generate `/v1/openapi.json` and assert all eight operations contain optional `Idempotency-Key`, describe 24-hour retention, and declare 409/503 plus the replay response header.

- [ ] **Step 6: Run docs-contract RED**

Run:

```bash
bun test workers/api/test/auth.test.ts --test-name-pattern "CORS"
bun test workers/api/test/idempotency-openapi.test.ts
```

Expected: replay exposure and OpenAPI operation assertions fail.

- [ ] **Step 7: Add CORS and shared OpenAPI fragment**

Apply `Access-Control-Expose-Headers: Idempotency-Replayed` after `next()` through the existing finalized-response CORS helper. Export one shared header parameter and 409/503 response fragment using `errorEnvelopeSchema`; attach `describeRoute()` to every supported handler without changing route registration or auth.

- [ ] **Step 8: Add secret bindings and human documentation**

Reference `IDEMPOTENCY_ENCRYPTION_KEY` in both production and staging Secrets Store arrays in `wrangler.jsonc`; do not create or edit any environment file. Document: UUID-v4 recommendation, exact fingerprint rules, replay/conflict states, 24-hour limit, encryption/rotation requirements, failure boundary, route list, cleanup, and client examples in `docs/architecture/idempotency.md`. Add the three idempotency codes and `too_large` type to `errors.md`, deployment ordering/key generation guidance to `deploy-coupling.md`, and one AGENTS convention line pointing to the architecture doc.

- [ ] **Step 9: Run docs-contract GREEN and gates**

Run:

```bash
bun test workers/api/test/auth.test.ts --test-name-pattern "CORS"
bun test workers/api/test/idempotency-openapi.test.ts workers/api/test/sweep-idempotency-records.test.ts
bun scripts/check-openapi-coverage.ts
bun run check
```

Expected: focused tests and gates pass; check may print only baseline warnings.

- [ ] **Step 10: Run the full focused idempotency matrix**

Run:

```bash
bun test workers/api/test/idempotency-store.test.ts workers/api/test/idempotency-crypto.test.ts workers/api/test/idempotency.test.ts workers/api/test/idempotency-principal.test.ts workers/api/test/sweep-idempotency-records.test.ts tests/api/api-tokens-route.test.ts tests/api/user-api-keys-route.test.ts workers/api/test/webhooks.test.ts workers/api/test/recommendations.test.ts workers/api/test/feedback.test.ts
bun test workers/api/test/me-webhooks.test.ts --test-name-pattern "idempotency|byte cap"
```

Expected: all focused tests pass.

- [ ] **Step 11: Re-run broad baselines and classify only deltas**

Run:

```bash
bun run test
bun test workers/api
```

Expected: no new failure beyond the recorded baseline. If baseline failures remain, include exact counts/names in the implementer report; do not fix unrelated tests in this PR.

- [ ] **Step 12: Commit**

```bash
git add AGENTS.md docs/architecture/idempotency.md docs/architecture/errors.md docs/architecture/deploy-coupling.md workers/api/wrangler.jsonc workers/api/src/index.ts workers/api/src/auth/index.ts workers/api/src/cron/sweep-idempotency-records.ts workers/api/src/lib/idempotency-openapi.ts workers/api/src/routes/api-tokens.ts workers/api/src/routes/user-api-keys.ts workers/api/src/routes/me-webhooks.ts workers/api/src/routes/webhooks.ts workers/api/src/routes/recommendations.ts workers/api/src/routes/feedback.ts workers/api/test/auth.test.ts workers/api/test/idempotency-openapi.test.ts workers/api/test/sweep-idempotency-records.test.ts
git commit -m "docs(api): publish idempotency operations contract"
```

## Plan Self-Review

- Spec coverage: storage/claim/reclaim/completion/release → Task 1; principal namespaces and M2M/local fail-closed behavior → Task 2; header/body/fingerprint/encryption/replay/error state machine → Task 3; secret-returning routes and response bounds → Task 4; queue/anonymous routes and limiter placement → Task 5; cleanup/CORS/OpenAPI/secret/deployment/docs → Task 6.
- Failure-boundary coverage: Task 3 tests processing retention and exact completion; Tasks 4–5 prove each real side effect is admitted once; docs in Task 6 state the D1/external-provider gap without claiming distributed exactly-once.
- Type consistency: Task 1 store names are consumed verbatim in Task 3 and Task 6. Task 2 principal type is consumed verbatim by Task 3 and all routes. Task 3 wrapper signature is consumed verbatim by Tasks 4–5.
- No placeholders: every task names exact files, interfaces, red/green commands, behavioral assertions, implementation constraints, and commit boundaries.
