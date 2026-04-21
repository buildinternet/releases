import { describe, it, expect } from "bun:test";
import { APIError } from "@anthropic-ai/sdk";
import { classifyPreflightResponse } from "../../workers/api/src/cron/scrape-agent-sweep";

function anthropicError(status: number, errorType?: string): APIError {
  const body = errorType
    ? { type: "error" as const, error: { type: errorType, message: `${errorType} mock` } }
    : undefined;
  return APIError.generate(status, body, undefined, new Headers());
}

describe("classifyPreflightResponse", () => {
  it("proceeds on success (null error)", () => {
    expect(classifyPreflightResponse(null)).toEqual({ action: "proceed" });
  });

  it("aborts on 401 AuthenticationError with anthropic_auth", () => {
    expect(classifyPreflightResponse(anthropicError(401, "authentication_error"))).toEqual({
      action: "abort",
      abortReason: "anthropic_auth",
    });
  });

  it("aborts on 403 PermissionDeniedError with anthropic_auth", () => {
    expect(classifyPreflightResponse(anthropicError(403, "permission_error"))).toEqual({
      action: "abort",
      abortReason: "anthropic_auth",
    });
  });

  it("aborts on 402 with anthropic_credits", () => {
    expect(classifyPreflightResponse(anthropicError(402))).toEqual({
      action: "abort",
      abortReason: "anthropic_credits",
    });
  });

  it("aborts on 429 RateLimitError with credit_balance_too_low", () => {
    expect(classifyPreflightResponse(anthropicError(429, "credit_balance_too_low"))).toEqual({
      action: "abort",
      abortReason: "anthropic_credits",
    });
  });

  it("aborts on 400 BadRequestError with credit_balance_too_low", () => {
    // Some plans surface credit exhaustion as 400 instead of 429.
    expect(classifyPreflightResponse(anthropicError(400, "credit_balance_too_low"))).toEqual({
      action: "abort",
      abortReason: "anthropic_credits",
    });
  });

  it("warns on 429 RateLimitError with rate_limit_error", () => {
    expect(classifyPreflightResponse(anthropicError(429, "rate_limit_error"))).toEqual({
      action: "warn",
    });
  });

  it("warns on 500 InternalServerError", () => {
    expect(classifyPreflightResponse(anthropicError(503, "api_error"))).toEqual({ action: "warn" });
  });

  it("warns on non-SDK errors (connection errors, plain Errors, etc.)", () => {
    expect(classifyPreflightResponse(new Error("network down"))).toEqual({ action: "warn" });
    expect(classifyPreflightResponse("string error")).toEqual({ action: "warn" });
  });
});
