import { describe, it, expect } from "bun:test";
import {
  classifyMaRateLimitError,
  buildMaRateLimitErrorMessage,
} from "../../workers/discovery/src/managed-agents-session";

interface SdkLikeError extends Error {
  status?: number;
  type?: string;
  error?: unknown;
  headers?: { get(name: string): string | null };
}

function makeSdkError(
  status: number,
  opts: {
    type?: string;
    errorBody?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {},
): SdkLikeError {
  const err = new Error(`${status} mock error`) as SdkLikeError;
  err.status = status;
  if (opts.type !== undefined) err.type = opts.type;
  if (opts.errorBody !== undefined) err.error = opts.errorBody;
  if (opts.headers) {
    const h = opts.headers;
    err.headers = {
      get: (name: string) => h[name] ?? h[name.toLowerCase()] ?? null,
    };
  }
  return err;
}

const NO_JITTER = { getJitterMs: () => 0 };

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
    expect(classifyMaRateLimitError(new Error("generic failure")).isRateLimit).toBe(false);
  });

  it("classifies a 429 as a rate limit", () => {
    const err = makeSdkError(429, { type: "rate_limit_error" });
    const result = classifyMaRateLimitError(err, NO_JITTER);
    expect(result.isRateLimit).toBe(true);
    expect(result.errorType).toBe("rate_limit_error");
  });

  it("falls back to nested .error.error.type when .type is absent", () => {
    const err = makeSdkError(429, {
      errorBody: { error: { type: "rate_limit_error", message: "Type 2b rate limited." } },
    });
    const result = classifyMaRateLimitError(err, NO_JITTER);
    expect(result.isRateLimit).toBe(true);
    expect(result.errorType).toBe("rate_limit_error");
  });

  it("uses default retry-after (60s) when no Retry-After header is present", () => {
    const err = makeSdkError(429, { type: "rate_limit_error" });
    expect(classifyMaRateLimitError(err, NO_JITTER).retryAfterMs).toBe(60_000);
  });

  it("parses Retry-After header (integer seconds)", () => {
    const err = makeSdkError(429, {
      type: "rate_limit_error",
      headers: { "retry-after": "120" },
    });
    expect(classifyMaRateLimitError(err, NO_JITTER).retryAfterMs).toBe(120_000);
  });

  it("ignores a non-numeric Retry-After header and uses default", () => {
    const err = makeSdkError(429, {
      type: "rate_limit_error",
      headers: { "retry-after": "Thu, 01 Jan 2099 00:00:00 GMT" },
    });
    expect(classifyMaRateLimitError(err, NO_JITTER).retryAfterMs).toBe(60_000);
  });

  it("adds the injected jitter to the retry-after delay", () => {
    const err = makeSdkError(429, { type: "rate_limit_error" });
    const result = classifyMaRateLimitError(err, { getJitterMs: () => 5_000 });
    expect(result.retryAfterMs).toBe(65_000);
  });

  it("returns retryAfterMs=0 when isRateLimit is false", () => {
    expect(classifyMaRateLimitError(makeSdkError(500)).retryAfterMs).toBe(0);
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
