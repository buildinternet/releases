import { describe, it, expect } from "bun:test";
import {
  classifyMaRateLimitError,
  buildMaRateLimitErrorMessage,
} from "../../workers/discovery/src/managed-agents-session";

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fabricates a minimal Anthropic SDK-style error with the given status and
 * optional headers / error body. We do not import the real SDK in tests to
 * avoid live API calls; the classifier only needs duck-typed access to
 * `.status`, `.type`, `.error`, and `.headers`.
 */
function makeSdkError(
  status: number,
  opts: {
    type?: string;
    errorBody?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): Error {
  const err = new Error(`${status} mock error`) as any;
  err.status = status;
  if (opts.type !== undefined) err.type = opts.type;
  if (opts.errorBody !== undefined) err.error = opts.errorBody;
  if (opts.headers) {
    err.headers = {
      get: (name: string) =>
        opts.headers![name] ?? opts.headers![name.toLowerCase()] ?? null,
    };
  }
  return err as Error;
}

// ── classifyMaRateLimitError ──────────────────────────────────────────────────

describe("classifyMaRateLimitError", () => {
  it("returns isRateLimit=false for non-Error values", () => {
    expect(classifyMaRateLimitError("string error").isRateLimit).toBe(false);
    expect(classifyMaRateLimitError(null).isRateLimit).toBe(false);
    expect(classifyMaRateLimitError(undefined).isRateLimit).toBe(false);
    expect(classifyMaRateLimitError(429).isRateLimit).toBe(false);
  });

  it("returns isRateLimit=false for non-429 HTTP errors", () => {
    expect(classifyMaRateLimitError(makeSdkError(401)).isRateLimit).toBe(false);
    expect(classifyMaRateLimitError(makeSdkError(500)).isRateLimit).toBe(false);
    expect(classifyMaRateLimitError(makeSdkError(503)).isRateLimit).toBe(false);
  });

  it("returns isRateLimit=false for plain Errors without .status", () => {
    const plain = new Error("generic failure");
    expect(classifyMaRateLimitError(plain).isRateLimit).toBe(false);
  });

  it("classifies a 429 as a rate limit", () => {
    const err = makeSdkError(429, { type: "rate_limit_error" });
    const result = classifyMaRateLimitError(err, { fixedJitterS: 0 });
    expect(result.isRateLimit).toBe(true);
    expect(result.errorType).toBe("rate_limit_error");
  });

  it("extracts errorType from .type on the error object", () => {
    const err = makeSdkError(429, { type: "rate_limit_error" });
    const result = classifyMaRateLimitError(err, { fixedJitterS: 0 });
    expect(result.errorType).toBe("rate_limit_error");
  });

  it("falls back to nested .error.error.type when .type is absent", () => {
    const err = makeSdkError(429, {
      errorBody: { error: { type: "rate_limit_error", message: "Type 2b rate limited." } },
    });
    const result = classifyMaRateLimitError(err, { fixedJitterS: 0 });
    expect(result.isRateLimit).toBe(true);
    expect(result.errorType).toBe("rate_limit_error");
  });

  it("uses default retry-after (60s) when no Retry-After header is present", () => {
    const err = makeSdkError(429, { type: "rate_limit_error" });
    const result = classifyMaRateLimitError(err, { fixedJitterS: 0 });
    // default 60s + 0 jitter = 60_000ms
    expect(result.retryAfterMs).toBe(60_000);
  });

  it("parses Retry-After header (integer seconds)", () => {
    const err = makeSdkError(429, {
      type: "rate_limit_error",
      headers: { "retry-after": "120" },
    });
    const result = classifyMaRateLimitError(err, { fixedJitterS: 0 });
    expect(result.retryAfterMs).toBe(120_000);
  });

  it("ignores a non-numeric Retry-After header and uses default", () => {
    const err = makeSdkError(429, {
      type: "rate_limit_error",
      headers: { "retry-after": "Thu, 01 Jan 2099 00:00:00 GMT" },
    });
    const result = classifyMaRateLimitError(err, { fixedJitterS: 0 });
    expect(result.retryAfterMs).toBe(60_000);
  });

  it("adds jitter to the retry-after delay", () => {
    const err = makeSdkError(429, { type: "rate_limit_error" });
    const result = classifyMaRateLimitError(err, { fixedJitterS: 5 });
    // 60s default + 5s jitter = 65_000ms
    expect(result.retryAfterMs).toBe(65_000);
  });

  it("respects a custom defaultRetryAfterS option", () => {
    const err = makeSdkError(429, { type: "rate_limit_error" });
    const result = classifyMaRateLimitError(err, { defaultRetryAfterS: 30, fixedJitterS: 0 });
    expect(result.retryAfterMs).toBe(30_000);
  });

  it("returns retryAfterMs=0 when isRateLimit is false", () => {
    expect(classifyMaRateLimitError(makeSdkError(500)).retryAfterMs).toBe(0);
  });
});

// ── buildMaRateLimitErrorMessage ──────────────────────────────────────────────

describe("buildMaRateLimitErrorMessage", () => {
  it("includes the error type in parentheses when present", () => {
    const classification = { isRateLimit: true, errorType: "rate_limit_error", retryAfterMs: 60_000 };
    const msg = buildMaRateLimitErrorMessage(classification, 2);
    expect(msg).toContain("(rate_limit_error)");
  });

  it("omits the error-type parenthetical when errorType is absent", () => {
    const classification = { isRateLimit: true, retryAfterMs: 60_000 };
    const msg = buildMaRateLimitErrorMessage(classification, 1);
    // "Anthropic managed-agents rate limit. Retry after 60s. ..."
    // Should not start with "(..." immediately after the prefix
    expect(msg).not.toContain("rate limit (");
  });

  it("includes retry-after seconds (rounded)", () => {
    const classification = { isRateLimit: true, retryAfterMs: 65_400 };
    const msg = buildMaRateLimitErrorMessage(classification, 0);
    // 65_400ms → 65s
    expect(msg).toContain("65s");
  });

  it("includes the retry count", () => {
    const classification = { isRateLimit: true, retryAfterMs: 60_000 };
    expect(buildMaRateLimitErrorMessage(classification, 0)).toContain("retried 0 time(s)");
    expect(buildMaRateLimitErrorMessage(classification, 2)).toContain("retried 2 time(s)");
  });

  it("produces a parseable prefix for the incident case (Type 2b)", () => {
    const classification = {
      isRateLimit: true,
      errorType: "rate_limit_error",
      retryAfterMs: 1020 * 1000, // 17 min
    };
    const msg = buildMaRateLimitErrorMessage(classification, 2);
    expect(msg).toMatch(/^Anthropic managed-agents rate limit/);
    expect(msg).toContain("(rate_limit_error)");
    expect(msg).toContain("1020s");
    expect(msg).toContain("retried 2 time(s)");
  });
});
