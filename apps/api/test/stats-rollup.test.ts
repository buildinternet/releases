import { describe, it, expect } from "bun:test";
import {
  statsRoutes,
  refreshStatsRollup,
  STATS_ROLLUP_KEY,
  STATS_ROLLUP_TTL_SECONDS,
  type StatsPayload,
} from "../src/routes/stats.js";

function fakeKv(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const puts: Array<{ key: string; ttl?: number }> = [];
  return {
    store,
    puts,
    async get(key: string, type?: "json") {
      const v = store.get(key) ?? null;
      return type === "json" && v !== null ? JSON.parse(v) : v;
    },
    async put(key: string, value: string, opts?: { expirationTtl?: number }) {
      store.set(key, value);
      puts.push({ key, ttl: opts?.expirationTtl });
    },
    async delete(key: string) {
      store.delete(key);
    },
  };
}

/** A D1 binding that fails the test if a query reaches it. */
const unreachableDb = new Proxy(
  {},
  {
    get() {
      throw new Error("D1 should not be queried");
    },
  },
) as unknown as D1Database;

const ctx = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
} as unknown as ExecutionContext;

describe("GET /v1/stats rollup", () => {
  it("serves the default window from KV without touching D1", async () => {
    const rollup = { orgs: 3, sources: 7, releases: 42, products: 1 };
    const kv = fakeKv({ [STATS_ROLLUP_KEY]: JSON.stringify(rollup) });

    const res = await statsRoutes.fetch(
      new Request("http://api.test/stats"),
      { DB: unreachableDb, LATEST_CACHE: kv },
      ctx,
    );

    expect(res.status).toBe(200);
    expect((await res.json()) as typeof rollup).toEqual(rollup);
  });

  it("treats a junk days value as the default window", async () => {
    const rollup = { orgs: 1, sources: 1, releases: 1, products: 1 };
    const kv = fakeKv({ [STATS_ROLLUP_KEY]: JSON.stringify(rollup) });

    const res = await statsRoutes.fetch(
      new Request("http://api.test/stats?days=abc"),
      { DB: unreachableDb, LATEST_CACHE: kv },
      ctx,
    );

    expect((await res.json()) as typeof rollup).toEqual(rollup);
  });
});

describe("refreshStatsRollup", () => {
  it("overwrites the rollup key with a TTL that outlives the hourly cron", async () => {
    const kv = fakeKv({ [STATS_ROLLUP_KEY]: JSON.stringify({ orgs: 0 }) });
    const fresh = { orgs: 9 } as unknown as StatsPayload;

    await refreshStatsRollup({ DB: unreachableDb, LATEST_CACHE: kv }, async () => fresh);

    expect(JSON.parse(kv.store.get(STATS_ROLLUP_KEY)!)).toEqual({ orgs: 9 });
    expect(kv.puts).toEqual([{ key: STATS_ROLLUP_KEY, ttl: STATS_ROLLUP_TTL_SECONDS }]);
    expect(STATS_ROLLUP_TTL_SECONDS).toBeGreaterThan(60 * 60);
  });

  it("no-ops without a KV binding", async () => {
    let computed = false;
    await refreshStatsRollup({ DB: unreachableDb }, async () => {
      computed = true;
      return {} as StatsPayload;
    });
    expect(computed).toBe(false);
  });
});
