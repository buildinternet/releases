import { describe, it, expect } from "bun:test";
import { checkSpendCap, incrementKvSpend } from "../../workers/discovery/src/spend-cap.js";

/**
 * Unit tests for the KV-backed daily spend circuit breaker.
 * Issue #1055.
 */

/** Minimal KV mock that stores values in a Map. */
function makeKvMock(initial: Record<string, string> = {}): KVNamespace {
  const store = new Map(Object.entries(initial));
  return {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string) {
      store.set(key, value);
    },
    async delete(key: string) {
      store.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true, cursor: "" };
    },
    async getWithMetadata(key: string) {
      const value = store.get(key) ?? null;
      return { value, metadata: null };
    },
  } as unknown as KVNamespace;
}

const TODAY = new Date().toISOString().slice(0, 10);

describe("checkSpendCap", () => {
  it("returns blocked=false when counters are below caps", async () => {
    const kv = makeKvMock({
      [`ma:spend:global:${TODAY}`]: "100",
      [`ma:spend:org:org_abc:${TODAY}`]: "50",
    });
    const result = await checkSpendCap(kv, "org_abc", {});
    expect(result.blocked).toBe(false);
  });

  it("blocks on org cap when org counter >= org cap", async () => {
    const kv = makeKvMock({
      [`ma:spend:global:${TODAY}`]: "100",
      [`ma:spend:org:org_abc:${TODAY}`]: "200",
    });
    const result = await checkSpendCap(kv, "org_abc", {
      MA_DAILY_SPEND_CAP_ORG_CENTS: "200",
    });
    expect(result.blocked).toBe(true);
    if (!result.blocked) throw new Error("unreachable");
    expect(result.scope).toBe("org");
    expect(result.currentCents).toBe(200);
    expect(result.capCents).toBe(200);
  });

  it("blocks on global cap when global counter >= global cap", async () => {
    const kv = makeKvMock({
      [`ma:spend:global:${TODAY}`]: "1500",
    });
    const result = await checkSpendCap(kv, undefined, {
      MA_DAILY_SPEND_CAP_GLOBAL_CENTS: "1500",
    });
    expect(result.blocked).toBe(true);
    if (!result.blocked) throw new Error("unreachable");
    expect(result.scope).toBe("global");
    expect(result.currentCents).toBe(1500);
    expect(result.capCents).toBe(1500);
  });

  it("prefers org scope over global when both are exceeded", async () => {
    // Both at or above their respective caps — org should be reported first.
    const kv = makeKvMock({
      [`ma:spend:global:${TODAY}`]: "9999",
      [`ma:spend:org:org_xyz:${TODAY}`]: "500",
    });
    const result = await checkSpendCap(kv, "org_xyz", {
      MA_DAILY_SPEND_CAP_ORG_CENTS: "200",
      MA_DAILY_SPEND_CAP_GLOBAL_CENTS: "1500",
    });
    expect(result.blocked).toBe(true);
    if (!result.blocked) throw new Error("unreachable");
    expect(result.scope).toBe("org");
  });

  it("uses default caps (200 org, 1500 global) when env overrides are absent", async () => {
    const kv = makeKvMock({
      [`ma:spend:global:${TODAY}`]: "1500",
    });
    const result = await checkSpendCap(kv, undefined, {});
    expect(result.blocked).toBe(true);
    if (!result.blocked) throw new Error("unreachable");
    expect(result.capCents).toBe(1500);
  });

  it("skips org cap check when orgId is undefined", async () => {
    // Global is below cap; without orgId there's nothing to block on.
    const kv = makeKvMock({
      [`ma:spend:global:${TODAY}`]: "100",
    });
    const result = await checkSpendCap(kv, undefined, {
      MA_DAILY_SPEND_CAP_ORG_CENTS: "1", // tiny org cap, but no orgId supplied
    });
    expect(result.blocked).toBe(false);
  });

  it("returns blocked=false (fail-open) when KV throws", async () => {
    const brokenKv = {
      async get() {
        throw new Error("KV unavailable");
      },
      async put() {},
      async delete() {},
      async list() {
        return { keys: [], list_complete: true, cursor: "" };
      },
      async getWithMetadata() {
        return { value: null, metadata: null };
      },
    } as unknown as KVNamespace;

    const result = await checkSpendCap(brokenKv, "org_abc", {});
    expect(result.blocked).toBe(false);
  });
});

describe("incrementKvSpend", () => {
  it("creates the key with the initial value when absent", async () => {
    const kv = makeKvMock();
    await incrementKvSpend(kv, "ma:spend:global:2099-01-01", 150, 3600);
    expect(await kv.get("ma:spend:global:2099-01-01")).toBe("150");
  });

  it("accumulates across multiple increments", async () => {
    const kv = makeKvMock({ "ma:spend:global:2099-01-01": "100" });
    await incrementKvSpend(kv, "ma:spend:global:2099-01-01", 50, 3600);
    expect(await kv.get("ma:spend:global:2099-01-01")).toBe("150");
    await incrementKvSpend(kv, "ma:spend:global:2099-01-01", 25, 3600);
    expect(await kv.get("ma:spend:global:2099-01-01")).toBe("175");
  });
});
