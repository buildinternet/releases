# Standardized Errors — Phase 3 Code-Mapping Table

> The judgment artifact the handoff (`2026-07-02-standardized-errors-phase3-handoff.md`)
> asks for **before** planning. Every distinct flat `error: "<code>"` string produced in
> `workers/api/src/routes/**` mapped to the `{ code, type }` it becomes, plus the fold/promote
> decision and any status normalization. Measured on `main` @ a8623fc + the Explore status sweep.

## Governing rules

1. **HTTP status is preserved at every site.** Status is derived from `type`
   (`STATUS_BY_TYPE`), so each code maps to the `type` whose status equals what the
   site returns today. Two statuses have **no `type`** and are normalized (documented,
   deliberate — the design forbids hand-picked status and caps `type` at ≤10 coarse values):
   - **413 → 400** (`payload_too_large`): validation-class; distinct `code` retained so a
     client can still branch, status normalizes to 400.
   - **410 → 404** (`snapshot_expired`): not-found-class; distinct `code` retained.
   - The dynamic **github_upstream_error 503-when-GitHub-429** collapses to a flat **502**
     (`upstream`); both were "upstream problem", the 503 nuance is dropped.
2. **Registry = existing 14 + 9 promotions** (below). A code is **promoted** (added to
   `ERROR_CODES`) only when it names a distinct resource/quota a client plausibly branches on.
   Everything else is **folded** into its `type`'s canonical code, **preserving the human
   `message`**, with `details` added where a machine-useful field exists.
3. **`expose` follows the type.** `upstream`/`internal` force `expose:false`, so folded
   `github_upstream_error`/`feed_unavailable`/`bad_gateway`/`insert_failed`/`update_failed`/
   `*_unbound` sites stop returning their human message (generic message instead) — this is the
   design intent (never leak upstream/internal detail); `details` carries the discriminator.

## Registry changes to `packages/core/src/errors.ts`

Add these 9 to `ERROR_CODES` (all map to an existing `type`; no new `ErrorType`):

| new code             | type         | status | why promoted                                         |
| -------------------- | ------------ | ------ | ---------------------------------------------------- |
| `instance_not_found` | not_found    | 404    | workflow-instance polling; client branches           |
| `client_not_found`   | not_found    | 404    | OAuth client lookup; DCR clients branch              |
| `user_not_found`     | not_found    | 404    | admin user-mgmt; distinct from generic 404           |
| `snapshot_expired`   | not_found    | 404    | raw-snapshot expired (was 410); distinct remediation |
| `slug_reserved`      | conflict     | 409    | onboarding/CLI branches reserved-vs-taken            |
| `api_key_limit`      | conflict     | 409    | key-mgmt UI branches on quota                        |
| `limit_exceeded`     | rate_limited | 429    | webhook cap; distinct from generic 429               |
| `embed_unavailable`  | unavailable  | 503    | search degrades to FTS on this                       |
| `payload_too_large`  | validation   | 400    | body-size cap (was 413); distinct client remediation |

Also **normalize the D1 casing**: `classifyDbError`/`db-errors.ts` emit `DB_TOO_MANY_VARIABLES`;
the wire code is `db_too_many_variables` (already in the registry). Reconcile onto the
snake_case registry value (handoff item #4), removing the `db.code === "DB_TOO_MANY_VARIABLES"`
special-case string in `respondError`.

## Full mapping (56 distinct strings)

### type `validation` → 400 (subclass `ValidationError`)

| flat code (uses)              | → wire code             | note                                                                                                       |
| ----------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------- |
| `bad_request` (169)           | `bad_request`           | canonical; generic handler-input validation                                                                |
| `invalid_json` (20)           | `invalid_json`          | canonical                                                                                                  |
| `bare_slug_rejected` (8)      | `bare_slug_rejected`    | canonical; `details:{entity,slug}` (via `BareSlugRejected` path — already nested)                          |
| `payload_too_large` (5)       | **`payload_too_large`** | **promote**; 413 → **400**                                                                                 |
| `invalid_type` (3)            | fold → `bad_request`    | keep message                                                                                               |
| `invalid_param` (3)           | fold → `bad_request`    | keep message                                                                                               |
| `invalid_status` (2)          | fold → `bad_request`    | keep message                                                                                               |
| `invalid_archived` (2)        | fold → `bad_request`    | keep message                                                                                               |
| `missing_required_fields` (2) | fold → `bad_request`    | keep message                                                                                               |
| `nothing_to_update` (2)       | fold → `bad_request`    | keep message                                                                                               |
| `bad_date` (2)                | fold → `bad_request`    | keep message                                                                                               |
| `unsupported_source_type` (1) | fold → `bad_request`    | keep message                                                                                               |
| `no_fields_to_update` (1)     | fold → `bad_request`    | keep message                                                                                               |
| `missing_parameter` (1)       | fold → `bad_request`    | keep message                                                                                               |
| `missing_org` (1)             | fold → `bad_request`    | keep message                                                                                               |
| `misconfigured` (1)           | fold → `bad_request`    | 400 site (workflows.ts:215)                                                                                |
| `message_required` (1)        | fold → `bad_request`    | keep message                                                                                               |
| `invalid_tokens` (1)          | fold → `bad_request`    | keep message                                                                                               |
| `invalid_role` (1)            | fold → `bad_request`    | keep message                                                                                               |
| `invalid_redirect_uri` (1)    | fold → `bad_request`    | keep message                                                                                               |
| `invalid_recipient` (1)       | fold → `bad_request`    | keep message                                                                                               |
| `invalid_parameter` (1)       | fold → `bad_request`    | synonym of invalid_param                                                                                   |
| `invalid_max` (1)             | fold → `bad_request`    | keep message                                                                                               |
| `invalid_email` (1)           | fold → `bad_request`    | keep message                                                                                               |
| `url_required` (1)            | fold → `bad_request`    | keep message                                                                                               |
| `bad_source_url` (1)          | fold → `bad_request`    | keep message                                                                                               |
| `bad_citations` (1)           | fold → `bad_request`    | overview handler business rule (overview.ts:118) — **test asserts `bad_citations`, flip to `bad_request`** |
| `public_client_no_secret` (1) | fold → `bad_request`    | OAuth (admin-oauth.ts:165)                                                                                 |

### type `unauthorized` → 401 (subclass `UnauthorizedError`)

| flat code (uses)    | → wire code                |
| ------------------- | -------------------------- |
| `unauthorized` (27) | `unauthorized` (canonical) |

### type `forbidden` → 403 (subclass `ForbiddenError`)

| flat code (uses) | → wire code             |
| ---------------- | ----------------------- |
| `forbidden` (1)  | `forbidden` (canonical) |

(`insufficient_scope` canonical code exists; used by scope middleware, not in this inline sweep.)

### type `not_found` → 404 (subclass `NotFoundError`)

| flat code (uses)         | → wire code              | note                            |
| ------------------------ | ------------------------ | ------------------------------- |
| `not_found` (146)        | `not_found`              | canonical                       |
| `instance_not_found` (7) | **`instance_not_found`** | promote; `details:{instanceId}` |
| `client_not_found` (4)   | **`client_not_found`**   | promote                         |
| `user_not_found` (2)     | **`user_not_found`**     | promote                         |
| `snapshot_expired` (1)   | **`snapshot_expired`**   | 410 → **404**; promote          |

### type `conflict` → 409 (subclass `ConflictError`)

| flat code (uses)    | → wire code         | note      |
| ------------------- | ------------------- | --------- |
| `conflict` (13)     | `conflict`          | canonical |
| `slug_reserved` (6) | **`slug_reserved`** | promote   |
| `api_key_limit` (2) | **`api_key_limit`** | promote   |

### type `rate_limited` → 429 (subclass `RateLimitedError`)

| flat code (uses)     | → wire code          | note                   |
| -------------------- | -------------------- | ---------------------- |
| `rate_limited` (2)   | `rate_limited`       | canonical              |
| `limit_exceeded` (2) | **`limit_exceeded`** | promote; 429 preserved |

### type `upstream` → 502 (subclass `UpstreamError`, `expose:false`)

| flat code (uses)            | → wire code             | note                                               |
| --------------------------- | ----------------------- | -------------------------------------------------- |
| `bad_gateway` (2)           | fold → `upstream_error` | 502                                                |
| `github_upstream_error` (2) | fold → `upstream_error` | `details:{upstream:"github"}`; dynamic 503→**502** |
| `feed_unavailable` (1)      | fold → `upstream_error` | 502 (sources.ts:2615)                              |

### type `unavailable` → 503 (subclass `ServiceUnavailableError`)

| flat code (uses)               | → wire code                  | note                         |
| ------------------------------ | ---------------------------- | ---------------------------- |
| `service_unavailable` (19)     | `service_unavailable`        | canonical                    |
| `embed_unavailable` (3)        | **`embed_unavailable`**      | promote                      |
| `unavailable` (2)              | fold → `service_unavailable` | synonym                      |
| `queue_unavailable` (2)        | fold → `service_unavailable` | `details:{resource:"queue"}` |
| `feedback_disabled` (1)        | fold → `service_unavailable` | feature-off (feedback.ts:53) |
| `recommendations_disabled` (1) | fold → `service_unavailable` | feature-off                  |
| `no_model` (1)                 | fold → `service_unavailable` | 503 (workflows.ts:2691)      |
| `spawn_failed` (1)             | fold → `service_unavailable` | 503                          |

### type `internal` → 500 (subclass `InternalError`, `expose:false`)

| flat code (uses)                     | → wire code             | note                            |
| ------------------------------------ | ----------------------- | ------------------------------- |
| `internal_error` (9)                 | `internal_error`        | canonical                       |
| `db_too_many_variables` (classifier) | `db_too_many_variables` | canonical; **normalize casing** |
| `insert_failed` (4)                  | fold → `internal_error` | DB write failure                |
| `update_failed` (1)                  | fold → `internal_error` | DB write failure                |
| `api_key_unbound` (1)                | fold → `internal_error` | misconfig 500                   |
| `webhook_secret_unbound` (1)         | fold → `internal_error` | misconfig 500                   |

## Net registry: 14 → 23

Existing 14 + `instance_not_found`, `client_not_found`, `user_not_found`, `snapshot_expired`,
`slug_reserved`, `api_key_limit`, `limit_exceeded`, `embed_unavailable`, `payload_too_large`.

## Discovery worker (`workers/discovery/src/index.ts`)

`errorResponse(msg, status)` produces `{ error: "<human string>" }`. Migrate to the nested
envelope. Sites: Unauthorized(401), ANTHROPIC_API_KEY not configured(500), `${label}: ${msg}`(500),
kill-switch disabled(503), Invalid JSON body(400), Missing required field: company(400),
validationError(400), Not found(404), and the two `{ error:` at index.ts:80/102. Reuse the
zod-free `core` taxonomy + build the envelope inline (discovery has no Hono `respondError`; it
returns raw `Response` — emit `{ error: { code, type, message } }` JSON literal, or a tiny local
`errorResponse` rewrite that takes `(code, type, message, status)`).
