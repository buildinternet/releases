# Standardized Errors — Phase 1 (Foundation) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the standardized-error _contract_ — a pure taxonomy, a zod wire envelope with a decode helper, and a typed throwable hierarchy — as three additive, tested modules across `core`/`api-types`/`lib`, with zero producer or consumer changes.

**Architecture:** Three package seams, split along the zod line. `packages/core` holds the pure, zod-free taxonomy (categories, status map, code registry). `packages/api-types` holds the zod wire schema plus `decodeApiError`/`isApiError`. `packages/lib` holds the `ReleasesError` throwable hierarchy whose `toWire()` return type is imported from `api-types`, so the producer is compile-checked against the schema. Anti-drift invariants are enforced by a schema/union parity test and a `toWire → parse → decode` round-trip test.

**Tech Stack:** Bun, TypeScript (strict), zod v4 (api-types only), `bun:test`.

Full design context: `docs/superpowers/specs/2026-07-02-standardized-errors-design.md`.

## Global Constraints

- **`packages/core` stays zod-free.** No `zod` import may be added to `core`. Its only deps remain `drizzle-orm`, `js-tiktoken`, `nanoid`.
- **`packages/api-types` is the only home for the zod wire schema.** It already depends on `@buildinternet/releases-core` (`^0.24.0`) and `zod` (`^4.4.3`).
- **Dependency direction is `lib → api-types → core`, and must stay acyclic.** `api-types` must never import `lib`. `core` imports nothing from this repo.
- **`lib`'s import of `api-types` is type-only** (`import type { ErrorEnvelope }`), so no zod is pulled into `lib` at runtime.
- **`workers/mcp` must keep type-checking.** Its zod is pinned to the MCP SDK's nested copy; MCP shares only the zod-free `core` taxonomy and must NOT import the `api-types` error schema. Verified by `cd workers/mcp && npx tsc --noEmit` in Task 4.
- **Additive only.** No route handler, no web/CLI consumer, and no existing `packages/lib/src/errors.ts` class is changed in Phase 1. `ErrorResponseSchema` stays exported (add a `@deprecated` doc comment only).
- **Package export convention:** each `core`/`lib` module is a file under `src/` with its own `exports` subpath entry; `api-types` re-exports through its single `src/api-types.ts` barrel using `.js` import extensions.
- **Tests:** `bun:test`, colocated as `src/*.test.ts`. Run all three packages with `bun test packages/`.
- **Verify command:** `bun run check` (= `oxlint` + `oxfmt --check`).
- **`api-types` is published and co-bumps with `core`.** Adding a new `ErrorType` later is a `core` release + `api-types` co-bump — not relevant to Phase 1 (no new types added after this), but the enum-parity test guards it.
- **Commit style:** end commit messages with `Claude-Session: https://claude.ai/code/session_015vCgYf4wCXnyr7MQrQ1xCY`. Do not use "comprehensive"/"world-class".

---

## File Structure

- `packages/core/src/errors.ts` — **new.** `ERROR_TYPES`, `ErrorType`, `STATUS_BY_TYPE`, `statusForType()`, `ERROR_CODES`, `ErrorCode`. Pure, zod-free.
- `packages/core/src/errors.test.ts` — **new.** Status-map + registry tests.
- `packages/core/package.json` — **modify.** Add `"./errors": "./src/errors.ts"` to `exports`.
- `packages/api-types/src/schemas/errors.ts` — **new.** `errorEnvelopeSchema`, `ErrorEnvelope`, `DecodedApiError`, `decodeApiError()`, `isApiError()`.
- `packages/api-types/src/schemas/errors.test.ts` — **new.** Parse/reject, enum-parity, lenient-decode tests.
- `packages/api-types/src/api-types.ts` — **modify.** Re-export the new value + type symbols.
- `packages/api-types/src/schemas/shared.ts` — **modify.** Add a `@deprecated` comment to `ErrorResponseSchema` (keep it exported).
- `packages/lib/src/releases-error.ts` — **new.** `ReleasesError` base + `isReleasesError()` + 10 subclasses + `toWire()`.
- `packages/lib/src/releases-error.test.ts` — **new.** Subclass fields, status derivation, expose gate, round-trip.
- `packages/lib/package.json` — **modify.** Add the `api-types` dep and the `./releases-error` export.

---

## Task 1: Core taxonomy

**Files:**

- Create: `packages/core/src/errors.ts`
- Create: `packages/core/src/errors.test.ts`
- Modify: `packages/core/package.json` (`exports`)

**Interfaces:**

- Consumes: nothing (leaf).
- Produces:
  - `ERROR_TYPES: readonly ["validation","unauthorized","forbidden","insufficient_scope","not_found","conflict","rate_limited","upstream","unavailable","internal"]`
  - `type ErrorType = (typeof ERROR_TYPES)[number]`
  - `STATUS_BY_TYPE: Record<ErrorType, number>`
  - `statusForType(type: ErrorType): number`
  - `ERROR_CODES: readonly string[]` (registry) and `type ErrorCode = (typeof ERROR_CODES)[number]`
  - Import path: `@buildinternet/releases-core/errors`

- [ ] **Step 1: Write the failing test**

Create `packages/core/src/errors.test.ts`:

```ts
import { expect, test } from "bun:test";
import { ERROR_TYPES, STATUS_BY_TYPE, statusForType, ERROR_CODES } from "./errors";

test("every ErrorType has a numeric status", () => {
  for (const t of ERROR_TYPES) {
    expect(typeof STATUS_BY_TYPE[t]).toBe("number");
  }
});

test("statusForType maps each category to its status class", () => {
  expect(statusForType("validation")).toBe(400);
  expect(statusForType("unauthorized")).toBe(401);
  expect(statusForType("forbidden")).toBe(403);
  expect(statusForType("insufficient_scope")).toBe(403);
  expect(statusForType("not_found")).toBe(404);
  expect(statusForType("conflict")).toBe(409);
  expect(statusForType("rate_limited")).toBe(429);
  expect(statusForType("upstream")).toBe(502);
  expect(statusForType("unavailable")).toBe(503);
  expect(statusForType("internal")).toBe(500);
});

test("there are exactly 10 error types", () => {
  expect(ERROR_TYPES.length).toBe(10);
});

test("error codes are unique", () => {
  expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/core/src/errors.test.ts`
Expected: FAIL — `Cannot find module './errors'`.

- [ ] **Step 3: Write the implementation**

Create `packages/core/src/errors.ts`:

```ts
/**
 * Error taxonomy — the single source of truth for error categories, their HTTP
 * status mapping, and the canonical error-code registry. Pure and zod-free so
 * every surface (API, MCP, CLI, web) can share it below the zod line. The zod
 * wire schema that serializes these lives in
 * `@buildinternet/releases-api-types`; the throwable hierarchy that carries them
 * lives in `@releases/lib/releases-error`.
 */

/** Coarse error category. Determines the HTTP status class (see STATUS_BY_TYPE). */
export const ERROR_TYPES = [
  "validation",
  "unauthorized",
  "forbidden",
  "insufficient_scope",
  "not_found",
  "conflict",
  "rate_limited",
  "upstream",
  "unavailable",
  "internal",
] as const;

export type ErrorType = (typeof ERROR_TYPES)[number];

/** category -> HTTP status. Status is derived from `type`, never hand-picked. */
export const STATUS_BY_TYPE: Record<ErrorType, number> = {
  validation: 400,
  unauthorized: 401,
  forbidden: 403,
  insufficient_scope: 403,
  not_found: 404,
  conflict: 409,
  rate_limited: 429,
  upstream: 502,
  unavailable: 503,
  internal: 500,
};

export function statusForType(type: ErrorType): number {
  return STATUS_BY_TYPE[type];
}

/**
 * Canonical, stable error codes. `code` is the machine discriminant on the wire;
 * once shipped a code is never reworded (the message may change; the code may
 * not). Open on the wire — a new server code an old client doesn't recognize
 * still decodes — but producers construct from this registry so a typo is a
 * compile error. First cut; finalized against the ~486 producer sites in Phase 3.
 */
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
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];
```

- [ ] **Step 4: Add the export subpath**

In `packages/core/package.json`, add this line to the `exports` object (keep the existing entries; alphabetical placement near the other short names — after `"./domain"` is fine):

```json
    "./errors": "./src/errors.ts",
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/core/src/errors.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/core/src/errors.ts packages/core/src/errors.test.ts packages/core/package.json
git commit -m "feat(errors): core error taxonomy — types, status map, code registry

Claude-Session: https://claude.ai/code/session_015vCgYf4wCXnyr7MQrQ1xCY"
```

---

## Task 2: api-types wire envelope + decode

**Files:**

- Create: `packages/api-types/src/schemas/errors.ts`
- Create: `packages/api-types/src/schemas/errors.test.ts`
- Modify: `packages/api-types/src/api-types.ts` (re-export)
- Modify: `packages/api-types/src/schemas/shared.ts` (deprecate `ErrorResponseSchema`)

**Interfaces:**

- Consumes: `ERROR_TYPES`, `ErrorType`, `ErrorCode` from `@buildinternet/releases-core/errors` (Task 1).
- Produces:
  - `errorEnvelopeSchema` (zod object; `error.type` is `z.enum(ERROR_TYPES)`, `error.code` is `z.string()`)
  - `type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>` — `{ error: { code: string; type: ErrorType; message: string; details?: unknown } }`
  - `interface DecodedApiError { code: string; type: ErrorType; message: string; details?: unknown }`
  - `decodeApiError(body: unknown): DecodedApiError` — lenient, never throws
  - `isApiError(body: unknown, code?: ErrorCode): boolean`
  - All importable from `@buildinternet/releases-api-types`.

- [ ] **Step 1: Write the failing test**

Create `packages/api-types/src/schemas/errors.test.ts`:

```ts
import { expect, test } from "bun:test";
import { ERROR_TYPES } from "@buildinternet/releases-core/errors";
import { errorEnvelopeSchema, decodeApiError, isApiError } from "./errors";

test("a valid envelope parses", () => {
  const ok = errorEnvelopeSchema.safeParse({
    error: { code: "not_found", type: "not_found", message: "Nope" },
  });
  expect(ok.success).toBe(true);
});

test("malformed envelopes reject", () => {
  expect(errorEnvelopeSchema.safeParse({}).success).toBe(false);
  expect(
    errorEnvelopeSchema.safeParse({
      error: { code: 1, type: "not_found", message: "x" },
    }).success,
  ).toBe(false);
});

test("schema type enum matches the core union (anti-drift invariant 2)", () => {
  const options = errorEnvelopeSchema.shape.error.shape.type.options;
  expect([...options].sort()).toEqual([...ERROR_TYPES].sort());
});

test("decodeApiError normalizes an unknown type to internal, preserves unknown code", () => {
  const decoded = decodeApiError({
    error: { code: "brand_new_code", type: "teapot", message: "?" },
  });
  expect(decoded.type).toBe("internal");
  expect(decoded.code).toBe("brand_new_code");
});

test("decodeApiError degrades a malformed body without throwing", () => {
  expect(decodeApiError(null)).toEqual({
    code: "internal_error",
    type: "internal",
    message: "Unknown error",
  });
});

test("decodeApiError carries details through when present", () => {
  const decoded = decodeApiError({
    error: { code: "not_found", type: "not_found", message: "x", details: { id: "src_1" } },
  });
  expect(decoded.details).toEqual({ id: "src_1" });
});

test("isApiError matches shape and optional code", () => {
  const body = { error: { code: "not_found", type: "not_found", message: "x" } };
  expect(isApiError(body)).toBe(true);
  expect(isApiError(body, "not_found")).toBe(true);
  expect(isApiError(body, "conflict")).toBe(false);
  expect(isApiError({ nope: true })).toBe(false);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/api-types/src/schemas/errors.test.ts`
Expected: FAIL — `Cannot find module './errors'`.

- [ ] **Step 3: Write the implementation**

Create `packages/api-types/src/schemas/errors.ts`:

```ts
import { z } from "zod";
import { ERROR_TYPES, type ErrorType, type ErrorCode } from "@buildinternet/releases-core/errors";

/**
 * The one on-the-wire error shape. `type` is constrained (documents the
 * contract, powers OpenAPI); `code` is an open string so a new server code an
 * older client doesn't recognize still parses. The throwable hierarchy in
 * `@releases/lib/releases-error` serializes to this via `toWire()`.
 */
export const errorEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    type: z.enum(ERROR_TYPES),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export type ErrorEnvelope = z.infer<typeof errorEnvelopeSchema>;

/**
 * Lenient variant used ONLY for decode: `type` is left open so an unknown
 * category (older client, newer server) does not reject.
 */
const lenientEnvelopeSchema = z.object({
  error: z.object({
    code: z.string(),
    type: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});

export interface DecodedApiError {
  code: string;
  type: ErrorType;
  message: string;
  details?: unknown;
}

/**
 * Parse an API error body into a typed, normalized shape. Forward-compatible: a
 * malformed body or an unknown `type` degrades to `internal` and never throws.
 */
export function decodeApiError(body: unknown): DecodedApiError {
  const parsed = lenientEnvelopeSchema.safeParse(body);
  if (!parsed.success) {
    return { code: "internal_error", type: "internal", message: "Unknown error" };
  }
  const { code, type, message, details } = parsed.data.error;
  const normalizedType: ErrorType = (ERROR_TYPES as readonly string[]).includes(type)
    ? (type as ErrorType)
    : "internal";
  return details === undefined
    ? { code, type: normalizedType, message }
    : { code, type: normalizedType, message, details };
}

/** True if `body` is an API error envelope; if `code` is given, also matches it. */
export function isApiError(body: unknown, code?: ErrorCode): boolean {
  const parsed = lenientEnvelopeSchema.safeParse(body);
  if (!parsed.success) return false;
  return code === undefined || parsed.data.error.code === code;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/api-types/src/schemas/errors.test.ts`
Expected: PASS (7 tests).

> If `errorEnvelopeSchema.shape.error.shape.type.options` is undefined in this zod build, replace that line in the test with `errorEnvelopeSchema.shape.error.shape.type._def.entries` — but try `.options` first; it is the zod v4 public accessor for `z.enum` values.

- [ ] **Step 5: Re-export from the package barrel**

In `packages/api-types/src/api-types.ts`, add near the other `export { ... } from "./schemas/*.js"` value re-exports (e.g. right after the `export { SitemapSourceSchema, ... }` line):

```ts
export { errorEnvelopeSchema, decodeApiError, isApiError } from "./schemas/errors.js";
export type { ErrorEnvelope, DecodedApiError } from "./schemas/errors.js";
```

- [ ] **Step 6: Deprecate the old schema (doc only, keep exported)**

In `packages/api-types/src/schemas/shared.ts`, replace the JSDoc/comment directly above `export const ErrorResponseSchema = z.object({` with:

```ts
/**
 * @deprecated Flat legacy error shape. Superseded by `errorEnvelopeSchema` in
 * `./errors.ts` (nested `{ error: { code, type, message, details? } }`). Kept
 * exported to bridge the Phase 2→3 migration; removed when the last producer is
 * converted. Do not add new consumers.
 */
export const ErrorResponseSchema = z.object({
```

(Keep the existing field definitions and the inner `errorCode` comment unchanged.)

- [ ] **Step 7: Verify the barrel still parses and the deprecation didn't break exports**

Run: `bun test packages/api-types/`
Expected: PASS (existing api-types tests + the new 7).

Run: `grep -n "ErrorResponseSchema" packages/api-types/src/api-types.ts`
Expected: the existing `ErrorResponseSchema` re-export line is still present (unchanged).

- [ ] **Step 8: Commit**

```bash
git add packages/api-types/src/schemas/errors.ts packages/api-types/src/schemas/errors.test.ts packages/api-types/src/api-types.ts packages/api-types/src/schemas/shared.ts
git commit -m "feat(errors): api-types wire envelope + decodeApiError/isApiError

Nested error envelope schema, lenient decode, enum-parity guard.
Deprecate the flat ErrorResponseSchema (kept exported for migration).

Claude-Session: https://claude.ai/code/session_015vCgYf4wCXnyr7MQrQ1xCY"
```

---

## Task 3: lib ReleasesError throwable hierarchy

**Files:**

- Create: `packages/lib/src/releases-error.ts`
- Create: `packages/lib/src/releases-error.test.ts`
- Modify: `packages/lib/package.json` (add `api-types` dep + `./releases-error` export)

**Interfaces:**

- Consumes: `ErrorType`, `ErrorCode`, `statusForType` from `@buildinternet/releases-core/errors` (Task 1); `type ErrorEnvelope` from `@buildinternet/releases-api-types` (Task 2, type-only); `errorEnvelopeSchema` + `decodeApiError` from `api-types` in the test.
- Produces:
  - `class ReleasesError extends Error` with `readonly code: ErrorCode; type: ErrorType; status: number; details?: unknown; expose: boolean` and `toWire(): ErrorEnvelope`
  - `interface ReleasesErrorOptions { code?: ErrorCode; details?: unknown; expose?: boolean; cause?: unknown }`
  - `isReleasesError(err: unknown): err is ReleasesError`
  - Subclasses: `ValidationError`, `UnauthorizedError`, `ForbiddenError`, `InsufficientScopeError`, `NotFoundError`, `ConflictError`, `RateLimitedError`, `UpstreamError`, `ServiceUnavailableError`, `InternalError`
  - Import path: `@releases/lib/releases-error`

- [ ] **Step 1: Add the workspace dep and export, then install**

In `packages/lib/package.json`:

Add to `dependencies` (keep the existing three):

```json
    "@buildinternet/releases-api-types": "workspace:*",
```

Add to `exports` (alphabetical — after `"./rate-limit-tiers"` is fine):

```json
    "./releases-error": "./src/releases-error.ts",
```

Then run:

```bash
bun install
```

Expected: resolves without a peer/cycle error; `bun.lock` updates.

- [ ] **Step 2: Write the failing test**

Create `packages/lib/src/releases-error.test.ts`:

```ts
import { expect, test } from "bun:test";
import { errorEnvelopeSchema, decodeApiError } from "@buildinternet/releases-api-types";
import {
  ReleasesError,
  isReleasesError,
  NotFoundError,
  InternalError,
  RateLimitedError,
} from "./releases-error";

test("a subclass sets code/type and derives status from type", () => {
  const e = new NotFoundError("Source not found");
  expect(e.type).toBe("not_found");
  expect(e.code).toBe("not_found");
  expect(e.status).toBe(404);
  expect(isReleasesError(e)).toBe(true);
  expect(e).toBeInstanceOf(Error);
});

test("toWire round-trips through the api-types schema + decode (invariant 4)", () => {
  const e = new NotFoundError("Source not found", {
    code: "not_found",
    details: { id: "src_1" },
  });
  const wire = e.toWire();
  expect(errorEnvelopeSchema.safeParse(wire).success).toBe(true);
  expect(decodeApiError(wire)).toEqual({
    code: "not_found",
    type: "not_found",
    message: "Source not found",
    details: { id: "src_1" },
  });
});

test("expose=false emits a generic message, never the raw one", () => {
  const e = new InternalError("secret dsn postgres://user:pw@host leaked");
  const wire = e.toWire();
  expect(wire.error.message).toBe("Internal server error");
  expect(wire.error.message).not.toContain("secret");
});

test("details are omitted from the wire when absent", () => {
  const wire = new RateLimitedError("slow down").toWire();
  expect("details" in wire.error).toBe(false);
});

test("the base carries a cause and is instanceof Error", () => {
  const cause = new Error("root");
  const e = new ReleasesError("internal", "wrap", { cause });
  expect(e.cause).toBe(cause);
  expect(e).toBeInstanceOf(Error);
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `bun test packages/lib/src/releases-error.test.ts`
Expected: FAIL — `Cannot find module './releases-error'`.

- [ ] **Step 4: Write the implementation**

Create `packages/lib/src/releases-error.ts`:

```ts
import { type ErrorType, type ErrorCode, statusForType } from "@buildinternet/releases-core/errors";
import type { ErrorEnvelope } from "@buildinternet/releases-api-types";

/**
 * Generic, safe-to-expose message per category, used when `expose` is false so
 * an internal/unexpected error never leaks its real message to a client.
 */
const GENERIC_MESSAGE: Record<ErrorType, string> = {
  validation: "Invalid request",
  unauthorized: "Authentication required",
  forbidden: "Forbidden",
  insufficient_scope: "Insufficient scope",
  not_found: "Not found",
  conflict: "Conflict",
  rate_limited: "Too many requests",
  upstream: "Upstream service error",
  unavailable: "Service unavailable",
  internal: "Internal server error",
};

export interface ReleasesErrorOptions {
  code?: ErrorCode;
  details?: unknown;
  expose?: boolean;
  cause?: unknown;
}

/**
 * Base of the typed, throwable domain-error hierarchy. Carries a stable `code`,
 * a coarse `type` (which derives `status`), an optional per-code `details`
 * payload, and an `expose` flag gating whether the real `message` reaches the
 * client. `toWire()` serializes to the one on-the-wire envelope — its return
 * type is imported from api-types, so the producer is compile-checked against
 * the schema (anti-drift invariant 3).
 */
export class ReleasesError extends Error {
  readonly code: ErrorCode;
  readonly type: ErrorType;
  readonly status: number;
  readonly details?: unknown;
  readonly expose: boolean;

  constructor(type: ErrorType, message: string, opts: ReleasesErrorOptions = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = new.target.name;
    this.type = type;
    this.code = opts.code ?? (type as ErrorCode);
    this.status = statusForType(type);
    this.details = opts.details;
    this.expose = opts.expose ?? true;
  }

  toWire(): ErrorEnvelope {
    const message = this.expose ? this.message : GENERIC_MESSAGE[this.type];
    return {
      error:
        this.details === undefined
          ? { code: this.code, type: this.type, message }
          : { code: this.code, type: this.type, message, details: this.details },
    };
  }
}

export function isReleasesError(err: unknown): err is ReleasesError {
  return err instanceof ReleasesError;
}

export class ValidationError extends ReleasesError {
  constructor(message = "Invalid request", opts: ReleasesErrorOptions = {}) {
    super("validation", message, { code: "validation_failed", ...opts });
  }
}

export class UnauthorizedError extends ReleasesError {
  constructor(message = "Authentication required", opts: ReleasesErrorOptions = {}) {
    super("unauthorized", message, { code: "unauthorized", ...opts });
  }
}

export class ForbiddenError extends ReleasesError {
  constructor(message = "Forbidden", opts: ReleasesErrorOptions = {}) {
    super("forbidden", message, { code: "forbidden", ...opts });
  }
}

export class InsufficientScopeError extends ReleasesError {
  constructor(message = "Insufficient scope", opts: ReleasesErrorOptions = {}) {
    super("insufficient_scope", message, { code: "insufficient_scope", ...opts });
  }
}

export class NotFoundError extends ReleasesError {
  constructor(message = "Not found", opts: ReleasesErrorOptions = {}) {
    super("not_found", message, { code: "not_found", ...opts });
  }
}

export class ConflictError extends ReleasesError {
  constructor(message = "Conflict", opts: ReleasesErrorOptions = {}) {
    super("conflict", message, { code: "conflict", ...opts });
  }
}

export class RateLimitedError extends ReleasesError {
  constructor(message = "Too many requests", opts: ReleasesErrorOptions = {}) {
    super("rate_limited", message, { code: "rate_limited", ...opts });
  }
}

export class UpstreamError extends ReleasesError {
  constructor(message = "Upstream service error", opts: ReleasesErrorOptions = {}) {
    super("upstream", message, { code: "upstream_error", expose: false, ...opts });
  }
}

export class ServiceUnavailableError extends ReleasesError {
  constructor(message = "Service unavailable", opts: ReleasesErrorOptions = {}) {
    super("unavailable", message, { code: "service_unavailable", ...opts });
  }
}

export class InternalError extends ReleasesError {
  constructor(message = "Internal server error", opts: ReleasesErrorOptions = {}) {
    super("internal", message, { code: "internal_error", expose: false, ...opts });
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `bun test packages/lib/src/releases-error.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/lib/src/releases-error.ts packages/lib/src/releases-error.test.ts packages/lib/package.json bun.lock
git commit -m "feat(errors): ReleasesError throwable hierarchy with schema-checked toWire

Base + 10 subclasses; toWire() typed against the api-types envelope so
producer output is compile-checked. Round-trip test proves invariant 4.

Claude-Session: https://claude.ai/code/session_015vCgYf4wCXnyr7MQrQ1xCY"
```

---

## Task 4: Phase-1 verification gate (Definition of Done)

This task adds no code. It proves the cross-cutting invariants no single earlier task proves: the whole workspace is green, lint/format pass, and — critically — `workers/mcp` still type-checks (the `lib → api-types` edge did not drag zod into MCP's pinned-zod path). A reviewer can reject Phase 1 here if any check fails.

**Files:** none.

**Interfaces:** none.

- [ ] **Step 1: Run all three packages' tests**

Run: `bun test packages/`
Expected: PASS — includes the new `core`/`api-types`/`lib` error tests (16 new tests) and all pre-existing package tests.

- [ ] **Step 2: Lint + format**

Run: `bun run check`
Expected: `oxlint` clean and `oxfmt --check` reports no formatting diffs. If `oxfmt --check` fails, run `bun run format` and re-run; amend into the appropriate task commit or a small `style:` commit.

- [ ] **Step 3: Confirm the MCP zod pin is untouched**

Run: `cd workers/mcp && npx tsc --noEmit && cd -`
Expected: exit 0, no errors. (If this fails with dual-zod errors, MCP is transitively importing the `api-types` error schema — it must not; MCP shares only `@buildinternet/releases-core/errors`. Stop and reconcile before proceeding.)

- [ ] **Step 4: Confirm Phase 1 was additive**

Run: `git diff --stat main -- packages/lib/src/errors.ts workers/api web`
Expected: **no output** — the existing `packages/lib/src/errors.ts` domain classes, the API worker, and web are unchanged.

Run: `grep -n "ErrorResponseSchema" packages/api-types/src/api-types.ts`
Expected: the flat `ErrorResponseSchema` re-export is still present.

- [ ] **Step 5: Push and update the PR**

```bash
git push
```

The branch `worktree-standardized-errors-spec` already has an open draft PR (#1824). Pushing updates it. Leave a PR comment noting Phase 1 (foundation) is implemented and the DoD checks pass.

---

## Self-Review

**Spec coverage (Phase 1 section of the design):**

- Core `types.ts`/`codes.ts` → Task 1 (`ERROR_TYPES`, `STATUS_BY_TYPE`, `statusForType`, `ERROR_CODES`, `ErrorCode`). ✓
- api-types `errorEnvelopeSchema` + `decodeApiError`/`isApiError` → Task 2. ✓
- lib `ReleasesError` base + hierarchy + `toWire()` → Task 3. ✓
- `respond-error.ts` → **intentionally deferred to Phase 2** (documented at plan top and in the spec's open question #2): lib has no Hono dep and the helper is only used by producers. Not a gap.
- `db-errors`/`anthropic-errors` refactor to return subclasses → **Phase 2**, not Phase 1 (Phase 1 is additive; refactoring the classifiers changes existing callers). Correctly out of this plan.
- Anti-drift invariants 1 (single source), 2 (enum parity test), 3 (`toWire(): ErrorEnvelope` type-import), 4 (round-trip test), 5 (lenient decode) → covered by Tasks 1–3 + the enum-parity test (Task 2) + round-trip test (Task 3) + `decodeApiError` leniency tests (Task 2). ✓
- DoD (`bun test packages/`, `bun run check`, MCP tsc, additive-only, `ErrorResponseSchema` still exported) → Task 4. ✓

**Placeholder scan:** No TBD/TODO/"add error handling"/"similar to Task N" — every code block is complete. ✓

**Type consistency:** `ReleasesErrorOptions`, `ErrorEnvelope`, `DecodedApiError`, `statusForType`, `ERROR_TYPES`, `ERROR_CODES`, and the subclass names are used identically across Tasks 1→2→3 and their tests. `toWire()` returns `ErrorEnvelope` (Task 2 type) in both the impl (Task 3) and the round-trip assertion (Task 3 test). ✓
