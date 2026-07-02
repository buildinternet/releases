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
