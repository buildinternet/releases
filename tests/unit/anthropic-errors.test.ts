import { describe, it, expect } from "bun:test";
import {
  APIConnectionError,
  APIError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  PermissionDeniedError,
  RateLimitError,
} from "@anthropic-ai/sdk";
import { classifyAnthropicError } from "../../packages/lib/src/anthropic-errors";

function makeBody(type: string) {
  return { type: "error" as const, error: { type, message: `${type} mock` } };
}

describe("classifyAnthropicError", () => {
  it("returns kind=other for non-SDK values", () => {
    expect(classifyAnthropicError("string")).toEqual({ kind: "other" });
    expect(classifyAnthropicError(null)).toEqual({ kind: "other" });
    expect(classifyAnthropicError(undefined)).toEqual({ kind: "other" });
    expect(classifyAnthropicError(new Error("generic"))).toEqual({ kind: "other" });
  });

  it("classifies AuthenticationError as auth", () => {
    const err = new AuthenticationError(
      401,
      makeBody("authentication_error"),
      undefined,
      new Headers(),
      "authentication_error",
    );
    expect(classifyAnthropicError(err)).toEqual({
      kind: "auth",
      status: 401,
      errorType: "authentication_error",
    });
  });

  it("classifies PermissionDeniedError as auth", () => {
    const err = new PermissionDeniedError(
      403,
      makeBody("permission_error"),
      undefined,
      new Headers(),
      "permission_error",
    );
    expect(classifyAnthropicError(err).kind).toBe("auth");
  });

  it("classifies 402 as credits regardless of error.type", () => {
    const err = APIError.generate(402, makeBody("api_error"), undefined, new Headers());
    expect(classifyAnthropicError(err)).toMatchObject({ kind: "credits", status: 402 });
  });

  it("classifies 429 + credit_balance_too_low as credits (not rate_limit)", () => {
    const err = new RateLimitError(
      429,
      makeBody("credit_balance_too_low"),
      undefined,
      new Headers(),
      "credit_balance_too_low" as never,
    );
    expect(classifyAnthropicError(err).kind).toBe("credits");
  });

  it("classifies 400 BadRequestError + credit_balance_too_low as credits", () => {
    const err = new BadRequestError(
      400,
      makeBody("credit_balance_too_low"),
      undefined,
      new Headers(),
      "credit_balance_too_low" as never,
    );
    expect(classifyAnthropicError(err).kind).toBe("credits");
  });

  it("classifies RateLimitError as rate_limit and reads Retry-After header", () => {
    const err = new RateLimitError(
      429,
      makeBody("rate_limit_error"),
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
    const err = new RateLimitError(
      429,
      makeBody("rate_limit_error"),
      undefined,
      new Headers(),
      "rate_limit_error",
    );
    const result = classifyAnthropicError(err);
    expect(result.kind).toBe("rate_limit");
    expect(result.retryAfterMs).toBeUndefined();
  });

  it("ignores non-numeric Retry-After", () => {
    const err = new RateLimitError(
      429,
      makeBody("rate_limit_error"),
      undefined,
      new Headers({ "retry-after": "Thu, 01 Jan 2099 00:00:00 GMT" }),
      "rate_limit_error",
    );
    expect(classifyAnthropicError(err).retryAfterMs).toBeUndefined();
  });

  it("classifies BadRequestError (non-credit) as bad_request", () => {
    const err = new BadRequestError(
      400,
      makeBody("invalid_request_error"),
      undefined,
      new Headers(),
      "invalid_request_error",
    );
    expect(classifyAnthropicError(err).kind).toBe("bad_request");
  });

  it("classifies InternalServerError as server", () => {
    const err = new InternalServerError(
      503,
      makeBody("api_error"),
      undefined,
      new Headers(),
      "api_error",
    );
    expect(classifyAnthropicError(err).kind).toBe("server");
  });

  it("classifies APIConnectionError as connection", () => {
    const err = new APIConnectionError({ message: "network down" });
    expect(classifyAnthropicError(err).kind).toBe("connection");
  });
});
