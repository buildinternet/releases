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
  // Phase 3 promotions — distinct domain codes a client branches on. Each maps
  // to an existing `type` (no new ErrorType); see the Phase 3 code-mapping table.
  "instance_not_found", // not_found
  "client_not_found", // not_found
  "user_not_found", // not_found
  "snapshot_expired", // not_found (was HTTP 410; status normalizes to 404)
  "slug_reserved", // conflict
  "api_key_limit", // conflict
  "limit_exceeded", // rate_limited
  "embed_unavailable", // unavailable
  "payload_too_large", // validation (was HTTP 413; status normalizes to 400)
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Reverse of {@link STATUS_BY_TYPE}, choosing the primary type where a status is
 * shared (403 → `forbidden`, not `insufficient_scope`). Used to shape a Hono
 * `HTTPException` (whose status is preserved as-is) into an envelope `type`.
 *
 * Derived from `STATUS_BY_TYPE` in one place so a new `ErrorType`/status pair
 * stays in sync automatically. The first type to claim a status wins, so a shared
 * status resolves to the earlier (primary) type in `ERROR_TYPES` — 403 →
 * `forbidden`, not `insufficient_scope`.
 */
export const TYPE_BY_STATUS: Record<number, ErrorType> = (() => {
  const map: Record<number, ErrorType> = {};
  for (const type of ERROR_TYPES) {
    const status = STATUS_BY_TYPE[type];
    if (!(status in map)) map[status] = type;
  }
  return map;
})();

export function statusToType(status: number): ErrorType {
  return TYPE_BY_STATUS[status] ?? "internal";
}
