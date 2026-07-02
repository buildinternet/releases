# Standardized Errors — Phase 2 (API boundary) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the API worker's boundary emit the one nested error envelope for every failure it handles — unexpected throws, `notFound`, `HTTPException`, `BareSlugRejected`, and JSON-validation failures — and attach the D1 diagnostic on every route, without touching the ~486 inline producer call sites.

**Architecture:** A single `respondError(c, err)` serializer in `workers/api` owns the produce-the-envelope cascade (typed `ReleasesError` → `toWire`; `BareSlugRejected`/`HTTPException` mapped; classified D1 failure → `InternalError` carrying the code in `details`; anything else → generic `InternalError` + `logEvent`). `app.onError` and `app.notFound` delegate to it; `validateJson` emits the same envelope for schema failures. The throwable hierarchy, wire schema, and taxonomy already shipped in Phase 1 (on `main`).

**Tech Stack:** Bun, TypeScript (strict), Hono + `hono-openapi`, `bun:test`. Phase 1 packages: `@buildinternet/releases-core/errors`, `@buildinternet/releases-api-types`, `@releases/lib/releases-error`.

Full design context: `docs/superpowers/specs/2026-07-02-standardized-errors-design.md` (Phase 2 section).

## Global Constraints

- **Interim mixed shape is intentional (design option a).** Phase 2 changes ONLY the boundary paths (`onError`, `notFound`, `HTTPException`, `BareSlugRejected`, `validateJson`). The ~486 inline `c.json({ error: "..." }, code)` producers stay flat until Phase 3. Do NOT migrate inline producers in this phase. Tests asserting inline-producer error bodies must be left asserting the flat shape.
- **Nested envelope shape** (from Phase 1): `{ error: { code, type, message, details? } }`. `code` is snake_case; `type` is one of the 10 `ERROR_TYPES`; HTTP status derives from `type` via `statusForType`, except `HTTPException` preserves its own status.
- **`packages/core` stays zod-free.** The `statusToType` addition is pure data + a lookup.
- **Dependency direction stays `workers/api → lib → api-types → core`.** `respondError` lives in `workers/api` (it needs Hono + `classifyDbError` + the hierarchy); it must NOT live in `lib` (no Hono there) or `api-types`.
- **`expose: false` on `InternalError`/`UpstreamError` must be non-overridable** (Task 1) — a caller passing `{ expose: true }` must not be able to leak a raw internal/upstream message.
- **Do NOT wire `classifyAnthropicError` into `onError`** — it has no HTTP call sites today and its `"other"` fallback would mislabel every unhandled 500 as `upstream`. Deferred (see Out of scope).
- **Do NOT change MCP** in this phase (deferred, see Out of scope).
- **Header passthrough on `HTTPException` must be preserved** — non-`content-type`/`content-length` headers from `err.res` are `append`ed post-construction so multi-value headers (`Set-Cookie`) survive. This matches the current handler (`workers/api/src/index.ts:481-497`).
- **`workers/mcp` must still type-check** — verify with `cd workers/mcp && bun install --frozen-lockfile && npx tsc --noEmit` (a root-only worktree install falsely reports dual-zod errors; install mcp as its own workspace, as CI does).
- **Tests:** `bun:test`. Root runs `workers/api` in its own process: `bun test workers/api` (after `bun test packages/` and the other segments). Run a single file with `bun test <path>`.
- **Verify command:** `bun run check` (= `oxlint` + `oxfmt --check`).
- **Commit style:** end commit messages with `Claude-Session: https://claude.ai/code/session_015vCgYf4wCXnyr7MQrQ1xCY`. Avoid "comprehensive"/"world-class".

## File Structure

- `packages/lib/src/releases-error.ts` — **modify.** Pin `expose: false` on `InternalError`/`UpstreamError` (spread `opts` before the forced flag). (+ test)
- `packages/core/src/errors.ts` — **modify.** Add `TYPE_BY_STATUS` + `statusToType(status)`. (+ test)
- `workers/api/src/lib/error-response.ts` — **new.** `respondError(c, err)` — the boundary serializer. (+ test)
- `workers/api/src/index.ts` — **modify.** `app.onError` and `app.notFound` delegate to `respondError` / `NotFoundError`.
- `workers/api/src/lib/validate.ts` — **modify.** `validateJson` hook emits a `ValidationError` envelope.
- Boundary tests to update (nested shape): `workers/api/test/on-error-sanitization.test.ts`, `workers/api/src/lib/json-body.test.ts`, `workers/api/test/workflows-json-body.test.ts`, `workers/api/test/org-scoped-routes.test.ts` (only its `onError`/`bad_request` boundary assertions), and any `validateJson` schema-failure assertions.

---

## Task 1: Pin `expose: false` on InternalError / UpstreamError

**Files:**

- Modify: `packages/lib/src/releases-error.ts` (the `UpstreamError` and `InternalError` constructors)
- Test: `packages/lib/src/releases-error.test.ts`

**Interfaces:**

- Consumes: existing `ReleasesError`, `ReleasesErrorOptions` (Phase 1).
- Produces: no signature change — `new InternalError("x", { expose: true })` still compiles, but `.expose` is `false` and `toWire().error.message` is the generic message.

- [ ] **Step 1: Write the failing test**

Append to `packages/lib/src/releases-error.test.ts`:

```ts
import { UpstreamError } from "./releases-error";

test("InternalError/UpstreamError ignore an expose:true override (no raw-message leak)", () => {
  const internal = new InternalError("secret dsn postgres://u:p@h", { expose: true });
  expect(internal.expose).toBe(false);
  expect(internal.toWire().error.message).toBe("Internal server error");

  const upstream = new UpstreamError("anthropic key sk-ant-123 rejected", { expose: true });
  expect(upstream.expose).toBe(false);
  expect(upstream.toWire().error.message).toBe("Upstream service error");
});
```

(Add `UpstreamError` to the existing top-of-file import from `"./releases-error"` rather than a second import line if you prefer — either compiles.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/lib/src/releases-error.test.ts`
Expected: FAIL — `expect(internal.expose).toBe(false)` receives `true` (opts currently spread after the default).

- [ ] **Step 3: Fix the two constructors**

In `packages/lib/src/releases-error.ts`, change the `UpstreamError` and `InternalError` constructors so `expose: false` comes AFTER the `...opts` spread (making it non-overridable). Leave `code` overridable.

`UpstreamError`:

```ts
export class UpstreamError extends ReleasesError {
  constructor(message = "Upstream service error", opts: ReleasesErrorOptions = {}) {
    super("upstream", message, { code: "upstream_error", ...opts, expose: false });
  }
}
```

`InternalError`:

```ts
export class InternalError extends ReleasesError {
  constructor(message = "Internal server error", opts: ReleasesErrorOptions = {}) {
    super("internal", message, { code: "internal_error", ...opts, expose: false });
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/lib/src/releases-error.test.ts`
Expected: PASS (all prior tests + the new one).

- [ ] **Step 5: Commit**

```bash
git add packages/lib/src/releases-error.ts packages/lib/src/releases-error.test.ts
git commit -m "fix(errors): make expose:false non-overridable on Internal/UpstreamError

Claude-Session: https://claude.ai/code/session_015vCgYf4wCXnyr7MQrQ1xCY"
```

---

## Task 2: `statusToType` reverse map in core

**Files:**

- Modify: `packages/core/src/errors.ts`
- Test: `packages/core/src/errors.test.ts`

**Interfaces:**

- Consumes: existing `ErrorType`, `STATUS_BY_TYPE` (Phase 1).
- Produces:
  - `TYPE_BY_STATUS: Record<number, ErrorType>`
  - `statusToType(status: number): ErrorType` — reverse lookup, defaults to `"internal"` for unmapped statuses. Used by `respondError` to shape an `HTTPException` whose status may be off-map.
  - Import path: `@buildinternet/releases-core/errors`.

- [ ] **Step 1: Write the failing test**

Append to `packages/core/src/errors.test.ts`:

```ts
import { statusToType } from "./errors";

test("statusToType maps known statuses back to their primary type", () => {
  expect(statusToType(400)).toBe("validation");
  expect(statusToType(401)).toBe("unauthorized");
  expect(statusToType(403)).toBe("forbidden");
  expect(statusToType(404)).toBe("not_found");
  expect(statusToType(409)).toBe("conflict");
  expect(statusToType(429)).toBe("rate_limited");
  expect(statusToType(502)).toBe("upstream");
  expect(statusToType(503)).toBe("unavailable");
  expect(statusToType(500)).toBe("internal");
});

test("statusToType defaults an unmapped status to internal", () => {
  expect(statusToType(418)).toBe("internal");
  expect(statusToType(422)).toBe("internal");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/core/src/errors.test.ts`
Expected: FAIL — `statusToType` is not exported.

- [ ] **Step 3: Write the implementation**

Append to `packages/core/src/errors.ts` (after `statusForType`):

```ts
/**
 * Reverse of {@link STATUS_BY_TYPE}, choosing the primary type where a status is
 * shared (403 → `forbidden`, not `insufficient_scope`). Used to shape a Hono
 * `HTTPException` (whose status is preserved as-is) into an envelope `type`.
 */
export const TYPE_BY_STATUS: Record<number, ErrorType> = {
  400: "validation",
  401: "unauthorized",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  429: "rate_limited",
  502: "upstream",
  503: "unavailable",
  500: "internal",
};

export function statusToType(status: number): ErrorType {
  return TYPE_BY_STATUS[status] ?? "internal";
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/core/src/errors.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/errors.test.ts
git commit -m "feat(errors): add statusToType reverse map to core taxonomy

Claude-Session: https://claude.ai/code/session_015vCgYf4wCXnyr7MQrQ1xCY"
```

---

## Task 3: `respondError(c, err)` boundary serializer

**Files:**

- Create: `workers/api/src/lib/error-response.ts`
- Test: `workers/api/src/lib/error-response.test.ts`

**Interfaces:**

- Consumes: `statusToType` (Task 2); `isReleasesError`, `ReleasesError`, `ValidationError`, `InternalError` (Phase 1 + Task 1); `classifyDbError` (`@releases/lib/db-errors`); `logEvent` (`@releases/lib/log-event`); `BareSlugRejected` (`workers/api/src/utils.ts`); Hono `Context`, `HTTPException`.
- Produces: `respondError(c: Context, err: unknown): Response` — emits the nested envelope. Cascade order: typed `ReleasesError` → `BareSlugRejected` → `HTTPException` (status + headers preserved) → classified D1 error → generic `InternalError`. Consumed by Task 4 (`app.onError`).

- [ ] **Step 1: Write the failing test**

Create `workers/api/src/lib/error-response.test.ts`:

```ts
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { NotFoundError, ReleasesError } from "@releases/lib/releases-error";
import { BareSlugRejected } from "../utils";
import { respondError } from "./error-response";

function appThrowing(err: unknown) {
  const app = new Hono();
  app.get("/boom", () => {
    throw err;
  });
  app.onError((e, c) => respondError(c, e));
  return app;
}

test("a typed ReleasesError serializes to its envelope + derived status", async () => {
  const res = await appThrowing(new NotFoundError("Source not found")).request("/boom");
  expect(res.status).toBe(404);
  const body = (await res.json()) as { error: { code: string; type: string; message: string } };
  expect(body.error).toEqual({ code: "not_found", type: "not_found", message: "Source not found" });
});

test("BareSlugRejected becomes a validation envelope carrying the entity", async () => {
  const res = await appThrowing(new BareSlugRejected("source", "foo")).request("/boom");
  expect(res.status).toBe(400);
  const body = (await res.json()) as {
    error: { code: string; type: string; details: { entity: string } };
  };
  expect(body.error.code).toBe("bare_slug_rejected");
  expect(body.error.type).toBe("validation");
  expect(body.error.details).toEqual({ entity: "source" });
});

test("HTTPException preserves status + passthrough headers, envelope by status", async () => {
  const res = new Response("x", { status: 429, headers: { "Retry-After": "30" } });
  const out = await appThrowing(new HTTPException(429, { res })).request("/boom");
  expect(out.status).toBe(429);
  expect(out.headers.get("Retry-After")).toBe("30");
  const body = (await out.json()) as { error: { type: string; code: string } };
  expect(body.error.type).toBe("rate_limited");
});

test("a malformed-JSON HTTPException(400) uses the invalid_json code", async () => {
  const out = await appThrowing(new HTTPException(400, { message: "Malformed JSON" })).request(
    "/boom",
  );
  expect(out.status).toBe(400);
  const body = (await out.json()) as { error: { code: string; type: string } };
  expect(body.error.code).toBe("invalid_json");
  expect(body.error.type).toBe("validation");
});

test("an unexpected error is a generic 500 that never leaks its message", async () => {
  const out = await appThrowing(new Error("secret dsn postgres://u:p@h")).request("/boom");
  expect(out.status).toBe(500);
  const body = (await out.json()) as { error: { code: string; message: string } };
  expect(body.error.code).toBe("internal_error");
  expect(body.error.message).toBe("Internal server error");
  expect(JSON.stringify(body)).not.toContain("secret");
});

test("a base ReleasesError with an off-map status still responds with that status", async () => {
  // guards the c.json status typing for a variable numeric status
  const res = await appThrowing(new ReleasesError("conflict", "dupe")).request("/boom");
  expect(res.status).toBe(409);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test workers/api/src/lib/error-response.test.ts`
Expected: FAIL — `Cannot find module './error-response'`.

- [ ] **Step 3: Write the implementation**

Create `workers/api/src/lib/error-response.ts`:

```ts
import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { statusToType } from "@buildinternet/releases-core/errors";
import {
  isReleasesError,
  ReleasesError,
  ValidationError,
  InternalError,
} from "@releases/lib/releases-error";
import { classifyDbError } from "@releases/lib/db-errors";
import { logEvent } from "@releases/lib/log-event";
import { BareSlugRejected } from "../utils";

/**
 * The API's single error producer. Maps any thrown value to the standardized
 * nested envelope (`{ error: { code, type, message, details? } }`) and the right
 * HTTP status. Registered as `app.onError` (see index.ts). Cascade order matters:
 * typed domain errors first, then the two framework/legacy shapes, then a
 * classified D1 failure, then the generic fallback.
 */
export function respondError(c: Context, err: unknown): Response {
  // 1. Typed domain error — trust its code/type/status.
  if (isReleasesError(err)) {
    return c.json(err.toWire(), err.status as ContentfulStatusCode);
  }

  // 2. Legacy bare-slug rejection (thrown by the source/product resolvers).
  if (err instanceof BareSlugRejected) {
    const e = new ValidationError(err.message, {
      code: "bare_slug_rejected",
      details: { entity: err.entity },
    });
    return c.json(e.toWire(), e.status as ContentfulStatusCode);
  }

  // 3. Hono HTTPException — preserve its status and any attached headers
  //    (Retry-After, Set-Cookie, …); shape the envelope from the status.
  if (err instanceof HTTPException) {
    const type = statusToType(err.status);
    const wire = new ReleasesError(type, err.message, {
      code: err.status === 400 ? "invalid_json" : undefined,
      expose: true,
    }).toWire();
    const res = c.json(wire, err.status);
    if (err.res) {
      err.res.headers.forEach((value, key) => {
        const lower = key.toLowerCase();
        // c.json sets content-type/content-length itself.
        if (lower !== "content-type" && lower !== "content-length") {
          res.headers.append(key, value);
        }
      });
    }
    return res;
  }

  // 4. Classified D1 failure — attach the diagnostic (fixes the "only ~4 routes
  //    expose errorCode" gap: now every route surfaces it via the boundary).
  const db = classifyDbError(err);
  if (db) {
    logEvent("error", {
      component: "api",
      event: "db_error",
      causeCode: db.code,
      causeTransient: db.transient,
    });
    const e = new InternalError("Internal server error", {
      code: db.code === "DB_TOO_MANY_VARIABLES" ? "db_too_many_variables" : "internal_error",
      details: { dbCode: db.code, transient: db.transient },
    });
    return c.json(e.toWire(), e.status as ContentfulStatusCode);
  }

  // 5. Unexpected — generic 500, real message logged but never sent.
  const detail = err instanceof Error ? err.message : String(err);
  logEvent("error", { component: "api", event: "unhandled_error", error: detail });
  const e = new InternalError();
  return c.json(e.toWire(), e.status as ContentfulStatusCode);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test workers/api/src/lib/error-response.test.ts`
Expected: PASS (6 tests).

> If tsc/oxlint flags `c.json(wire, err.status)` (HTTPException's status is already a `ContentfulStatusCode`, so it should be fine), cast it `err.status as ContentfulStatusCode` to match the other branches.

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/lib/error-response.ts workers/api/src/lib/error-response.test.ts
git commit -m "feat(errors): respondError boundary serializer for the API worker

Maps typed errors, BareSlugRejected, HTTPException (status+headers preserved),
and classified D1 failures to the nested envelope; classifies D1 errors centrally
so the diagnostic reaches clients on every route.

Claude-Session: https://claude.ai/code/session_015vCgYf4wCXnyr7MQrQ1xCY"
```

---

## Task 4: Wire `app.onError` + `app.notFound`, migrate boundary tests

**Files:**

- Modify: `workers/api/src/index.ts` (`app.onError` at ~458-503, `app.notFound` at ~968-976)
- Modify (boundary tests → nested): `workers/api/test/on-error-sanitization.test.ts`, `workers/api/src/lib/json-body.test.ts`, `workers/api/test/workflows-json-body.test.ts`, `workers/api/test/org-scoped-routes.test.ts` (only its `onError`/`bad_request`/`bare_slug_rejected` boundary assertions)

**Interfaces:**

- Consumes: `respondError` (Task 3); `NotFoundError` (Phase 1).
- Produces: no new exports — `index.ts` boundary now emits the nested envelope.

- [ ] **Step 1: Replace the `onError` and `notFound` handlers**

In `workers/api/src/index.ts`, replace the entire `app.onError((err, c) => { … })` block (currently lines ~458-503, incl. the `BareSlugRejected`/`HTTPException`/fallback branches) with:

```ts
app.onError((err, c) => respondError(c, err));
```

Add the import near the other `./lib/*` imports at the top of the file:

```ts
import { respondError } from "./lib/error-response";
```

Replace the `app.notFound((c) => …)` block (currently lines ~968-976) with:

```ts
app.notFound((c) =>
  respondError(c, new NotFoundError(`No route for ${c.req.method} ${new URL(c.req.url).pathname}`)),
);
```

Add `NotFoundError` to the imports (from `@releases/lib/releases-error`). Remove the now-unused `BareSlugRejected` / `HTTPException` imports from `index.ts` ONLY if they are no longer referenced elsewhere in the file — grep first (`grep -n "BareSlugRejected\|HTTPException" workers/api/src/index.ts`); leave them if still used.

- [ ] **Step 2: Update the boundary tests to the nested shape**

These four files each build a local Hono app that either copies the old `onError` body or exercises the real boundary. Update each so it exercises the REAL handler via `respondError` and asserts the nested envelope. For any file that inlined a copy of the flat handler, replace that copy with `.onError((e, c) => respondError(c, e))` (import `respondError` from the correct relative path) so there is no stale copy to drift.

Nested assertions to use:

- Unexpected 500 (was `error:"internal_error"`, `message:"An unexpected error occurred."`):

```ts
const body = (await res.json()) as { error: { code: string; type: string; message: string } };
expect(body.error.code).toBe("internal_error");
expect(body.error.type).toBe("internal");
expect(body.error.message).toBe("Internal server error");
```

- Malformed JSON / `HTTPException(400)` (was `error:"bad_request"`, `message:"invalid JSON body"`):

```ts
const body = (await res.json()) as { error: { code: string; type: string } };
expect(body.error.code).toBe("invalid_json");
expect(body.error.type).toBe("validation");
```

- Bare slug (was `error:"bare_slug_rejected"`, `entity`, `message`):

```ts
const body = (await res.json()) as { error: { code: string; details: { entity: string } } };
expect(body.error.code).toBe("bare_slug_rejected");
expect(body.error.details.entity).toBe("source");
```

- 404 notFound (was `error:"not_found"`):

```ts
const body = (await res.json()) as { error: { code: string; type: string } };
expect(body.error.code).toBe("not_found");
expect(body.error.type).toBe("not_found");
```

In `org-scoped-routes.test.ts`, change ONLY the assertions that exercise the boundary (`bare_slug_rejected`, and any `bad_request` that comes from the `onError` HTTPException path or a `validateJson` failure). Leave assertions that check a route handler's own inline `c.json({ error: "..." })` body asserting the flat shape — those inline producers are unchanged in Phase 2.

- [ ] **Step 3: Handle the on-error drift check**

`on-error-sanitization.test.ts` references a "done criteria" grep check that guards its inline copy against drift from the source handler. Run `grep -rn "done criteria\|onError" workers/api/test/on-error-sanitization.test.ts` and, since the test now imports and exercises the real `respondError` instead of copying, remove or update that drift-check assertion so it no longer compares against a stale flat copy. If the check greps `index.ts` for a literal flat-shape string, delete that assertion (the copy is gone).

- [ ] **Step 4: Run the boundary tests**

Run each:

```bash
bun test workers/api/test/on-error-sanitization.test.ts
bun test workers/api/src/lib/json-body.test.ts
bun test workers/api/test/workflows-json-body.test.ts
bun test workers/api/test/org-scoped-routes.test.ts
```

Expected: PASS. If a non-boundary assertion in `org-scoped-routes.test.ts` fails, it means an inline-producer body was changed — revert that assertion to the flat shape (inline producers are Phase 3).

- [ ] **Step 5: Commit**

```bash
git add workers/api/src/index.ts workers/api/test/on-error-sanitization.test.ts workers/api/src/lib/json-body.test.ts workers/api/test/workflows-json-body.test.ts workers/api/test/org-scoped-routes.test.ts
git commit -m "feat(errors): API onError/notFound emit the nested envelope via respondError

Boundary paths only; inline producers stay flat until Phase 3.

Claude-Session: https://claude.ai/code/session_015vCgYf4wCXnyr7MQrQ1xCY"
```

---

## Task 5: `validateJson` emits a ValidationError envelope

**Files:**

- Modify: `workers/api/src/lib/validate.ts`
- Modify (tests): any `validateJson` schema-failure assertion that checks the body (search below)

**Interfaces:**

- Consumes: `ValidationError` (Phase 1).
- Produces: no signature change — `validateJson(schema)` still returns a `hono-openapi` validator; only its failure body changes from flat `{ error: "bad_request", message }` to `{ error: { code: "validation_failed", type: "validation", message } }`.

- [ ] **Step 1: Find schema-failure body assertions**

Run: `grep -rn "bad_request" workers/api/src workers/api/test | grep -i "valid\|json"`
and `grep -rln "valid(\"json\"\|validateJson" workers/api`.
Note which tests assert the 400 body (not just `res.status`). These are the ones to update in Step 4. (Malformed-JSON-byte tests belong to Task 4's `HTTPException` path — do not touch those here.)

- [ ] **Step 2: Write/adjust the failing test**

Pick the nearest existing `validateJson` schema-failure test (from Step 1) and change its body assertion to the nested shape; if none asserts the body, add one to `workers/api/src/lib/validate.test.ts` (create if absent):

```ts
import { expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { validateJson } from "./validate";

test("validateJson emits a nested validation envelope on schema failure", async () => {
  const app = new Hono();
  app.post("/x", validateJson(z.object({ n: z.number() })), (c) => c.json({ ok: true }));
  const res = await app.request("/x", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ n: "not-a-number" }),
  });
  expect(res.status).toBe(400);
  const body = (await res.json()) as { error: { code: string; type: string; message: string } };
  expect(body.error.code).toBe("validation_failed");
  expect(body.error.type).toBe("validation");
  expect(typeof body.error.message).toBe("string");
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test workers/api/src/lib/validate.test.ts`
Expected: FAIL — body is still the flat `{ error: "bad_request", message }`.

- [ ] **Step 4: Update `validateJson`**

In `workers/api/src/lib/validate.ts`, add the import:

```ts
import { ValidationError } from "@releases/lib/releases-error";
```

and change the failure branch of the hook:

```ts
export function validateJson<S extends Parameters<typeof validator>[1]>(schema: S) {
  return validator("json", schema, (result, c) => {
    if (!result.success) {
      const err = new ValidationError(formatIssues(result.error as readonly StandardIssue[]));
      return c.json(err.toWire(), 400);
    }
  });
}
```

(`ValidationError`'s message is `expose: true`, so the formatted issue string is preserved in `error.message`.)

Then update any other body assertions found in Step 1 to the nested shape (`error.code === "validation_failed"`).

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test workers/api/src/lib/validate.test.ts` and any files touched in Step 4.
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add workers/api/src/lib/validate.ts workers/api/src/lib/validate.test.ts
git commit -m "feat(errors): validateJson emits the nested validation envelope

Claude-Session: https://claude.ai/code/session_015vCgYf4wCXnyr7MQrQ1xCY"
```

---

## Task 6: Verification gate (Definition of Done)

No code. Proves the whole phase is green, additive to inline producers, and MCP-safe.

**Files:** none.

- [ ] **Step 1: Full CI test suite (all segments)**

Run the exact CI command — NOT just `packages/` + `workers/api`. The `validateJson`
consumers live in the top-level `tests/` directory (`tests/unit/phase2-*-validators.test.ts`,
`tests/api/overview-validator.test.ts`, `tests/api/source-kind-write.test.ts`,
`tests/unit/summaries-route.test.ts`), which `bun test workers/api` does NOT cover:

Run: `bun run test`
(= `bun test packages/ && bun test tests/ web/ workers/discovery workers/mcp workers/webhooks && bun test workers/api`)
Expected: PASS, exit 0.

Two shapes coexist in the `tests/` validator files and MUST be kept distinct:

- A `validateJson` **schema** failure (missing/wrong-type/enum/`.refine()`) now returns the
  nested envelope → assert `body.error.code === "validation_failed"`, `body.error.type === "validation"`,
  and read the message via `body.error.message`.
- A **route-handler** business-rule rejection that runs AFTER `validateJson` passes (titles
  like "(handler check)", "(handler cross-field)", "rejected by handler", "orgId lacks the org\_
  prefix", the PATCH-source invalid-kind case, and the overview `bad_citations` cross-check)
  is an inline producer and stays FLAT (`body.error === "bad_request"` / `"bad_citations"`,
  `body.message`) until Phase 3. Do NOT convert these.

If a test outside the boundary set fails on an error body, decide which of the two shapes it is
before editing: convert only the `validateJson`-driven ones; leave handler-driven ones flat.

- [ ] **Step 2: Lint + format**

Run: `bun run check`
Expected: clean (pre-existing unrelated warnings only).

- [ ] **Step 3: MCP still type-checks (CI-faithful)**

Run: `cd workers/mcp && bun install --frozen-lockfile && npx tsc --noEmit && cd -`
Expected: 0 errors. (A root-only worktree install falsely reports dual-zod errors; the per-workspace install nests the MCP SDK zod like CI. MCP is untouched this phase.)

- [ ] **Step 4: Confirm inline producers were NOT migrated**

Run: `git diff --stat main -- workers/api/src/routes | tail -5`
Expected: no route-file changes (Phase 2 touches only `index.ts`, `lib/error-response.ts`, `lib/validate.ts`). If a route file changed, an inline producer was migrated early — revert it (that's Phase 3).

Run: `grep -rc 'c.json({ error: "' workers/api/src/routes | awk -F: '{s+=$2} END {print s" inline flat producers remain (expected: unchanged from main)"}'`

- [ ] **Step 5: Push and open a draft PR**

```bash
git push -u origin feat/standardized-errors-phase2
gh pr create --draft --title "Standardized errors: Phase 2 (API boundary)" --body-file <(printf '%s\n' "See docs/superpowers/plans/2026-07-02-standardized-errors-phase2.md. Boundary paths (onError/notFound/HTTPException/BareSlugRejected/validateJson) now emit the nested error envelope and D1 failures carry their code on every route. Inline producers stay flat until Phase 3. https://claude.ai/code/session_015vCgYf4wCXnyr7MQrQ1xCY")
```

---

## Testing strategy

- Task 1–2: unit tests in the packages (`bun test packages/`).
- Task 3: `respondError` unit tests via a throwaway Hono app (`workers/api/src/lib/error-response.test.ts`) — the core producer logic, tested in isolation before wiring.
- Task 4–5: boundary integration — the four inline-copy test files + a `validateJson` schema-failure test assert the nested body.
- Task 6: whole-worker suite + `bun run check` + MCP tsc + the additive-only guards.

## Out of scope (deferred, with reasons)

- **`classifyAnthropicError` in `onError`.** No HTTP route calls Anthropic synchronously today (only `cron/scrape-agent-sweep.ts`), and `classifyAnthropicError` returns `kind: "other"` for non-Anthropic errors — wiring it blindly into the fallback would mislabel every unhandled 500 as `upstream`. Add it when a request-path Anthropic call exists, gated on an actual Anthropic SDK `instanceof`.
- **MCP taxonomy sharing.** `scopeErrorText` already emits the `insufficient_scope` string that matches the registry, and `AmbiguousEntityError` is prose-only with no API equivalent. Single-sourcing would need a new core export for no functional gain, and pulling the api-types schema into `workers/mcp` risks its pinned-zod. Revisit if/when MCP adopts structured error payloads.
- **Migrating the ~486 inline `c.json({ error })` producers** and the discovery worker's `{ error: human-string }` — Phase 3.
- **Consumer decode** (`web/src/lib/api.ts`, the out-of-tree CLI adopting `decodeApiError`) — Phase 4. The interim window where boundary paths return nested while inline producers return flat is accepted (design option a); web reads status, and the CLI shows a slightly worse message on 404/500/validation until Phase 4.
- **Retiring `ErrorResponseSchema`** — Phase 3, when the last flat producer is gone.

## Self-Review

- **Spec coverage (Phase 2):** `onError` → Task 4; `notFound` → Task 4; validation envelope → Task 5; central D1 classification on every route → Task 3 (step 3, branch 4); `expose` hardening carry-over → Task 1; `statusToType` support → Task 2. Anthropic-in-onError and MCP explicitly deferred with reasons (Out of scope). ✓
- **Placeholder scan:** the only non-verbatim steps are the test-file edits in Tasks 4–5, which are inherently discovery-driven (the exact current assertions vary per file); each gives the exact nested assertion snippets to apply and a grep to locate them. No "add error handling"/"similar to"/TBD. ✓
- **Type consistency:** `respondError(c, err): Response`, `statusToType`, `TYPE_BY_STATUS`, `ValidationError`/`InternalError`/`NotFoundError`/`ReleasesError`, and the envelope field names (`error.code/type/message/details`) are used identically across Tasks 2→3→4→5. ✓
