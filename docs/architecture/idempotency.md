# HTTP request idempotency

Eight effectful public POST endpoints accept an optional `Idempotency-Key` so a
client can retry a request after a timeout or lost response without deliberately
creating a second credential, webhook action, recommendation, or feedback row.
There is no feature flag: requests without the header keep their existing path
and do not require an encryption secret.

## Client contract

Use a fresh UUID v4 for each intended operation. UUID v4 is a recommendation,
not a format requirement: a key must be 16–255 visible ASCII bytes (`0x21`–
`0x7e`) with no whitespace.

```sh
curl --request POST https://api.releases.sh/v1/feedback \
  --header 'Content-Type: application/json' \
  --header 'Idempotency-Key: 2f9bd66e-fc70-4c82-988c-0e062997b9e4' \
  --data '{"message":"Please add an export format."}'
```

Reuse that exact key only when retrying the same request. A request fingerprint
covers the HTTP method, URL pathname, exact query string, trimmed/lowercased
`Content-Type`, and exact request bytes. JSON is not canonicalized, and
`User-Agent` is intentionally excluded. A changed byte, query ordering, path,
method, or content type is a different request.

For 24 hours from the original claim:

| Stored state | Matching fingerprint | Result                                                                                                        |
| ------------ | -------------------- | ------------------------------------------------------------------------------------------------------------- |
| completed    | yes                  | Replays the original 2xx status, body, `Content-Type`, and `Location`; includes `Idempotency-Replayed: true`. |
| processing   | yes                  | Returns `409 idempotency_in_progress` with `Retry-After: 1`.                                                  |
| either       | no                   | Returns `409 idempotency_conflict`.                                                                           |

After 24 hours the key may be claimed again. A `503 idempotency_unavailable`
means the service cannot safely establish or replay the result; retry later with
the same key rather than assuming the requested effect did not happen. All error
responses use the standard nested envelope; see [errors.md](errors.md).

## D1 storage invariants

A single `idempotency_records` table holds both the admission barrier and the
encrypted response. Its `(principal_hash, key_hash)` primary key, `attempt_id`,
request fingerprint, `state`, and `expires_at` decide whether a handler may
execute; the same row's `response_status`/`response_headers`/`response_body`
columns hold the encrypted replay once the request completes.
`idx_idempotency_records_expires_at` is the only idempotency expiry index.

A claim inserts one `processing` row. Completion updates that same row to
`completed` and fills in the response columns in one statement, scoped to the
claiming `attempt_id` still in `processing` state — no second table, no
triggers to keep in sync.

Replay requires a `completed` row with all three response columns populated.
A missing, incomplete, or mismatched response fails closed as `503
idempotency_unavailable`; it never permits handler re-execution. Releasing or
expiring a row deletes it outright — there is no paired row to keep
consistent.

## Supported routes

Only these routes implement the contract:

- `POST /v1/tokens`
- `POST /v1/api-keys`
- `POST /v1/me/webhooks`
- `POST /v1/me/webhooks/:id/rotate-secret`
- `POST /v1/me/webhooks/:id/test`
- `POST /v1/webhooks/:id/test`
- `POST /v1/recommendations`
- `POST /v1/feedback`

The generated `/v1/openapi.json` document describes the optional header,
24-hour retention, 409/503 outcomes, and replay response header for each route.
Browser clients can read `Idempotency-Replayed` because API CORS exposes it on
finalized non-OPTIONS responses.

## Encryption and rotation

Completed responses are encrypted before D1 storage with AES-256-GCM. The API
worker needs an `IDEMPOTENCY_ENCRYPTION_KEY` Secrets Store binding whose value
is base64 for exactly 32 random bytes. Provision the secret in both production
and staging before applying the idempotency migration or deploying the worker;
an absent or invalid binding fails closed for opted-in requests with 503.

Rotate cautiously: a new key cannot decrypt records written with the old key,
so wait for the full 24-hour retention period after the last old-key response
before switching the binding. Never log, commit, or place the key in an
environment file. The stored idempotency key, principal identity, plaintext
response, IV, and ciphertext are likewise not logged.

## Cleanup and failure boundary

The daily 05:00 UTC API cron runs `sweep-idempotency-records`. It removes at
most 500 expired records per run through the expiry index and writes the
deletion count to `cron_runs`; live records are untouched. It only pays for a
follow-up `count(*)` (to flag a remaining backlog) when the delete hits the
500-row limit — an empty or partial batch skips that extra round trip.

The D1 claim, replay record, and completion checks prevent repeat route
execution within the contract. They are not a distributed transaction with an
external queue, email provider, or downstream webhook delivery: after D1 admits
a winner, an external effect can still have an unknown outcome if the worker
fails mid-call. In that case processing remains protected through expiry rather
than claiming a safe retry.
