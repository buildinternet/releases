import { describe, it, expect } from "bun:test";
import { DO_ARM_ATTEMPTS, isErrorRetryable, withDoRetry } from "./do-retry.js";

function withFlags(message: string, flags: { retryable?: boolean; overloaded?: boolean }): Error {
  return Object.assign(new Error(message), flags);
}

describe("isErrorRetryable", () => {
  it("accepts retryable, rejects overloaded and plain errors", () => {
    expect(isErrorRetryable(withFlags("ok", { retryable: true }))).toBe(true);
    expect(
      isErrorRetryable(
        withFlags("Durable Object is overloaded", { retryable: true, overloaded: true }),
      ),
    ).toBe(false);
    expect(isErrorRetryable(withFlags("Durable Object is overloaded", { retryable: true }))).toBe(
      false,
    );
    expect(isErrorRetryable(new Error("nope"))).toBe(false);
    expect(isErrorRetryable(null)).toBe(false);
  });
});

describe("withDoRetry", () => {
  it("returns on success, including after a transient failure", async () => {
    let attempts = 0;
    const result = await withDoRetry(async () => {
      attempts++;
      if (attempts === 1) throw withFlags("blip", { retryable: true });
      return "ok";
    });
    expect(result).toBe("ok");
    expect(attempts).toBe(2);
  });

  it("does not retry non-retryable or overloaded errors", async () => {
    let permanent = 0;
    await expect(
      withDoRetry(async () => {
        permanent++;
        throw new Error("permanent");
      }),
    ).rejects.toThrow("permanent");
    expect(permanent).toBe(1);

    let overloaded = 0;
    await expect(
      withDoRetry(async () => {
        overloaded++;
        throw withFlags("Durable Object is overloaded", {
          retryable: true,
          overloaded: true,
        });
      }),
    ).rejects.toThrow(/overloaded/);
    expect(overloaded).toBe(1);
  });

  it("exhausts the arming attempt budget on persistent retryable errors", async () => {
    let attempts = 0;
    await expect(
      withDoRetry(async () => {
        attempts++;
        throw withFlags("still broken", { retryable: true });
      }),
    ).rejects.toThrow("still broken");
    expect(attempts).toBe(DO_ARM_ATTEMPTS);
  });
});
