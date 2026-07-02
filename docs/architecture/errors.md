# Error responses

One wire shape for every non-2xx response — a nested envelope. Replaced the ~6 flat `{ error: "..." }` conventions that coexisted pre-standardization (epic #1830).

```json
{ "error": { "code": "not_found", "type": "not_found", "message": "…", "details": {} } }
```

- **`type`** — coarse category from a closed set (`ERROR_TYPES`); pins the HTTP status via `STATUS_BY_TYPE`. Status is derived from `type`, never hand-picked. This is the field clients switch on.
- **`code`** — specific, **stable** machine string (`ERROR_CODES`). Open on the wire (a new server code an old client doesn't know still parses), so producers build from the registry but consumers branch defensively.
- **`message`** — human-readable, may change. Never parsed by consumers; internal/5xx messages are genericized (never echo an upstream detail).
- **`details`** — optional structured context for select codes (e.g. `database_not_initialized` carries `setup`).

## Three-layer split (forced by the zod line + MCP's pinned zod)

- **`packages/core/src/errors.ts`** — the source of truth: `ERROR_TYPES`, `ERROR_CODES`, `STATUS_BY_TYPE`, `statusForType`/`statusToType`. Pure and **zod-free** so every surface (API, MCP, CLI, web) shares it below the zod line.
- **`packages/api-types/src/schemas/errors.ts`** — the zod wire schema `errorEnvelopeSchema` (+ per-field `.describe()` that flows into the OpenAPI/Scalar reference) and the `decodeApiError` / `isApiError` consumer helpers.
- **`packages/lib/src/releases-error.ts`** — the throwable `ReleasesError` hierarchy (`ValidationError`, `NotFoundError`, `RateLimitedError`, …); `toWire()` serializes to the envelope. `expose: false` is pinned non-overridable on `InternalError`/`UpstreamError` so a real cause can't leak.

## Producers

- **API worker** — routes `throw new <Subclass>(...)` (or `return respondError(c, err)`). `respondError` (`workers/api/src/lib/error-response.ts`) is the single boundary serializer, registered as `onError`/`notFound`. Cascade: typed `ReleasesError` → `toWire()`; `BareSlugRejected` → validation + `{entity}`; Hono `HTTPException` (status + headers preserved, fail-closed on 5xx); classified D1 error → diagnostic in `details`; else generic `InternalError` (real message logged, never sent).
- **Discovery worker** — its own envelope builder (`workers/discovery/src/error-response.ts`, same taxonomy via zod-free core).
- **MCP** — shares the zod-free taxonomy only, never the api-types zod schema (pinned-zod tripwire).

## Consumers

- **Web** — `web/src/lib/api.ts` decodes the nested envelope; the `/submit` proxy (`web/src/app/api/recommendations/route.ts`) flattens it to its local flat vocab.
- **CLI** — `releases-cli` `src/lib/errors.ts` reads `error.message`.
- Both currently **inline** an equivalent decoder rather than importing the published `decodeApiError` — the pinned api-types predates the errors module and web can't runtime-import the api-types barrel under Next's bundler (#1840).

## Adding a code

Add the string to `ERROR_CODES` in `packages/core/src/errors.ts` (map it to an existing `type` — a new code never needs a new `ErrorType`), then construct it via a `ReleasesError` subclass with `{ code }`. No migration needed (it's not DB schema). The registry is compile-checked at producer sites, so a typo is a build error.

## Known gaps

- Auth middleware/guards (`workers/api/src/middleware/auth.ts`, `auth/oauth-self-service-guard.ts`) still emit the legacy flat shape — deliberately outside Phase 3's `routes/**` scope (#1839).
- `respondError`'s `HTTPException` branch types an off-map 4xx (e.g. 422) as `internal` while preserving the status — dead surface today, zero 422 producers (#1841).

Public-facing consumer reference (types + common codes): [web `/docs/api/errors`](../../web/src/content/docs/api/errors.md). Design rationale: `docs/superpowers/specs/2026-07-02-standardized-errors-design.md`.
