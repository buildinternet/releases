/**
 * Discovery worker error envelope.
 *
 * Serializes the platform's standardized nested error envelope
 * `{ error: { code, type, message, details? } }` (the same shape the API
 * worker's `respondError` emits — see `@buildinternet/releases-core/errors` and
 * `@releases/lib/releases-error`). Kept in its own dependency-light module so
 * the envelope is unit-testable without pulling in the worker runtime
 * (`cloudflare:workers`, the Sandbox/DO exports) that `index.ts` re-exports.
 */
import { statusToType, type ErrorCode, type ErrorType } from "@buildinternet/releases-core/errors";

/**
 * Generic error code a `type` defaults to when a call site doesn't pass a more
 * specific one — mirrors the per-type codes the API worker's `ReleasesError`
 * subclasses use so both workers emit the same `code` for the same failure
 * class.
 */
const DEFAULT_CODE_BY_TYPE: Record<ErrorType, ErrorCode> = {
  validation: "validation_failed",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  insufficient_scope: "insufficient_scope",
  not_found: "not_found",
  conflict: "conflict",
  rate_limited: "rate_limited",
  upstream: "upstream_error",
  unavailable: "service_unavailable",
  internal: "internal_error",
};

/**
 * Build a JSON error `Response` carrying the nested envelope. `type` derives
 * from the HTTP `status`; `code` defaults from `type` but a call site passes a
 * distinct domain `code` where a client would branch on it (e.g. `invalid_json`
 * for a 400). Extra structured fields ride in `details`, never at the top level
 * of the body.
 */
export function errorResponse(
  message: string,
  status: number,
  extra?: {
    headers?: Record<string, string>;
    code?: ErrorCode;
    details?: Record<string, unknown>;
  },
): Response {
  const type = statusToType(status);
  const error: {
    code: ErrorCode;
    type: ErrorType;
    message: string;
    details?: Record<string, unknown>;
  } = {
    code: extra?.code ?? DEFAULT_CODE_BY_TYPE[type],
    type,
    message,
  };
  if (extra?.details) error.details = extra.details;
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", ...extra?.headers },
  });
}
