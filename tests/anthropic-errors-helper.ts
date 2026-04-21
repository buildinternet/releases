import { APIError } from "@anthropic-ai/sdk";

/**
 * Construct a real SDK error with a typed body, mirroring what
 * `@anthropic-ai/sdk` produces when the server returns an error response.
 * `APIError.generate` picks the right subclass from `status`
 * (AuthenticationError, RateLimitError, BadRequestError, etc.).
 */
export function fakeAnthropicError(status: number, errorType?: string): APIError {
  const body = errorType
    ? { type: "error" as const, error: { type: errorType, message: `${errorType} mock` } }
    : undefined;
  return APIError.generate(status, body, undefined, new Headers());
}
