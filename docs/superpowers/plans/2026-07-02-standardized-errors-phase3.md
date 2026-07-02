# Standardized Errors — Phase 3 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Migrate every inline flat error producer (`c.json({ error: "…" }, status)`) in the API + discovery workers to the standardized nested envelope, then retire the deprecated `ErrorResponseSchema` alias.

**Architecture:** Producers stop hand-building `{ error, message }`. They construct a typed `ReleasesError` subclass (from `@releases/lib/releases-error`) whose `type` derives the HTTP status, and return it through the existing `respondError(c, err)` helper (catch-proof) or `throw` it (caught by `app.onError`). The wire `code` is chosen from the code-mapping table. `ErrorResponseSchema` OpenAPI refs are replaced with the nested `errorEnvelopeSchema`, then the alias is deleted.

**Tech Stack:** Bun, TypeScript (strict), Hono, Cloudflare Workers, Drizzle/D1, zod (api-types only), `bun test`.

## Global Constraints

- **Companion mapping table (authoritative):** `docs/superpowers/plans/2026-07-02-standardized-errors-phase3-code-mapping.md`. Every producer's `{ code, type }` decision comes from it. Do not invent codes not in that table.
- **HTTP status is preserved at every migrated site.** After migration, the response status MUST equal the pre-migration literal, except the two documented normalizations: `payload_too_large` 413→400, `snapshot_expired` 410→404, and `github_upstream_error` dynamic-503→502. If a chosen subclass's derived status ≠ the original literal, you picked the wrong `type` — recheck the table.
- **Do NOT touch `workers/mcp`.** Its zod is pinned to the MCP SDK's nested copy. Share only the zod-free `core` taxonomy. Never import `errorEnvelopeSchema`/api-types zod into MCP.
- **Validate with the full `bun run test`**, never just `bun test workers/api` — the error-body consumer tests live in the top-level `tests/` dir which `bun test workers/api` does NOT cover.
- **`respondError` invariants must survive:** 5xx fails closed (`expose` only when status < 500); `HTTPException` header passthrough (Retry-After/Set-Cookie).
- **Adding an `ERROR_CODES` entry is a `packages/core` change** consumed by api-types + lib + mcp; keep `core` zod-free.
- Commit per task. Never push to `main`. Branch: `worktree-standardized-errors-phase3`.

---

## Migration recipe (every sweep task applies this — read once)

For each `c.json({ error: "<flat>", message: "<M>", ...extra }, <S>)` site in a route file:

1. **Look up `<flat>` in the mapping table** → `(wireCode, type)`. Pick the subclass for `type`:
   `validation`→`ValidationError`, `unauthorized`→`UnauthorizedError`, `forbidden`→`ForbiddenError`,
   `insufficient_scope`→`InsufficientScopeError`, `not_found`→`NotFoundError`, `conflict`→`ConflictError`,
   `rate_limited`→`RateLimitedError`, `upstream`→`UpstreamError`, `unavailable`→`ServiceUnavailableError`,
   `internal`→`InternalError`.
2. **Rewrite** to the catch-proof form (DEFAULT):

   ```ts
   return respondError(c, new ValidationError("<M>", { code: "<wireCode>" }));
   ```

   - When `wireCode` equals the subclass default code (e.g. `not_found`→`NotFoundError`, `conflict`→`ConflictError`), you may omit `code`.
   - Move any `...extra` keys (`entity`, `setup`, `errorCode`, ids) into `details: { ... }`.
   - Where the table says add `details` (e.g. `github_upstream_error`→`{ upstream: "github" }`), include it.

3. **`throw` instead of `return respondError`** ONLY when the site is at the top of a handler with no
   enclosing `try/catch` that would swallow it. If in doubt, use `return respondError(...)` — it is always safe.
   ⚠️ **Hazard:** a bare `throw new XError()` inside a `try { … } catch (e) { return c.json({error:"internal_error"}, 500) }`
   gets swallowed and 500s. Check the enclosing scope; prefer `return respondError(...)`.
4. **`expose` note:** `UpstreamError`/`InternalError` force `expose:false`, so their human message is replaced by
   the generic message on the wire. That is intended (never leak upstream/internal detail). Put any discriminator
   the client still needs in `details`.
5. **Imports:** add `respondError` from `../lib/error-response` and the needed subclasses from
   `@releases/lib/releases-error` (or `@releases/lib`). Remove now-unused imports.
6. **Flip that file's tests in the SAME commit.** Any test asserting the flat shape
   (`body.error === "x"`, `json.error === "x"`, `.message`) becomes:

   ```ts
   expect(body.error.code).toBe("<wireCode>");
   expect(body.error.type).toBe("<type>");
   expect(res.status).toBe(<S>);
   ```

   Route tests may live in `workers/api/**/*.test.ts` OR top-level `tests/**`. Grep both:
   `grep -rn '<flat-or-messageword>' workers/api tests | grep -i test`.

**Per-file done check:** `grep -c 'c.json({ error: "' workers/api/src/routes/<file>` → 0, and the file's
tests pass under `bun run test`.

---

## Task 1: Foundation — registry + subclasses + D1 casing

**Files:**

- Modify: `packages/core/src/errors.ts` (add 9 codes to `ERROR_CODES`)
- Modify: `packages/lib/src/db-errors.ts` (normalize `DB_TOO_MANY_VARIABLES` → `db_too_many_variables`)
- Modify: `workers/api/src/lib/error-response.ts` (drop the casing special-case)
- Test: `packages/core/src/errors.test.ts`, `packages/lib/src/releases-error.test.ts` (or existing sibling test files), `workers/api/src/lib/error-response.test.ts`

**Interfaces:**

- Produces: `ERROR_CODES` gains `instance_not_found`, `client_not_found`, `user_not_found`, `snapshot_expired`, `slug_reserved`, `api_key_limit`, `limit_exceeded`, `embed_unavailable`, `payload_too_large`. Every sweep task constructs errors with these + the existing 14 via `new <Subclass>(msg, { code })`.

- [ ] **Step 1: Write the failing test** — assert the 9 new codes are valid `ErrorCode`s and each pairs with the right status via its subclass.

  In `packages/lib/src/releases-error.test.ts` (append):

  ```ts
  import { describe, it, expect } from "bun:test";
  import {
    NotFoundError,
    ConflictError,
    RateLimitedError,
    ServiceUnavailableError,
    ValidationError,
  } from "./releases-error";

  describe("Phase 3 promoted codes", () => {
    it("maps promoted codes to the preserved status", () => {
      expect(new NotFoundError("x", { code: "instance_not_found" }).status).toBe(404);
      expect(new NotFoundError("x", { code: "snapshot_expired" }).status).toBe(404);
      expect(new ConflictError("x", { code: "slug_reserved" }).status).toBe(409);
      expect(new ConflictError("x", { code: "api_key_limit" }).status).toBe(409);
      expect(new RateLimitedError("x", { code: "limit_exceeded" }).status).toBe(429);
      expect(new ServiceUnavailableError("x", { code: "embed_unavailable" }).status).toBe(503);
      expect(new ValidationError("x", { code: "payload_too_large" }).status).toBe(400);
      expect(new NotFoundError("x", { code: "client_not_found" }).toWire().error.code).toBe(
        "client_not_found",
      );
      expect(new NotFoundError("x", { code: "user_not_found" }).toWire().error.code).toBe(
        "user_not_found",
      );
    });
  });
  ```

- [ ] **Step 2: Run to verify it fails**

  Run: `cd packages/lib && bun test releases-error.test.ts`
  Expected: FAIL — TS error, `code` not assignable (codes not yet in registry).

- [ ] **Step 3: Add the codes** — in `packages/core/src/errors.ts`, extend `ERROR_CODES` (keep existing 14, append):

  ```ts
  export const ERROR_CODES = [
    "validation_failed",
    "bad_request",
    "invalid_json",
    "unauthorized",
    "forbidden",
    "insufficient_scope",
    "not_found",
    "bare_slug_rejected",
    "conflict",
    "rate_limited",
    "upstream_error",
    "service_unavailable",
    "internal_error",
    "db_too_many_variables",
    // Phase 3 promotions (see code-mapping table):
    "instance_not_found",
    "client_not_found",
    "user_not_found",
    "snapshot_expired",
    "slug_reserved",
    "api_key_limit",
    "limit_exceeded",
    "embed_unavailable",
    "payload_too_large",
  ] as const;
  ```

- [ ] **Step 4: Normalize the D1 casing** — in `packages/lib/src/db-errors.ts`, change the emitted code constant from `DB_TOO_MANY_VARIABLES` to `db_too_many_variables` (grep the file; update the `code` value and any internal comparisons). Then in `workers/api/src/lib/error-response.ts` replace:

  ```ts
  code: db.code === "DB_TOO_MANY_VARIABLES" ? "db_too_many_variables" : "internal_error",
  ```

  with:

  ```ts
  code: db.code === "db_too_many_variables" ? "db_too_many_variables" : "internal_error",
  ```

  (Adjust to whatever the classifier now returns — the goal is one snake_case code, no dual casing. If `classifyDbError` returns a structured `{ code }`, make that `code` already be `db_too_many_variables` and simplify the ternary to pass it through when it's a registry member.)

- [ ] **Step 5: Update any db-errors test** asserting the old casing (`grep -rn DB_TOO_MANY_VARIABLES packages workers`) to the new value.

- [ ] **Step 6: Run to verify passing**

  Run: `bun run test` (full suite) and `bun run check`
  Expected: PASS; lint/format/type clean. Also: `cd workers/mcp && bun install --frozen-lockfile && npx tsc --noEmit` → 0 errors (CI-faithful — a root-only worktree install falsely reports ~65 dual-zod errors).

- [ ] **Step 7: Commit**

  ```bash
  git add packages/core/src/errors.ts packages/lib/src/db-errors.ts workers/api/src/lib/error-response.ts packages/lib/src/releases-error.test.ts
  git commit -m "refactor(errors): Phase 3 foundation — promote 9 codes, normalize D1 casing"
  ```

---

## Task 2: Template migration — `overview.ts` (worked example)

Migrate one small, representative route file end-to-end to lock the recipe, including the Phase-2-noted
`bad_citations` handler business rule. Later sweep tasks copy this shape.

**Files:**

- Modify: `workers/api/src/routes/overview.ts`
- Test: the overview validator tests (`tests/api/overview-validator.test.ts` and any `workers/api` sibling) — flip to nested.

- [ ] **Step 1:** Grep the file's producers and their tests:

  ```bash
  grep -n 'c.json({ error: "' workers/api/src/routes/overview.ts
  grep -rn 'bad_citations\|error: "bad_request"' tests workers/api | grep -i test
  ```

- [ ] **Step 2: Flip the tests first (TDD).** In the overview test(s), change flat assertions to nested. Example for the `bad_citations` cross-check:

  ```ts
  // was: expect(body.error).toBe("bad_citations")
  expect(body.error.code).toBe("bad_request");
  expect(body.error.type).toBe("validation");
  expect(res.status).toBe(400);
  ```

- [ ] **Step 3: Run to verify they fail**

  Run: `bun run test tests/api/overview-validator.test.ts`
  Expected: FAIL (route still emits flat shape).

- [ ] **Step 4: Migrate the producers** per the recipe. `bad_citations` (1, validation) folds to `bad_request`, message preserved:

  ```ts
  return respondError(
    c,
    new ValidationError("<original bad_citations message>", { code: "bad_request" }),
  );
  ```

  Apply the recipe to every other producer in the file (use the mapping table for each code). Add imports; remove dead ones.

- [ ] **Step 5: Run to verify passing + per-file done check**

  Run: `bun run test tests/api/overview-validator.test.ts` → PASS.
  Run: `grep -c 'c.json({ error: "' workers/api/src/routes/overview.ts` → `0`.

- [ ] **Step 6: Commit**

  ```bash
  git add workers/api/src/routes/overview.ts tests/api/overview-validator.test.ts
  git commit -m "refactor(errors): migrate overview route producers to nested envelope"
  ```

---

## Tasks 3–N: Route-file sweep (one task per file)

Apply the **Migration recipe** to each remaining route file. Each file is an independent task —
migrate producers + flip that file's tests + per-file done check + commit. Dispatch order is by
descending producer count so the big files land early. Run these as parallel subagents/a workflow;
each is isolated to one route file so they don't conflict.

**Files (producer counts from `grep -c 'c.json({ error: "' workers/api/src/routes/*`):** regenerate the
exact per-file list at execution time with:

```bash
grep -rc 'c.json({ error: "' workers/api/src/routes | grep -v ':0$' | sort -t: -k2 -rn
```

For each file `F` in that list (excluding `overview.ts`, done in Task 2):

- [ ] **Step 1:** `grep -n 'c.json({ error: "' workers/api/src/routes/F` — enumerate producers.
- [ ] **Step 2:** Find F's tests: `grep -rln "routes/F\|<F-route-path>" workers/api tests | grep -i test`. Flip flat→nested assertions there.
- [ ] **Step 3:** Run those tests → FAIL.
- [ ] **Step 4:** Migrate every producer in F per the recipe + mapping table. Watch the try/catch-swallow hazard; watch status preservation (esp. the 413/410/dynamic-503 normalizations if F is `feedback.ts`, `recommendations.ts`, `workflows.ts`, `sources.ts`, `changelog.ts`).
- [ ] **Step 5:** `grep -c 'c.json({ error: "' workers/api/src/routes/F` → 0; run F's tests → PASS.
- [ ] **Step 6:** Commit `refactor(errors): migrate <F> route producers to nested envelope`.

**Special-status files to review carefully (normalizations documented in the mapping table):**

- `feedback.ts`, `recommendations.ts` — `payload_too_large` 413→400 (`ValidationError`, code `payload_too_large`).
- `workflows.ts` — `snapshot_expired` 410→404 (`NotFoundError`, code `snapshot_expired`); `bad_gateway` 502; `no_model`/`misconfigured`/`embed_unavailable` 503/400.
- `changelog.ts` — `github_upstream_error` dynamic 503→**502** (`UpstreamError`, `details:{upstream:"github"}`).
- `sources.ts` — `feed_unavailable` 502 (`UpstreamError`), `slug_reserved` 409, `insert_failed` 500.
- `me-webhooks.ts` — `limit_exceeded` 429 (`RateLimitedError`, code `limit_exceeded`).
- `user-api-keys.ts` — `api_key_limit` 409 (`ConflictError`, code `api_key_limit`).

---

## Task N+1: Discovery worker

**Files:**

- Modify: `workers/discovery/src/index.ts` (and any of `scrape-fetch.ts`, `managed-agents-session.ts`, `extract-deps-worker.ts` that produce `{ error }` — grep to confirm)
- Test: `grep -rln errorResponse workers/discovery | grep -i test` — flip if present.

- [ ] **Step 1:** `grep -n 'errorResponse(\|{ error:' workers/discovery/src`.
- [ ] **Step 2:** Rewrite the local `errorResponse(message, status)` helper (index.ts:97) to emit the nested envelope. Since discovery returns a raw `Response` (no Hono `respondError`) and must NOT import api-types zod, build the envelope from the zod-free `core` taxonomy:

  ```ts
  import { statusToType, type ErrorCode } from "@buildinternet/releases-core/errors";

  function errorResponse(code: ErrorCode, message: string, status: number): Response {
    const type = statusToType(status);
    return new Response(JSON.stringify({ error: { code, type, message } }), {
      status,
      headers: { "content-type": "application/json" },
    });
  }
  ```

  Update each call site to pass `(code, message, status)`: Unauthorized→`("unauthorized","Unauthorized",401)`;
  ANTHROPIC_API_KEY→`("internal_error","…",500)` (consider `expose` — this is an internal misconfig, but discovery
  has no `expose` machinery; keep the message as-is, it's operator-facing); kill-switch→`("service_unavailable",…,503)`;
  Invalid JSON body→`("invalid_json",…,400)`; Missing field: company→`("bad_request",…,400)`;
  validationError→`("bad_request", validationError, 400)`; Not found→`("not_found","Not found",404)`. Handle the
  two `{ error:` literals at index.ts:80/102 the same way.

- [ ] **Step 3:** Run `bun run test` (covers `workers/discovery`) → PASS; flip any discovery test asserting `{ error: "<string>" }`.
- [ ] **Step 4:** Commit `refactor(errors): migrate discovery worker to nested envelope`.

---

## Task N+2: Retire `ErrorResponseSchema` (FINAL — gated)

Only start when `grep -rc 'c.json({ error: "' workers/api/src/routes | grep -v ':0$'` is empty.

**Files:**

- Modify (replace `ErrorResponseSchema` OpenAPI refs with the nested error schema): the ~16 route files listed in the handoff — `summaries`, `whats-changed`, `ignore`, `overview`, `overview-inputs`, `lookups`, `playbook`, `search`, `taxonomy`, `sources`, `releases`, `collections`, `products`, `changelog`, `orgs`, `related` (regenerate: `grep -rln ErrorResponseSchema workers/api/src | grep -v test`).
- Modify: `packages/api-types/src/schemas/shared.ts` (delete the `@deprecated` alias), `packages/api-types/src/api-types.ts` (remove the barrel re-export), any `errors.ts` export.
- Test: OpenAPI coverage gate + api-types tests.

- [ ] **Step 1:** `grep -rln ErrorResponseSchema packages/api-types/src workers/api/src | grep -v test` — the retirement surface.
- [ ] **Step 2:** In each route file, replace the `ErrorResponseSchema` response declaration with the nested error schema (the api-types `errorEnvelopeSchema` / its OpenAPI `$ref` — match how existing nested-error responses are declared; if none exist yet, reference `errorEnvelopeSchema.meta({ id })`).
- [ ] **Step 3:** Delete the `@deprecated ErrorResponseSchema` from `schemas/shared.ts` and its re-export from `api-types.ts`.
- [ ] **Step 4:** `grep -rn ErrorResponseSchema packages workers | grep -v test` → 0.
- [ ] **Step 5:** Run `bun run test` + `bun run check` + the OpenAPI coverage gate; `cd workers/mcp && bun install --frozen-lockfile && npx tsc --noEmit` → 0.
- [ ] **Step 6:** Commit `refactor(errors): retire ErrorResponseSchema, OpenAPI responses use nested envelope`.

---

## Task N+3: Final full-suite gate + optional 422

- [ ] **Step 1:** Definition-of-done greps all zero:
  - `grep -rc 'c.json({ error: "' workers/api/src/routes | grep -v ':0$'` → empty
  - `grep -rn ErrorResponseSchema packages workers | grep -v test` → empty
  - `grep -rn DB_TOO_MANY_VARIABLES packages workers` → empty
- [ ] **Step 2:** `bun run test` green; `bun run check` clean; MCP tsc 0 (CI-faithful).
- [ ] **Step 3 (optional, handoff item #5):** Decide the 422 off-map `HTTPException` case in `respondError` — leave documented (no 422 producers exist in routes per the status sweep) or add a 422→validation shim. **Recommendation: leave as-is, documented** — there are zero 422 producers, so it's dead surface; a comment in `error-response.ts` noting 422→`internal` via `statusToType` is enough.
- [ ] **Step 4:** Open the PR (draft): `gh pr create --draft` with the summary + the mapping-table link.

## Self-review notes

- **Spec coverage:** handoff items 1 (route producers → Tasks 2,3–N), 2 (discovery → N+1), 3 (`ErrorResponseSchema` → N+2), 4 (D1 casing → Task 1), 5 (422 → N+3 optional) all mapped.
- **Status preservation** is the top correctness risk — enforced by the recipe's subclass-status check and the special-status file list.
- **Test-location gap** (top-level `tests/`) is called out in Global Constraints and every sweep task's Step 2.
