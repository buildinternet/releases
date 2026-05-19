import { describe, it, expect } from "bun:test";
import { checkSpendCap, incrementKvSpend } from "../../workers/discovery/src/spend-cap.js";

/**
 * Unit tests for the KV-backed daily spend circuit breaker.
 * Issue #1055.
 */

/**
 * Minimal KV mock. Tracks both values and TTL options so tests can verify the
 * spend counter writes carry the 26h TTL contract documented in spend-cap.ts.
 *
 * Returned via the `kv` field; the `ttls` map is exposed for test assertions.
 */
function makeKvMock(initial: Record<string, string> = {}): {
  kv: KVNamespace;
  ttls: Map<string, number>;
} {
  const store = new Map(Object.entries(initial));
  const ttls = new Map<string, number>();
  const kv = {
    async get(key: string) {
      return store.get(key) ?? null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }) {
      store.set(key, value);
      if (options?.expirationTtl !== undefined) ttls.set(key, options.expirationTtl);
    },
    async delete(key: string) {
      store.delete(key);
      ttls.delete(key);
    },
    async list() {
      return { keys: [], list_complete: true, cursor: "" };
    },
    async getWithMetadata(key: string) {
      const value = store.get(key) ?? null;
      return { value, metadata: null };
    },
  } as unknown as KVNamespace;
  return { kv, ttls };
}

const TODAY = new Date().toISOString().slice(0, 10);

describe("checkSpendCap", () => {
  it("returns blocked=false when counters are below caps", async () => {
    const { kv } = makeKvMock({
      [`ma:spend:global:${TODAY}`]: "100",
      [`ma:spend:org:org_abc:${TODAY}`]: "50",
    });
    const result = await checkSpendCap(kv, "org_abc", {});
    expect(result.blocked).toBe(false);
  });

  it("blocks on org cap when org counter >= org cap", async () => {
    const { kv } = makeKvMock({
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
    const { kv } = makeKvMock({
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
    const { kv } = makeKvMock({
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
    const { kv } = makeKvMock({
      [`ma:spend:global:${TODAY}`]: "1500",
    });
    const result = await checkSpendCap(kv, undefined, {});
    expect(result.blocked).toBe(true);
    if (!result.blocked) throw new Error("unreachable");
    expect(result.capCents).toBe(1500);
  });

  it("skips org cap check when orgId is undefined", async () => {
    // Global is below cap; without orgId there's nothing to block on.
    const { kv } = makeKvMock({
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
    const { kv } = makeKvMock();
    await incrementKvSpend(kv, "ma:spend:global:2099-01-01", 150, 3600);
    expect(await kv.get("ma:spend:global:2099-01-01")).toBe("150");
  });

  it("accumulates across multiple increments", async () => {
    const { kv } = makeKvMock({ "ma:spend:global:2099-01-01": "100" });
    await incrementKvSpend(kv, "ma:spend:global:2099-01-01", 50, 3600);
    expect(await kv.get("ma:spend:global:2099-01-01")).toBe("150");
    await incrementKvSpend(kv, "ma:spend:global:2099-01-01", 25, 3600);
    expect(await kv.get("ma:spend:global:2099-01-01")).toBe("175");
  });

  it("forwards expirationTtl to KV (with the 60s minimum floor)", async () => {
    const { kv, ttls } = makeKvMock();
    // Above-floor TTL passes through unchanged.
    await incrementKvSpend(kv, "ma:spend:global:2099-01-01", 100, 26 * 3600);
    expect(ttls.get("ma:spend:global:2099-01-01")).toBe(26 * 3600);
    // Below-floor TTL is clamped to 60.
    await incrementKvSpend(kv, "ma:spend:org:short:2099-01-01", 1, 30);
    expect(ttls.get("ma:spend:org:short:2099-01-01")).toBe(60);
  });

  it("treats a corrupted KV value (e.g. 'NaN') as zero rather than NaN-poisoning", async () => {
    // A previous corrupted write (or manual `wrangler kv:key put` with a bad
    // value) leaves a non-numeric string. The sanitizer should let the next
    // increment recover the counter to the new delta, not propagate NaN.
    const { kv } = makeKvMock({ "ma:spend:global:2099-01-01": "NaN" });
    await incrementKvSpend(kv, "ma:spend:global:2099-01-01", 200, 3600);
    expect(await kv.get("ma:spend:global:2099-01-01")).toBe("200");
  });
});
