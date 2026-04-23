import { describe, it, expect } from "bun:test";
import {
  RateLimitError,
  APIError,
  InternalServerError,
  AuthenticationError,
} from "@anthropic-ai/sdk";
import type { ErrorType } from "@anthropic-ai/sdk/resources/shared";
import { classifyMaRateLimitError, buildMaRateLimitErrorMessage } from "./ma-rate-limit";

function makeRateLimitError(opts: { type?: ErrorType; retryAfter?: string } = {}): RateLimitError {
  const type = opts.type ?? "rate_limit_error";
  const body = { type: "error" as const, error: { type, message: `${type} mock` } };
  const headers = new Headers(opts.retryAfter ? { "retry-after": opts.retryAfter } : {});
  return new RateLimitError(429, body, "rate limit mock", headers, type);
}

const NO_JITTER = { getJitterMs: () => 0 };

describe("classifyMaRateLimitError", () => {
  it("returns isRateLimit=false for non-Error values", () => {
    expect(classifyMaRateLimitError("string error").isRateLimit).toBe(false);
    expect(classifyMaRateLimitError(null).isRateLimit).toBe(false);
    expect(classifyMaRateLimitError(undefined).isRateLimit).toBe(false);
    expect(classifyMaRateLimitError(429).isRateLimit).toBe(false);
  });

  it("returns isRateLimit=false for non-RateLimitError SDK errors", () => {
    const auth = new AuthenticationError(401, undefined, "auth", new Headers());
    const server = new InternalServerError(500, undefined, "server", new Headers());
    expect(classifyMaRateLimitError(auth).isRateLimit).toBe(false);
    expect(classifyMaRateLimitError(server).isRateLimit).toBe(false);
  });

  it("returns isRateLimit=false for plain Errors", () => {
    expect(classifyMaRateLimitError(new Error("generic failure")).isRateLimit).toBe(false);
  });

  it("classifies a RateLimitError as a rate limit and reads err.type", () => {
    const result = classifyMaRateLimitError(makeRateLimitError(), NO_JITTER);
    expect(result.isRateLimit).toBe(true);
    expect(result.errorType).toBe("rate_limit_error");
  });

  it("preserves err.type when it's a non-rate-limit ErrorType (e.g. overloaded_error)", () => {
    // RateLimitError can carry any ErrorType in err.type — the 429 status is what drives classification.
    const result = classifyMaRateLimitError(
      makeRateLimitError({ type: "overloaded_error" }),
      NO_JITTER,
    );
    expect(result.isRateLimit).toBe(true);
    expect(result.errorType).toBe("overloaded_error");
  });

  it("uses default retry-after (60s) when no Retry-After header is present", () => {
    expect(classifyMaRateLimitError(makeRateLimitError(), NO_JITTER).retryAfterMs).toBe(60_000);
  });

  it("parses Retry-After header (integer seconds)", () => {
    const err = makeRateLimitError({ retryAfter: "120" });
    expect(classifyMaRateLimitError(err, NO_JITTER).retryAfterMs).toBe(120_000);
  });

  it("ignores a non-numeric Retry-After header and uses default", () => {
    const err = makeRateLimitError({ retryAfter: "Thu, 01 Jan 2099 00:00:00 GMT" });
    expect(classifyMaRateLimitError(err, NO_JITTER).retryAfterMs).toBe(60_000);
  });

  it("adds the injected jitter to the retry-after delay", () => {
    const result = classifyMaRateLimitError(makeRateLimitError(), { getJitterMs: () => 5_000 });
    expect(result.retryAfterMs).toBe(65_000);
  });

  it("returns retryAfterMs=0 when isRateLimit is false", () => {
    const server = new InternalServerError(500, undefined, "server", new Headers());
    expect(classifyMaRateLimitError(server).retryAfterMs).toBe(0);
  });

  it("rejects a generic APIError with a non-429 status", () => {
    const apiErr = new APIError(418, undefined, "teapot", new Headers());
    expect(classifyMaRateLimitError(apiErr).isRateLimit).toBe(false);
  });
});

describe("buildMaRateLimitErrorMessage", () => {
  it("includes the error type in parentheses when present", () => {
    const msg = buildMaRateLimitErrorMessage(
      { isRateLimit: true, errorType: "rate_limit_error", retryAfterMs: 60_000 },
      2,
    );
    expect(msg).toContain("(rate_limit_error)");
  });

  it("omits the error-type parenthetical when errorType is absent", () => {
    const msg = buildMaRateLimitErrorMessage({ isRateLimit: true, retryAfterMs: 60_000 }, 1);
    expect(msg).not.toContain("rate limit (");
  });

  it("includes retry-after seconds (rounded)", () => {
    const msg = buildMaRateLimitErrorMessage({ isRateLimit: true, retryAfterMs: 65_400 }, 0);
    expect(msg).toContain("65s");
  });

  it("includes the retry count", () => {
    const classification = { isRateLimit: true, retryAfterMs: 60_000 };
    expect(buildMaRateLimitErrorMessage(classification, 0)).toContain("retried 0 time(s)");
    expect(buildMaRateLimitErrorMessage(classification, 2)).toContain("retried 2 time(s)");
  });

  it("produces a parseable message for the incident case", () => {
    const msg = buildMaRateLimitErrorMessage(
      { isRateLimit: true, errorType: "rate_limit_error", retryAfterMs: 1020 * 1000 },
      2,
    );
    expect(msg).toMatch(/^Anthropic managed-agents rate limit/);
    expect(msg).toContain("(rate_limit_error)");
    expect(msg).toContain("1020s");
    expect(msg).toContain("retried 2 time(s)");
  });
});
