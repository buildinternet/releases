# Standardized Errors — Design

**Date:** 2026-07-02
**Status:** Design — awaiting review
**Scope:** Epic (4 phases). This document is the epic spec + a plannable Phase 1.
Phases 2–4 are scoped here; each gets its own plan when reached.

## Goal

Replace the repo's six-plus independent error conventions with one coherent
system: a shared error taxonomy, one on-the-wire error shape, a typed throwable
hierarchy for producers, and one place each to _produce_ (the API worker) and
_consume_ (web, CLI, and — for the taxonomy only — MCP) that shape. The motivation
is **full standardization** — consistent HTTP responses, typed catchable domain
errors, structured observability, and a documentable error contract for external
integrators — as one system rather than a pile of point fixes.

We are pre-V1: nothing is published as a stable contract yet, so we take the
breaking wire-shape change **now**, while the blast radius is small and entirely
in-house, rather than living with the flat shape and paying a deprecation cost
later.

## Why (current state)

A read-only survey found **no unifying error abstraction** — instead, at least six
conventions coexist, each reinvented per surface:

1. **Manual `c.json({ error: "<snake_code>" }, status)` at ~486 call sites** in
   `workers/api/src`. The de-facto shape is a flat `{ error, message?, errorCode? }`,
   but codes are ad hoc (top codes: `not_found` ×132, `bad_request` ×93,
   `unauthorized` ×32, then a long tail of one-offs), `message` presence is
   inconsistent, and some sites add stray keys (`entity`, `setup`, …). There is
   **no shared `errorResponse()` producer helper** — every site builds the object
   inline. HTTP status is chosen per call site.
2. **A declared-but-unenforced wire schema.** `ErrorResponseSchema =
   { error: string, message: string, errorCode?: string }`
   (`packages/api-types/src/schemas/shared.ts:61`) is the nominal contract the CLI
   consumes, but producers only partly match it and **no consumer decodes it** —
   `web/src/lib/api.ts` reads only `res.status` and discards the body.
3. **~17 unrelated `extends Error` classes** with no shared base
   (`packages/lib/src/errors.ts`: `CategorizedError`, `AdapterError`, `AIError`,
   `ConfigError`, `CrawlTimeoutError`, `CrawlJobError`, `FeedHttpError`,
   `FirecrawlError`; plus `EmbeddingApiError`, `Probe*Error`, `LoopFallbackError`,
   `AmbiguousEntityError`, `BareSlugRejected`, `ApiSetupError`, `ApiNotFoundError`,
   `GraphQLRequestError`). Several independently carry a `status`
   (`FeedHttpError`, `FirecrawlError`, `EmbeddingApiError`) or an `ErrorCategory`,
   with no shared mapping to HTTP or to the wire.
4. **Two code-based classifiers, not exceptions:** `classifyDbError`
   (`packages/lib/src/db-errors.ts`, incl. the D1 100-bind `DB_TOO_MANY_VARIABLES`
   case) and `classifyAnthropicError` (`packages/lib/src/anthropic-errors.ts` →
   gateway 502/500). They produce loose `{ kind, status? }` objects, disconnected
   from both the throwables and the wire.
5. **MCP text convention.** `workers/mcp` returns model-readable
   `ToolResult` text; the declared `isError` flag is **never set**; it has its own
   soft-error renderers (`scopeErrorText`, `ambiguousEntityToolResult`). It shares
   no error mapping with the API.
6. **Discovery/webhooks raw `Response`.** `workers/discovery` uses
   `errorResponse(message, status)` where `error` holds a **human string**, not a
   code — a different convention again — plus a rich `SessionErrorClassification`
   (`errorSource`, `severity`) consumed cross-surface.

Boundary state:

- `workers/api/src/index.ts` **does** already have `onError` (`:458`),
  `notFound` (`:968`), and a per-route `validateJson` helper — but **no global zod
  `defaultHook`**, so validation-error shape is per-route opt-in.
- `errorCode` (the D1 classification that would tell a client _why_ a write 500'd)
  reaches clients on **only ~4 routes**; the D1 100-bind overflow otherwise
  surfaces as a bare `internal_error` 500 with the diagnostic dropped.
- The `{error: string}` field name **collides conceptually** with unrelated
  field-level `error` strings already in the schema (`schemas/stats.ts:32`,
  `schemas/sources.ts:497`, a source's last-fetch error) — a namespace hazard a
  nested envelope removes.
- `logEvent` (`packages/lib/src/log-event.ts`) is the one genuinely centralized
  piece, but it's pure observability — no error-code/category notion — and
  log-and-continue catches rarely attach a stable code.

## Key decisions (locked)

### 1. Wire shape: nested `error` object, discriminated by a stable `code`

```json
{
  "error": {
    "code": "source_not_found",
    "type": "not_found",
    "message": "Source not found",
    "details": { "id": "src_abc123" }
  }
}
```

- `code` — stable, snake_case, machine-readable; **the discriminant**. Never
  reworded once shipped (the message may change; the code may not).
- `type` — coarse category (≤10 values) that **derives the HTTP status class**.
- `message` — human-readable, safe to display (gated by `expose`; see below).
- `details` — optional, per-`code` structured payload. This is finally where
  `errorCode` (D1 classification), `candidates[]` (ambiguous entity),
  `required_scope` (insufficient scope), `retryAfterMs`, etc. travel to clients.

Chosen over evolving the flat shape because Releases has a genuine external
surface — a public REST API, scoped `relk_`/`relu_` tokens, the OAuth 2.1 / OIDC
JWT lane, and MCP — that benefits from the developer-API gold-standard shape
(Stripe/OAuth). Nesting also removes the top-level `error`-string namespace
collision noted above. Pre-V1 timing makes the break cheap.

**`code` is an open `string` on the wire, not a strict `z.discriminatedUnion`.**
Only `type` is constrained. This keeps the schema forward-compatible: a new server
`code` an old client doesn't recognize still _decodes_ (never rejects), degrading
to its `type`. A typed `ErrorCode` registry (below) still gives compile-time
safety to in-tree producers and known-code consumers.

### 2. Three ways this stays simple for clients

The nested shape must not make integration harder. Three deliberate reducers:

1. **HTTP status stays fully authoritative**, derived from `type` via one table.
   Naive clients (today's `web/src/lib/api.ts`) keep switching on status alone and
   never parse the body. The envelope is progressive enhancement.
2. **One published decode helper, not N ad-hoc checks.** `decodeApiError(body)` +
   `isApiError(body, code?)` ship from `@buildinternet/releases-api-types`. Web
   (in-tree) and the CLI (out-of-tree) import the _same_ typed helper — nobody
   hand-rolls parsing. This is the single biggest reducer and the piece missing
   today.
3. **Switch on `type`, not on every `code`.** Clients that only need "was this my
   bad input vs a 404 vs a 429" match the ≤10-value `type`; only integrators
   needing specifics read `code`.

### 3. Home: reuse the three existing package seams — no new package

The reference project this design draws from used a single leaf `packages/errors`.
For Releases that is the wrong call, for constraint reasons, not sentiment:

- **The zod boundary forces layering.** MCP must share the error _taxonomy/codes_
  (consistent codes across surfaces is half the point), but `workers/mcp`'s zod is
  pinned to the MCP SDK's nested copy and is fragile — it must not pull the
  wire-schema package's zod. So the shared taxonomy has to sit **below the zod
  line** (in the zod-free `core`), and only the zod _schema_ half lives in the
  zod-owning `api-types`.
- **`api-types` is already the published wire-contract home** the CLI consumes. A
  new published `packages/errors` would add a second cross-repo skew axis (two
  pinned contract packages instead of one), add a package to a fragile publish
  pipeline, and **fragment the wire contract** (error shapes apart from every other
  response shape).

Resulting layout:

| Concern | Home | Rationale |
|---|---|---|
| `ErrorType` union · `STATUS_BY_TYPE` map · `statusForType()` · canonical `ErrorCode` registry (all pure, zod-free) | **`packages/core`** (`@buildinternet/releases-core`) | Below the zod line; MCP + CLI + everything share it freely |
| `errorEnvelopeSchema` (zod) · `ErrorEnvelope` type · `decodeApiError()` · `isApiError()` | **`packages/api-types`** (`@buildinternet/releases-api-types`) | Where wire schemas live by charter; already the CLI's pinned dep; subsumes `ErrorResponseSchema` |
| `ReleasesError` base + subclass hierarchy + `toWire()` · `respondError(c, err)` Hono helper · refactored `classifyDbError`/`classifyAnthropicError` | **`packages/lib`** (`@releases/lib`) | Worker-only (all producers already import `@releases/lib`); Hono-coupled helper cannot live in `api-types` |

The existing `CategorizedError` becomes (or is replaced by) the `ReleasesError`
base. The classifiers become functions that _produce_ a typed subclass instead of
a loose `{ kind }`.

### 4. Coordinated internal cutover, not a public flag day

The API is same-origin; nearly all consumers are in-tree; the CLI is the one
out-of-tree consumer and we control it. We sequence the phases so the boundary and
consumers flip in a controlled order. `ErrorResponseSchema` stays as a deprecated
alias to bridge Phase 2→3.

## Architecture

Two halves that meet at the wire shape, split along the zod line:

- **In-worker throwable hierarchy** (`instanceof`-able, status-carrying, zod-free)
  — `ReleasesError` + subclasses in `packages/lib`, raised anywhere a typed domain
  failure occurs, caught centrally by the API's `onError`.
- **Shared wire schema** (`packages/api-types`, zod) — the serialized contract the
  API emits and web/CLI parse via `decodeApiError()`.
- **Pure taxonomy** (`packages/core`) sits below both, the single source of truth
  for categories, status mapping, and the code registry.

```
packages/core/src/errors/          (zod-free; imported by lib AND api-types)
  types.ts        ErrorType union + STATUS_BY_TYPE + statusForType()
  codes.ts        ErrorCode registry (const) + ErrorCode type
  index.ts        barrel

packages/lib/src/                   (worker-only throwables; imports core + (type-only) api-types)
  errors.ts       ReleasesError base (code/type/status/details/expose, toWire()),
                  first-cut subclasses, isReleasesError() guard
  db-errors.ts    classifyDbError() -> DbError subclass  (refactor of existing)
  anthropic-errors.ts  classifyAnthropicError() -> subclass  (refactor of existing)
  respond-error.ts  respondError(c, err) Hono helper

packages/api-types/src/schemas/
  errors.ts       errorEnvelopeSchema (zod) + ErrorEnvelope type,
                  decodeApiError(body), isApiError(body, code?)
                  (ErrorResponseSchema kept here as a deprecated alias until Phase 3)
```

### `ReleasesError` base class

```ts
class ReleasesError extends Error {
  readonly code: ErrorCode;     // stable discriminant, from the core registry
  readonly type: ErrorType;     // category -> status
  readonly status: number;      // = statusForType(type), overridable
  readonly details?: unknown;   // per-code payload
  readonly expose: boolean;     // is `message` safe to send to clients?
  constructor(...);
  toWire(): ErrorEnvelope;      // -> { error: { code, type, message, details? } }
}
```

- `expose` gates whether the real `message` reaches the client. Unexpected /
  internal errors serialize a generic message; typed domain errors expose theirs.
  This is how `onError` avoids leaking internals on a fall-through 500.
- `toWire()`'s **return type is imported from `api-types`** (`ErrorEnvelope`), so
  the producer is compile-checked against the schema — see Anti-drift invariant 3.
- First-cut subclasses (grown as needed, not exhaustive): `ValidationError`,
  `UnauthorizedError`, `ForbiddenError`, `InsufficientScopeError`, `NotFoundError`,
  `ConflictError`, `RateLimitedError`, `ServiceUnavailableError`,
  `UpstreamError` (Anthropic/gateway 502), `InternalError`. The existing
  `AdapterError`/`AIError`/`FeedHttpError`/`FirecrawlError`/`EmbeddingApiError`
  become subclasses that map onto `type: "unavailable" | "internal"` and carry
  their extra fields in `details`.

### `ErrorType` → HTTP status map

One table maps category → status class: `validation`→400, `unauthorized`→401,
`forbidden`/`insufficient_scope`→403, `not_found`→404, `conflict`→409,
`rate_limited`→429, `upstream`→502, `unavailable`→503, `internal`→500. Status is
_derived_, not hand-picked per call site — this is what removes the ~486 ad-hoc
status choices.

### Reconciling the existing conventions

- `ErrorResponseSchema` (`{ error: string }`) → the new envelope; kept as a
  deprecated alias during migration, removed at the end of Phase 3.
- `classifyDbError` → `DbError` subclass; `DB_TOO_MANY_VARIABLES` gets a stable
  `code` and `details: { causeCode, transient }`, so D1-overflow 500s finally
  carry their diagnostic to clients (fixes the "only 4 routes" gap).
- `classifyAnthropicError` → `UpstreamError` (`type: "upstream"`, 502) /
  `InternalError`, preserving `retryAfterMs` in `details`.
- `BareSlugRejected` → `ValidationError`, `code: "bare_slug_rejected"`,
  `details: { entity, slug }`.
- MCP's `AmbiguousEntityError` / insufficient-scope keep their text renderers but
  derive `code`/`text` from the shared taxonomy (shared codes, distinct format —
  see MCP note below).
- Discovery's `{ error: human-string }` responses adopt the envelope in Phase 3.

### MCP shares the taxonomy, not the schema

`workers/mcp` imports the **zod-free** `core` taxonomy + `lib` throwables to derive
consistent `code`s in its text results; it does **not** import
`errorEnvelopeSchema` (which would drag api-types' zod into MCP's pinned-zod path).
MCP stays a distinct output _format_ (model-readable text, `isError` still a
model-self-correct signal) but a shared _taxonomy_. This is a deliberate,
revisitable trade: if we later decide MCP need not share codes, the zod-line
constraint relaxes and the packaging could collapse toward `api-types`.

## Anti-drift invariants

Splitting across three packages creates seams; these five invariants close the two
that are structural and tame the one that isn't. They are **invariants, enforced by
compiler or test — not conventions.**

1. **`core` is the sole source** of `ErrorType`, `STATUS_BY_TYPE`, and the
   `ErrorCode` registry. No inlined union members or hardcoded statuses anywhere
   else; subclasses derive status via `statusForType(type)`.
2. **`api-types` builds its zod enum _from_ the core union**
   (`z.enum([...ERROR_TYPES])`), never a hand-copied literal. A unit test asserts
   the zod enum's values `≡` the core union.
3. **`ReleasesError.toWire(): ErrorEnvelope`** imports the `ErrorEnvelope` type
   from `api-types` (dependency direction `lib → api-types → core` is acyclic), so
   any field-shape divergence is a **compile error**, not a runtime surprise.
4. **A round-trip test lives in `lib`** (the package that sees all three):
   `subclass.toWire()` → `errorEnvelopeSchema.parse()` → `decodeApiError()`
   preserves `code`/`type`/`status`/`details`.
5. **`type` is append-only and `decodeApiError` is lenient.** An unknown `type` or
   `code` degrades to a generic/`internal` decode, never rejects — so an older
   pinned CLI keeps working against a newer server. Adding a `type` is a core
   release + an api-types co-bump (already our co-bump discipline); this is flagged
   as a release step, not left implicit.

The one drift that is **not** structural — version skew between the server and the
out-of-tree CLI pinned to an older `api-types` — **exists today** with
`ErrorResponseSchema` and is not made worse by the split. Invariant 5 (lenient
decode) is what tames it; a single-package design would not remove it, since the
CLI still consumes at a pin.

## Phases

Each phase ships independently and leaves the tree green.

### Phase 1 — Foundation (the contract) — _detailed below, plannable now_

Create the taxonomy in `core`, the envelope schema + `decodeApiError`/`isApiError`
in `api-types`, and the `ReleasesError` base + first-cut hierarchy + `toWire()` in
`lib` (consolidating the existing loose classes). **No producers or consumers
changed** — purely additive; `ErrorResponseSchema` stays as a deprecated alias.
Deliverable: the tested contract, importable, with the anti-drift tests in place.

### Phase 2 — API boundary + MCP taxonomy (the producer)

- Rework `workers/api/src/index.ts` `onError`: any `ReleasesError` → its `toWire()`
  + `statusForType`; anything else → a generic `InternalError` (500, non-exposed
  message). Every path `logEvent`s. Keep `HTTPException` header passthrough.
- Rework `notFound` → `NotFoundError` envelope.
- Add a global zod `defaultHook` (and/or wrap `validateJson`) → `ValidationError`
  envelope, fixing the invisible per-route shape mismatch.
- Route the refactored `classifyDbError`/`classifyAnthropicError` through the
  hierarchy so D1 + Anthropic failures carry `code`/`details` on _every_ route.
- Point MCP's text renderers at the shared taxonomy for consistent codes.
- **Outcome:** every failure — expected or not — emits the one shape and is logged,
  _without yet touching the ~486 producer call sites_.

### Phase 3 — Migrate producers

Convert the ~486 `c.json({ error }, status)` sites to `throw` the hierarchy (caught
centrally) or `respondError(c, err)`; fold the ~17 ad-hoc classes and the discovery
worker's `{ error: human-string }` onto the envelope. Mechanical, per-route-file,
incremental. Retire the `ErrorResponseSchema` alias when the last site is gone.

### Phase 4 — Consumers

- `web/src/lib/api.ts`: decode the body via `decodeApiError()` (status stays
  authoritative for naive paths); reconcile the swallow-to-`null` helpers where a
  typed error helps. Leave React-invariant `throw new Error(...)` assertions alone.
- CLI (`buildinternet/releases-cli`, separate repo): bump `api-types`, adopt
  `decodeApiError()` for typed errors + better messages. This is the only cross-repo
  step.

## Phase 1 detail (for planning)

**`packages/core/src/errors/`**

- `types.ts` — `ErrorType` union, `STATUS_BY_TYPE`, `statusForType()`.
- `codes.ts` — `ERROR_CODES` registry `const` seeded from the real codes across the
  ~486 sites (`not_found`, `bad_request`, `unauthorized`, `bare_slug_rejected`,
  `insufficient_scope`, the D1 + Anthropic codes, …) + the `ErrorCode` type.
- Barrel export; keep `core` zod-free.

**`packages/lib/src/`**

- `errors.ts` — `ReleasesError` base (fields above, `toWire()`,
  `isReleasesError()`), the first-cut subclasses, and re-homing of the existing
  domain classes as subclasses.
- `db-errors.ts` / `anthropic-errors.ts` — refactor the classifiers to return
  subclasses (keep the existing detection logic; change only the output type).
- `respond-error.ts` — `respondError(c, err)` (used in Phase 3, added now).
- Add a **type-only** dep on `api-types` for `ErrorEnvelope`.

**`packages/api-types/src/schemas/errors.ts`**

- `errorEnvelopeSchema` — `z.object({ error: z.object({ code: z.string(),
  type: <enum from core>, message: z.string(), details: z.unknown().optional() }) })`,
  `.meta({ id })` for clean OpenAPI `$ref`.
- `ErrorEnvelope` inferred type.
- `decodeApiError(body): { code, type, message, details? }` — lenient parse,
  unknown `type`/`code` → generic/`internal`, never throws.
- `isApiError(body, code?)` — typed guard; `code` param constrained to `ErrorCode`.
- Keep `ErrorResponseSchema` exported with a `@deprecated` tag.

**Tests (mirroring the packages' existing conventions)**

- Round-trip (invariant 4): each subclass `toWire()` → `parse()` → `decodeApiError()`.
- Status mapping: each `ErrorType` → expected status.
- Enum parity (invariant 2): api-types enum `≡` core union.
- `expose=false`: `InternalError.toWire()` emits the generic message.
- Lenient decode (invariant 5): unknown `code` and unknown `type` degrade, don't throw.
- Schema: valid envelope parses; malformed (`error` missing, `code` non-string) rejects.

**Definition of done for Phase 1**

- `bun run check` (root lint/format/type) passes with the new modules.
- `bun test` passes, including the anti-drift tests.
- `workers/mcp` still type-checks (`npx tsc --noEmit`) — confirm MCP's zod pin is
  untouched (it imports only the zod-free `core` taxonomy).
- No producer or consumer behavior changed (additive-only); `ErrorResponseSchema`
  still exported.

## Testing strategy (whole epic)

- **Phase 1:** unit tests as above.
- **Phase 2:** `workers/api` tests assert the envelope **body shape** (not just
  status) for a representative expected error, a zod-validation error, and a forced
  unexpected throw; assert `logEvent` fired. Adds the body-shape assertions the
  current suite lacks (it mostly asserts `res.status`).
- **Phase 3:** per-route-file, existing route tests updated to assert the envelope.
- **Phase 4:** web decode tests; CLI decode tests in its own repo.

## Risks & mitigations

- **Breaking the `{ error: string }` readers.** Phase 2 centralizes production;
  Phase 4 centralizes consumption; the deprecated alias bridges 2→3. Sequence,
  don't flag-day. Pre-V1 timing keeps the blast radius in-house.
- **Status regressions during Phase 3** (a site that returned 400 now maps
  elsewhere via `type`). Per-file migration with tests; the status map is explicit
  and reviewed.
- **MCP zod-pin regression.** Guarded by keeping MCP on the zod-free `core` path
  and by the Phase 1 DoD `tsc` check on `workers/mcp`.
- **Cross-repo CLI skew.** Tamed by invariant 5 (lenient decode) + api-types
  co-bump discipline. Pre-existing, not introduced here.
- **Scope creep into `throw new Error(...)` invariants.** Out of scope — assertions
  with no HTTP semantics.

## Out of scope

- Rewriting `logEvent` / observability plumbing (we integrate, not replace).
- The React-invariant / config-assertion `throw new Error(...)` sites.
- Changing MCP's output _format_ (it stays model-readable text; only the taxonomy
  is shared).
- OAuth token-endpoint RFC 6749 `WWW-Authenticate` semantics — separate from JSON
  API error bodies, untouched.

## Open questions (for planning, not blocking)

1. **Exact starting subclass + `code` registry.** The lists above are a first cut;
   finalize `ERROR_CODES` against the real status/`code` values across the ~486
   sites during Phase 1, refining in Phase 3 scoping.
2. **`respondError(c, err)` vs. `throw`.** Both are supported; the Phase 3 plan
   picks a default per route-file (throw-and-catch reads cleaner but a few
   streaming/early-return sites may prefer the explicit helper).
3. **Should `details` be typed per-`code`?** A discriminated `details` map is more
   precise but reintroduces the strict-union coupling we rejected for `code`. Lean:
   keep `details: unknown` on the wire, expose typed accessors per subclass in `lib`
   for producers. Decide in the Phase 1 plan.
