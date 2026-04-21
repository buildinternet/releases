import { describe, it, expect } from "bun:test";
import { classifyPreflightResponse } from "../../workers/api/src/cron/scrape-agent-sweep";
import { fakeAnthropicError } from "../anthropic-errors-helper";

describe("classifyPreflightResponse", () => {
  it("proceeds on success (null error)", () => {
    expect(classifyPreflightResponse(null)).toEqual({ action: "proceed" });
  });

  it("aborts on 401 AuthenticationError with anthropic_auth", () => {
    expect(classifyPreflightResponse(fakeAnthropicError(401, "authentication_error"))).toEqual({
      action: "abort",
      abortReason: "anthropic_auth",
    });
  });

  it("aborts on 403 PermissionDeniedError with anthropic_auth", () => {
    expect(classifyPreflightResponse(fakeAnthropicError(403, "permission_error"))).toEqual({
      action: "abort",
      abortReason: "anthropic_auth",
    });
  });

  it("aborts on 402 with anthropic_credits", () => {
    expect(classifyPreflightResponse(fakeAnthropicError(402))).toEqual({
      action: "abort",
      abortReason: "anthropic_credits",
    });
  });

  it("aborts on 429 RateLimitError with credit_balance_too_low", () => {
    expect(classifyPreflightResponse(fakeAnthropicError(429, "credit_balance_too_low"))).toEqual({
      action: "abort",
      abortReason: "anthropic_credits",
    });
  });

  it("aborts on 400 BadRequestError with credit_balance_too_low", () => {
    // Some plans surface credit exhaustion as 400 instead of 429.
    expect(classifyPreflightResponse(fakeAnthropicError(400, "credit_balance_too_low"))).toEqual({
      action: "abort",
      abortReason: "anthropic_credits",
    });
  });

  it("warns on 429 RateLimitError with rate_limit_error", () => {
    expect(classifyPreflightResponse(fakeAnthropicError(429, "rate_limit_error"))).toEqual({
      action: "warn",
    });
  });

  it("warns on 500 InternalServerError", () => {
    expect(classifyPreflightResponse(fakeAnthropicError(503, "api_error"))).toEqual({
      action: "warn",
    });
  });

  it("warns on non-SDK errors (connection errors, plain Errors, etc.)", () => {
    expect(classifyPreflightResponse(new Error("network down"))).toEqual({ action: "warn" });
    expect(classifyPreflightResponse("string error")).toEqual({ action: "warn" });
  });
});
