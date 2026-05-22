import { describe, it, expect } from "bun:test";
import { getSecret, getSecretWithFallback } from "./secrets";

function makeBinding(value: string): { get(): Promise<string> } {
  let callCount = 0;
  return {
    get() {
      callCount += 1;
      return Promise.resolve(value);
    },
    get callCount() {
      return callCount;
    },
  } as any;
}

function makeFailingBinding(failTimes: number, value: string): { get(): Promise<string> } {
  let callCount = 0;
  return {
    get() {
      callCount += 1;
      if (callCount <= failTimes) {
        return Promise.reject(new Error(`transient error ${callCount}`));
      }
      return Promise.resolve(value);
    },
    get callCount() {
      return callCount;
    },
  } as any;
}

function makeAlwaysFailingBinding(): { get(): Promise<string> } {
  return {
    get() {
      return Promise.reject(new Error("Secrets Worker: Failed to fetch secret"));
    },
  };
}

describe("getSecret", () => {
  it("returns null when binding is undefined", async () => {
    expect(await getSecret(undefined)).toBeNull();
  });

  it("resolves the secret value on first call", async () => {
    const binding = makeBinding("my-secret");
    expect(await getSecret(binding)).toBe("my-secret");
  });

  it("returns cached value on second call without calling .get() again", async () => {
    const binding = makeBinding("cached-secret");
    await getSecret(binding);
    await getSecret(binding);
    // callCount should be 1 — the second call hits the cache
    expect((binding as any).callCount).toBe(1);
  });

  it("retries once on transient failure and succeeds", async () => {
    const binding = makeFailingBinding(1, "retry-secret");
    const result = await getSecret(binding);
    expect(result).toBe("retry-secret");
    expect((binding as any).callCount).toBe(2);
  });

  it("throws when both attempts fail", async () => {
    const binding = makeAlwaysFailingBinding();
    await expect(getSecret(binding)).rejects.toThrow("Failed to resolve secret after 2 attempts");
  });
});

describe("getSecretWithFallback", () => {
  it("returns the primary value and never reads the fallback when primary is non-empty", async () => {
    const primary = makeBinding("primary-value");
    const fallback = makeBinding("legacy-value");
    expect(await getSecretWithFallback(primary, fallback)).toBe("primary-value");
    expect((fallback as any).callCount).toBe(0);
  });

  it("falls back to the legacy value when the primary binding is undefined", async () => {
    const fallback = makeBinding("legacy-value");
    expect(await getSecretWithFallback(undefined, fallback)).toBe("legacy-value");
  });

  it("falls back to the legacy value when the primary resolves to null", async () => {
    const primary = makeBinding(null as unknown as string);
    const fallback = makeBinding("legacy-value");
    expect(await getSecretWithFallback(primary, fallback)).toBe("legacy-value");
  });

  it("falls back to the legacy value when the primary resolves to an empty string", async () => {
    // Migration-safe: an unset/empty new secret must not shadow the legacy one.
    const primary = makeBinding("");
    const fallback = makeBinding("legacy-value");
    expect(await getSecretWithFallback(primary, fallback)).toBe("legacy-value");
  });

  it("returns null when neither binding yields a value", async () => {
    expect(await getSecretWithFallback(undefined, undefined)).toBeNull();
  });
});
