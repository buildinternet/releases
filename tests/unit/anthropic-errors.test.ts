import { describe, it, expect } from "bun:test";
import {
  APIConnectionError,
  AuthenticationError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import {
  anthropicErrorHttpStatus,
  classifyAnthropicError,
} from "../../packages/lib/src/anthropic-errors";
import { fakeAnthropicError } from "../anthropic-errors-helper";

describe("classifyAnthropicError", () => {
  it("returns kind=other for non-SDK values", () => {
    expect(classifyAnthropicError("string")).toEqual({ kind: "other" });
    expect(classifyAnthropicError(null)).toEqual({ kind: "other" });
    expect(classifyAnthropicError(undefined)).toEqual({ kind: "other" });
    expect(classifyAnthropicError(new Error("generic"))).toEqual({ kind: "other" });
  });

  it("classifies AuthenticationError as auth", () => {
    const err = fakeAnthropicError(401, "authentication_error");
    expect(err).toBeInstanceOf(AuthenticationError);
    expect(classifyAnthropicError(err)).toEqual({
      kind: "auth",
      status: 401,
      errorType: "authentication_error",
    });
  });

  it("classifies PermissionDeniedError as auth", () => {
    const err = fakeAnthropicError(403, "permission_error");
    expect(err).toBeInstanceOf(PermissionDeniedError);
    expect(classifyAnthropicError(err).kind).toBe("auth");
  });

  it("classifies 402 as credits regardless of error.type", () => {
    expect(classifyAnthropicError(fakeAnthropicError(402, "api_error"))).toMatchObject({
      kind: "credits",
      status: 402,
    });
  });

  it("classifies 429 + credit_balance_too_low as credits (not rate_limit)", () => {
    expect(classifyAnthropicError(fakeAnthropicError(429, "credit_balance_too_low")).kind).toBe(
      "credits",
    );
  });

  it("classifies 400 BadRequestError + credit_balance_too_low as credits", () => {
    expect(classifyAnthropicError(fakeAnthropicError(400, "credit_balance_too_low")).kind).toBe(
      "credits",
    );
  });

  it("classifies RateLimitError as rate_limit and reads Retry-After header", () => {
    // Use a direct constructor to attach the Retry-After header.
    const err = new RateLimitError(
      429,
      { type: "error" as const, error: { type: "rate_limit_error", message: "mock" } },
      undefined,
      new Headers({ "retry-after": "30" }),
      "rate_limit_error",
    );
    expect(classifyAnthropicError(err)).toEqual({
      kind: "rate_limit",
      status: 429,
      errorType: "rate_limit_error",
      retryAfterMs: 30_000,
    });
  });

  it("omits retryAfterMs when Retry-After is missing", () => {
    const result = classifyAnthropicError(fakeAnthropicError(429, "rate_limit_error"));
    expect(result.kind).toBe("rate_limit");
    expect(result.retryAfterMs).toBeUndefined();
  });

  it("ignores non-numeric Retry-After", () => {
    const err = new RateLimitError(
      429,
      { type: "error" as const, error: { type: "rate_limit_error", message: "mock" } },
      undefined,
      new Headers({ "retry-after": "Thu, 01 Jan 2099 00:00:00 GMT" }),
      "rate_limit_error",
    );
    expect(classifyAnthropicError(err).retryAfterMs).toBeUndefined();
  });

  it("classifies BadRequestError (non-credit) as bad_request", () => {
    expect(classifyAnthropicError(fakeAnthropicError(400, "invalid_request_error")).kind).toBe(
      "bad_request",
    );
  });

  it("classifies InternalServerError as server", () => {
    expect(classifyAnthropicError(fakeAnthropicError(503, "api_error")).kind).toBe("server");
  });

  it("classifies APIConnectionError as connection", () => {
    const err = new APIConnectionError({ message: "network down" });
    expect(classifyAnthropicError(err).kind).toBe("connection");
  });
});

describe("anthropicErrorHttpStatus", () => {
  it.each(["rate_limit", "server", "connection", "auth", "credits"] as const)(
    "maps %s to 502",
    (kind) => {
      expect(anthropicErrorHttpStatus(kind)).toBe(502);
    },
  );

  it.each(["bad_request", "other"] as const)("maps %s to 500", (kind) => {
    expect(anthropicErrorHttpStatus(kind)).toBe(500);
  });
});
