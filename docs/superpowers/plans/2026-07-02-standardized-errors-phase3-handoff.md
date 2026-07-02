# Standardized Errors — Phase 3 Handoff / Kickoff

> **Status:** kickoff/scoping note, NOT yet a task-by-task plan. Phase 3 has a
> real design step (mapping ~56 flat error strings to `{ code, type }`) that must
> happen first. **Start by producing the code-mapping table below, then run
> `superpowers:writing-plans` to turn this into the executable plan**, then
> `superpowers:subagent-driven-development` to execute it.

**Epic:** replace the ~6 coexisting error conventions with one nested envelope
`{ error: { code, type, message, details? } }`. Phase 1 (#1824) and Phase 2
(#1826) are merged. Spec: `docs/superpowers/specs/2026-07-02-standardized-errors-design.md`.

## Where things stand (after Phase 2)

The API is in an **intentional mixed shape** (design option a):

- **Boundary paths emit the nested envelope**: `app.onError` / `app.notFound` /
  `HTTPException` / `BareSlugRejected` / `validateJson` all route through
  `respondError` (`workers/api/src/lib/error-response.ts`).
- **Inline producers are still FLAT**: the many `c.json({ error: "...", message: "..." }, code)`
  call sites in route handlers emit `{ error: "<string>", message }`. Phase 3
  migrates these.

The building blocks Phase 3 consumes already ship on `main`:

- `packages/core/src/errors.ts` — `ERROR_TYPES` (10), `STATUS_BY_TYPE`,
  `statusForType`, `statusToType`/`TYPE_BY_STATUS`, `ERROR_CODES` (14 today),
  `ErrorCode`. Zod-free.
- `packages/api-types/src/schemas/errors.ts` — `errorEnvelopeSchema`,
  `decodeApiError`, `isApiError`. The **`@deprecated` `ErrorResponseSchema`** flat
  alias lives in `packages/api-types/src/schemas/shared.ts` (re-exported from
  `api-types.ts`).
- `packages/lib/src/releases-error.ts` — `ReleasesError` base + 10 subclasses
  (`ValidationError`, `NotFoundError`, `ConflictError`, `RateLimitedError`,
  `UpstreamError`, `UnavailableError`, `InternalError`, …), each with
  `toWire(): ErrorEnvelope`. `expose` gates whether the real message reaches the
  client (`InternalError`/`UpstreamError` force `expose:false`).

## Scope of Phase 3

1. **Migrate the inline producers** in `workers/api/src/routes/**` to the typed
   hierarchy — either `throw new SomeError(...)` (let `respondError` serialize) or
   `return c.json(new SomeError(...).toWire(), status)`.
2. **Migrate the discovery worker** (`workers/discovery/src/**`) — its
   `{ error: <human string> }` producers (index.ts, scrape-fetch.ts,
   managed-agents-session.ts, extract-deps-worker.ts).
3. **Retire `ErrorResponseSchema`** — it is the OpenAPI response schema in ~16
   route files (see below), plus the api-types definition + barrel export. Replace
   those response declarations with the nested error schema, then delete the alias.
4. **Normalize the `db_too_many_variables` vs `DB_TOO_MANY_VARIABLES` casing**
   carry-over.
5. **Optional**: resolve the off-map-4xx `type`/`status` disagreement — a 422
   `HTTPException` resolves `type` via `statusToType`→`internal` while keeping
   status 422 (`respondError`, and pinned by a test in
   `workers/api/src/lib/error-response.test.ts`). Decide whether to map 422 or
   leave it documented.

## Inventory (measured on `main` @ a8623fc)

- **Route producers:** ~499 `error: "<code>"` string sites across **60 files** in
  `workers/api/src/routes/` (340 of them the single-line `c.json({ error: "…" })`
  shape; the rest multi-line or OpenAPI-schema references).
- **56 distinct flat code strings.** Current `ERROR_CODES` registry has 14 — so
  ~42 strings need a decision: promote to a canonical `ERROR_CODES` entry (the
  wire is open, so new codes are cheap) or fold into a generic code + `details`.
- **Top codes by frequency:** `bad_request` (169), `not_found` (146),
  `unauthorized` (27), `invalid_json` (20), `service_unavailable` (19),
  `conflict` (13), `internal_error` (9), `bare_slug_rejected` (8). Long domain
  tail: `instance_not_found` (7), `slug_reserved` (6), `payload_too_large` (5),
  `insert_failed` (4), `client_not_found` (4), `invalid_type`/`invalid_param` (3),
  `embed_unavailable` (3), `queue_unavailable`/`limit_exceeded`/`invalid_status`/
  `missing_required_fields`/`nothing_to_update`/`user_not_found` (2 each), …
- **`ErrorResponseSchema` OpenAPI refs (retirement surface):** `summaries`,
  `whats-changed`, `ignore`, `overview`, `overview-inputs`, `lookups`, `playbook`,
  `search`, `taxonomy`, `sources`, `releases`, `collections`, `products`,
  `changelog`, `orgs`, `related` — plus `packages/api-types/src/{api-types,schemas/shared}.ts`.

Regenerate any of these before planning:

```bash
grep -rhoE 'error: "[a-z_]+"' workers/api/src/routes | sort | uniq -c | sort -rn   # code frequency
grep -rc 'c.json({ error: "' workers/api/src/routes                                 # producer count/file
grep -rln "ErrorResponseSchema" packages/api-types/src workers/api/src | grep -v test
```

## The design step (do this before writing-plans)

Build a **code-mapping table**: every one of the 56 distinct strings → the
`{ code, type }` it becomes. For each, decide:

- **Already a canonical code** (`bad_request`→ keep? or split into
  `validation_failed` vs a real business `bad_request`), `not_found`,
  `unauthorized`, `conflict`, `rate_limited`, `service_unavailable`,
  `internal_error`, `invalid_json`, `bare_slug_rejected` → map to the existing
  `ERROR_CODES` entry + its `type`.
- **New domain code** (`slug_reserved`, `instance_not_found`, `payload_too_large`,
  `client_not_found`, `embed_unavailable`, …) → add to `ERROR_CODES` (mapping to
  an existing `type`, e.g. `slug_reserved`→`conflict`, `payload_too_large`→
  `validation`, `client_not_found`→`not_found`), or fold into the generic code
  with a `details` discriminator. Prefer explicit codes where a client would
  branch on them.

This table is the actual judgment work and the thing a fresh implementer needs.
`bad_request` (169 uses) especially needs a decision — much of it is
schema-ish validation that could become `validation_failed`, but some is genuine
business rejection; don't blanket-rename.

## Suggested execution shape

Large, mechanical-but-judgment-laden sweep → **subagent-driven or a workflow,
chunked one route file per task**. Per task:

1. Migrate that file's producers to `throw`/`toWire()` per the mapping table.
2. Flip that file's flat-asserting tests to the nested shape **in the same commit**.
3. Keep `respondError`'s invariants (5xx fails closed; header passthrough).

Retire `ErrorResponseSchema` only in the **final** task, once
`grep -rc 'c.json({ error: "' workers/api/src/routes` reaches zero.

## Gotchas carried over from Phase 2 (read before starting)

- **The test gap that broke Phase 2 CI:** the error-body consumer tests live in
  the **top-level `tests/`** dir (`tests/unit/phase2-*-validators.test.ts`,
  `tests/api/overview-validator.test.ts`, `tests/api/source-kind-write.test.ts`,
  `tests/unit/summaries-route.test.ts`) — **`bun test workers/api` does NOT cover
  them.** Always validate with the full **`bun run test`**.
- **Handler-inline producers are the migration targets.** In those validator
  files, `validateJson` schema failures already went nested (`validation_failed`),
  but **route-handler business-rule rejections that run AFTER validateJson passed
  stayed FLAT** — titles with `(handler …)`, the errata `org_`-prefix check, the
  PATCH-source invalid-kind check, the overview `bad_citations` cross-check. Those
  are exactly what Phase 3 migrates; their tests still assert
  `{ error: "bad_request"|"bad_citations" }`.
- **`respondError` fails closed on 5xx** (exposes the message only when
  `status < 500`). Preserve this when producers move to `throw`.
- **MCP must stay untouched.** `workers/mcp` zod is pinned to the MCP SDK's nested
  copy — share only the zod-free core taxonomy, never the api-types schema. Verify
  with the CI-faithful `cd workers/mcp && bun install --frozen-lockfile && npx tsc --noEmit`
  (a root-only worktree install falsely reports ~65 dual-zod errors).
- **Lint/format scope:** oxlint ignores `tests/**`; root tsc only checks `src/`.
  Neither catches test-file breakage — the tests do.
- **Adding an `ERROR_CODES` entry** is a `packages/core` change consumed by
  api-types + lib + mcp; keep it zod-free and re-run the round-trip + decode tests.

## Definition of done

- `grep -rc 'c.json({ error: "' workers/api/src/routes` → 0; discovery worker
  producers migrated.
- `ErrorResponseSchema` deleted; OpenAPI responses use the nested error schema;
  the OpenAPI coverage gate passes.
- `db_too_many_variables` casing normalized.
- Full `bun run test` green; `bun run check` clean; MCP tsc 0 (CI-faithful).
- Additive contract for consumers unchanged until **Phase 4** (web `web/src/lib/api.ts`
  - the out-of-tree CLI adopt `decodeApiError`; the interim mixed-shape window
    ends there).

## Reference

- Spec: `docs/superpowers/specs/2026-07-02-standardized-errors-design.md`
- Phase 2 plan (patterns + the full-suite Task 6 gate): `docs/superpowers/plans/2026-07-02-standardized-errors-phase2.md`
- Memory: `project_standardized_errors_epic`
