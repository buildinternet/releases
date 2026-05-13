import { describe, it, expect } from "bun:test";
import { getSecret } from "./secrets";

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
