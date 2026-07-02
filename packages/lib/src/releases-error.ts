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

/**
 * Default `code` per category, used when `opts.code` is absent (e.g. a direct
 * `new ReleasesError(type, ...)`). Every value is a real `ERROR_CODES` member and
 * matches the canonical code its subclass supplies — so the base class can never
 * serialize a bare `type` string (e.g. `"validation"`) that isn't a valid code.
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
    this.code = opts.code ?? DEFAULT_CODE_BY_TYPE[type];
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
    super("upstream", message, { code: "upstream_error", ...opts, expose: false });
  }
}

export class ServiceUnavailableError extends ReleasesError {
  constructor(message = "Service unavailable", opts: ReleasesErrorOptions = {}) {
    super("unavailable", message, { code: "service_unavailable", ...opts });
  }
}

export class InternalError extends ReleasesError {
  constructor(message = "Internal server error", opts: ReleasesErrorOptions = {}) {
    super("internal", message, { code: "internal_error", ...opts, expose: false });
  }
}
