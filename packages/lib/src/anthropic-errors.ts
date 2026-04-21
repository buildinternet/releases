/**
 * Shared classifier for errors thrown by `@anthropic-ai/sdk`. Callers
 * discriminate on `kind` instead of hand-rolling `instanceof` cascades
 * and body parsing. Returns `{ kind: "other" }` for anything that isn't
 * an Anthropic SDK error (plain Errors, strings, etc.).
 */

import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import type { ErrorType } from "@anthropic-ai/sdk/resources/shared";

export type AnthropicErrorKind =
  | "auth"
  | "credits"
  | "rate_limit"
  | "bad_request"
  | "server"
  | "connection"
  | "other";

export interface AnthropicErrorClassification {
  kind: AnthropicErrorKind;
  /** `error.type` from the API response body, populated by the SDK. */
  errorType?: ErrorType;
  /** HTTP status if the error carried one. */
  status?: number;
  /** Retry-After header value in ms. Only set when `kind === "rate_limit"` and the header parsed as a positive integer. */
  retryAfterMs?: number;
}

/** Anthropic returns this `error.type` when the account is out of credits. It is not in the typed `ErrorType` union. */
const CREDIT_BALANCE_TOO_LOW = "credit_balance_too_low";

export function classifyAnthropicError(err: unknown): AnthropicErrorClassification {
  if (!(err instanceof APIError)) return { kind: "other" };

  const status = typeof err.status === "number" ? err.status : undefined;
  const errorType = err.type ?? undefined;

  // Credit exhaustion can surface as 402 or as a 429/400 carrying the
  // `credit_balance_too_low` error.type. Classify all three as "credits"
  // so callers don't retry what is really a billing problem.
  // `CREDIT_BALANCE_TOO_LOW` isn't in the SDK's `ErrorType` union, but the
  // server still returns it; widen for the comparison.
  if (status === 402 || (err.type as string | null) === CREDIT_BALANCE_TOO_LOW) {
    return { kind: "credits", status, errorType };
  }

  if (err instanceof AuthenticationError || err instanceof PermissionDeniedError) {
    return { kind: "auth", status, errorType };
  }
  if (err instanceof RateLimitError) {
    return {
      kind: "rate_limit",
      status,
      errorType,
      retryAfterMs: readRetryAfterMs(err.headers),
    };
  }
  if (err instanceof BadRequestError) {
    return { kind: "bad_request", status, errorType };
  }
  if (err instanceof InternalServerError) {
    return { kind: "server", status, errorType };
  }
  if (err instanceof APIConnectionError) {
    return { kind: "connection", errorType };
  }
  return { kind: "other", status, errorType };
}

function readRetryAfterMs(headers: Headers | undefined): number | undefined {
  const raw = headers?.get("retry-after");
  if (!raw) return undefined;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed * 1000 : undefined;
}

/**
 * Default HTTP status mapping for a failed Anthropic call: upstream-ish
 * failures (rate limits, server/connection errors, auth/credit issues) map
 * to 502 Bad Gateway; anything else we blame on ourselves with 500.
 */
export function anthropicErrorHttpStatus(kind: AnthropicErrorKind): 502 | 500 {
  switch (kind) {
    case "rate_limit":
    case "server":
    case "connection":
    case "auth":
    case "credits":
      return 502;
    default:
      return 500;
  }
}
