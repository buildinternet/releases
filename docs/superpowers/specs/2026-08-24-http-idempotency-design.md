# HTTP Request Idempotency — Design

**Date:** 2026-08-24
**Status:** Design approved in conversation; written review requested
**Issue:** #2236
**Scope:** One bundled implementation for the public, effectful POST routes listed below

## Goal

Add an optional `Idempotency-Key` contract to the API's effectful public POST
routes so a client can safely retry after a timeout or lost response without
creating a second credential, webhook, queued test, recommendation, or feedback
submission.

The API has few clients and low write volume, so this ships as one coherent
surface rather than a sequence of per-route rollouts. Existing callers remain
compatible because the header is optional. Internal-only endpoints are outside
the public compatibility contract.

## Supported routes

The first release covers:

- `POST /v1/tokens`
- `POST /v1/api-keys`
- `POST /v1/me/webhooks`
- `POST /v1/me/webhooks/:id/rotate-secret`
- `POST /v1/me/webhooks/:id/test`
- `POST /v1/webhooks/:id/test`
- `POST /v1/recommendations`
- `POST /v1/feedback`

The self-serve webhook create and secret-rotation routes are included, as is the
explicitly listed admin webhook test route. Admin/internal webhook create and
secret-rotation endpoints are not. Existing resource-level idempotency such as
`POST /v1/me/follows` is also not replaced by this system.

## Client contract

### Header and retention

Clients opt in by sending:

```http
Idempotency-Key: 2f9bd66e-fc70-4c82-988c-0e062997b9e4
```

- A key is 16–255 visible ASCII characters (`0x21`–`0x7e`), with no whitespace.
- Clients should generate at least 128 bits of randomness; UUID v4 is the
  documented default.
- The raw key is never logged or stored. The server stores a SHA-256 digest.
- A completed result is replayable for 24 hours from the first accepted request.
- After 24 hours, the key may be used for a new request.
- Requests without the header keep today's behavior.

Malformed keys fail before a claim with the standard nested validation-error
envelope and do not consume the key. Opted-in request bodies are capped at 64
KiB and fail with `413` before a claim. The wrapper enforces the cap while
reading the cloned stream (with an early `Content-Length` rejection when
available), rather than buffering an unbounded body first. Rotate/test routes,
which have no request payload contract, reject a non-empty opted-in body.
Requests without the header retain their existing limits.

### Request identity

A key is unique inside its authenticated principal namespace. The first request
binds it to a fingerprint of:

- HTTP method;
- URL pathname and the exact query string as received;
- the trimmed, lowercased `Content-Type` header value; and
- the exact request-body bytes.

JSON is deliberately not canonicalized. Retrying with different whitespace,
property order, target, method, query, content type, or body is a different
request and returns `409 idempotency_conflict`. This catches accidental key reuse
without pretending that semantically similar payloads are identical. Incidental
metadata such as `User-Agent` is not part of the fingerprint; if a route persists
it, the winning attempt's value remains authoritative on replay.

Principal namespaces are:

- the signed-in user ID for session-authenticated routes;
- the stable token/key identity for machine-authenticated routes;
- a fixed root principal for the static root credential; and
- one shared anonymous namespace for recommendation and feedback submissions.

Subjectless OAuth client-credentials tokens must expose a stable, verified
client identity (for example an `azp`/client-id claim) before they can opt in.
Until the auth layer can derive that identity, an opted-in M2M request fails
with `503 idempotency_unavailable` before execution; the current shared
`oauth_m2m` label is never used as a replay namespace. In local development,
the auth middleware's explicit no-secret skip maps to a fixed `local-root`
principal. A missing principal in any deployed environment fails closed.

The anonymous routes depend on unguessable keys. A guessed key can cause a
conflict across the anonymous supported routes, or a replay only when the full
request fingerprint matches; it cannot cross into an authenticated principal's
namespace.

### Duplicate outcomes

For the same principal and key:

| Stored state | Matching fingerprint | Result                                                                                            |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------- |
| completed    | yes                  | Replay the original status, body bytes, and allowlisted headers; add `Idempotency-Replayed: true` |
| processing   | yes                  | `409 idempotency_in_progress` with `Retry-After: 1`                                               |
| either       | no                   | `409 idempotency_conflict`                                                                        |

Both conflicts use the standard nested error envelope. A processing claim is
not stolen or timed out early. It remains a duplicate-execution barrier for the
full 24-hour window.

## Storage design

The implementation uses two D1 tables represented in the shared Drizzle
schema. `idempotency_guards` is authoritative for admission, conflicts,
processing/completed state, expiry, and cleanup. It has the composite
`(principal_hash, key_hash)` primary key, `request_hash`, `state`, claimant
`attempt_id`, timestamps, and `idx_idempotency_guards_expires_at`.

`idempotency_records` is the paired, mutable encrypted-response table. It
holds the same identity, fingerprint, attempt, state, and retention metadata
plus nullable `response_status`, `response_headers`, and encrypted
`response_body`. It is not an independent source of admission or expiry truth
and has no expiry-cleanup index.

Triggers keep the pair synchronized: inserting a guard creates its processing
response row; deleting a guard deletes its response row; and completing the
response row updates the matching processing guard (same primary key and
`attempt_id`) to completed, aborting the response update if that guard update
does not affect exactly one row. Thus only a guard insert authorizes handler
execution, and deleting an expired or released guard removes both rows.

The principal identifier is also hashed so the table does not become a secondary
identity log. The request hash is SHA-256 over a versioned binary encoding of the
fingerprint fields, avoiding delimiter ambiguity.

### Claim protocol

The wrapper performs one conflict-safe `INSERT ... ON CONFLICT DO NOTHING` to
claim a key. A successful insert is the only permission to run the handler.

If the insert loses, the wrapper reads the existing guard and chooses replay,
in-progress conflict, or fingerprint conflict. A completed guard can replay
only when its matching completed response row has the same `attempt_id` and all
recorded response fields. A missing, mismatched, or incomplete response row is
`idempotency_unavailable`, never permission to rerun the handler. If the guard
is expired, the wrapper conditionally deletes it and retries the insert.
Concurrent reclaimers still converge on a single winning insert.

Every completion or release statement is guarded by the claimant's `attempt_id`
and `state = 'processing'`, so an old handler cannot mutate a later claim. These
are single-statement D1 invariants; the implementation does not depend on the
test fixture's transaction behavior.

### Completion and release

- A bounded 2xx response is encrypted and completes the mutable response row;
  its completion trigger changes the matching guard to `completed` in the same
  D1 statement boundary.
- A normal 3xx or 4xx response releases the claim by deleting its processing
  guard, which triggers deletion of the paired response row. Corrected input
  can then reuse the key. Authentication occurs before the wrapper, and
  header/key validation also occurs before the claim.
- A thrown typed 4xx error releases the claim before propagating to the standard
  error responder.
- A returned 5xx response, unexpected throw, response-capture failure, or
  completion-write failure leaves the authoritative guard in `processing` until
  expiry.
  Retrying is unsafe because the side effect may already have happened.

For a handler-produced 2xx, the wrapper returns that response only after a
guarded completion update confirms exactly one record transitioned from
`processing` to `completed`. Capture, encryption, or completion failure
(including an update that affects zero rows) replaces the would-be 2xx with
`503 idempotency_unavailable` and keeps the claim unavailable for replay.

Only JSON or UTF-8 text responses up to 64 KiB are recordable. The selected
routes will add explicit validation caps for every caller-controlled field echoed
in these responses: token and API-key names (200 bytes), token principal IDs
(255 bytes), webhook URLs (2,048 bytes), and webhook descriptions (1,000 bytes).
Token scopes are deduplicated and limited to the three members of the scope
ladder. Tests serialize worst-case accepted values and prove the response remains
below the capture limit. If an opted-in response still cannot be recorded, the
request fails closed and retains the processing barrier; requests without an
idempotency key are unaffected.

Stored response headers are an explicit allowlist: `Content-Type` and
`Location`. Authentication, cookies, CORS, tracing, rate-limit, and platform
headers are never persisted. Existing ingress/auth and anonymous-IP abuse
limiters still evaluate every HTTP attempt; the idempotency layer adds no
separate replay debit. Effect-specific limits, such as the per-user and
per-subscription webhook-test limits, run only for the winning execution.

## Response encryption

Completed responses can contain reveal-once API keys, token secrets, and webhook
signing material. All stored response bodies are therefore encrypted at rest,
including currently non-secret routes, using AES-256-GCM through Web Crypto.

The worker receives a dedicated, base64-encoded 32-byte
`IDEMPOTENCY_ENCRYPTION_KEY` secret. The ciphertext envelope is versioned and
stores the random 96-bit IV plus a non-secret key fingerprint. Authenticated
additional data binds the ciphertext to the principal hash, key hash, request
hash, status, and envelope version.

If the binding is absent or invalid, an opted-in request fails with a standard
`503 idempotency_unavailable` response before claiming or executing. We do not
edit environment files or provision the production secret in this change; that
is an explicit deployment prerequisite. The key must remain stable for at least
the 24-hour replay window. A mismatched key fingerprint or decryption failure
also fails closed with `503` and never re-executes the effect.

## Route integration

Idempotency is a route-level wrapper applied after authentication has resolved a
stable principal and around the effectful handler. It is not global middleware:

- public read routes should pay no D1 or body-capture cost;
- different authentication lanes need explicit principal derivation;
- only known bounded responses are safe to persist; and
- route-local validation and side-effect boundaries need deliberate placement.

The helper owns key validation, bounded raw-body fingerprinting, claim/replay,
response capture, encryption, completion, and release. Integration exposes two
deliberate phases: pre-claim guards that must evaluate on every HTTP attempt, and
the winner-only effect handler. Authentication, feature availability, request
size/key validation, and anonymous-IP abuse limits are pre-claim. DB mutation,
queue/email scheduling, and effect-specific limits are winner-only. This requires
small route refactors, but keeps the wire behavior consistent and route
authorization visible.

## Cleanup and expiry

A scheduled sweep deletes expired guards in bounded batches through
`idx_idempotency_guards_expires_at`; the delete trigger removes the paired
response rows. Claim processing also reclaims an expired matching guard, so
delayed cron execution cannot make a key unusable beyond the contract window.

There is intentionally no short processing lease. These handlers normally finish
in seconds; allowing a second claimant while the first may still be running would
turn a slow request into a duplicate side effect. The 24-hour boundary is the
maximum execution barrier: a handler still running after expiry could overlap a
new claim, which is acceptable for this workload and documented as the outer
limit of the guarantee.

## Failure boundary

This design provides at-most-once handler admission for a principal/key pair
during the retention window and exact replay after the result is committed. It
does not claim distributed exactly-once delivery.

In particular, queue sends and email/provider calls cannot be atomically
committed with D1. If an external side effect succeeds and the Worker dies before
the completed response is stored, the guard remains `processing`: the client
gets a temporary conflict instead of risking a duplicate. If D1 loses the claim
itself, or a retry happens after expiry, downstream idempotency/outbox guarantees
would be required for a stronger result. Adding a general outbox is outside this
epic.

## Errors and documentation

Add stable taxonomy codes for:

- `idempotency_conflict` (`409`);
- `idempotency_in_progress` (`409`);
- `idempotency_unavailable` (`503`); and
- the existing validation/type machinery for malformed or oversized opted-in
  requests.

OpenAPI documents the optional header, 24-hour retention, replay header, conflict
responses, and route coverage. CORS exposes `Idempotency-Replayed` so browser
clients can inspect the non-safelisted response header, with a regression test
covering the exposure. Architecture documentation records the secret and cleanup
requirements. No feature flag is added: the behavior is opt-in, and a missing
encryption secret already fails closed only for callers using the new header.

## Validation plan

The implementation is accepted only with tests proving:

1. Concurrent identical claims admit one handler and return in-progress for the
   loser.
2. A retry after a lost response replays the exact original status/body,
   including reveal-once credential responses.
3. The same key with a changed method, target, media type, or body returns the
   stable conflict code.
4. The same key is isolated across user, machine, root, and anonymous principal
   namespaces as applicable.
5. Completed ciphertext cannot be read as plaintext and fails authentication if
   its bound fields are changed.
6. Missing/invalid encryption configuration fails before handler execution.
7. Normal validation failures release the claim; unexpected post-claim failures
   retain it.
8. Expired records are reclaimable and the scheduled sweep is bounded.
9. Each supported route executes its DB insert, rotation, queue send, or
   notification scheduling at most once for a matching key within the supported
   failure boundary.
10. Requests without `Idempotency-Key` preserve existing behavior.

Unit tests exercise the state machine, cryptography, response capture, and race
outcomes. Route tests prove integration for every supported route. Because the
local SQLite/D1 shim cannot prove Cloudflare's cross-request concurrency model,
the implementation also keeps the ownership invariant in single atomic SQL
statements and documents that limitation rather than treating the shim as
distributed-runtime proof.

## Rollout

1. Land schema, helper, route integrations, cleanup, tests, and docs together.
2. The user applies the migration; the agent does not run migrations directly.
3. The user provisions the same 32-byte encryption secret in each deployed API
   environment before clients begin sending the header.
4. Deploy normally. Existing clients are unaffected until they opt in.
5. Verify one secret-returning route and one anonymous route with a fresh key,
   replay, conflicting payload, and concurrent duplicate.
