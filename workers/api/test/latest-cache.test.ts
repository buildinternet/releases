import { describe, it, expect, mock, beforeEach, afterEach } from "bun:test";
import { invalidateLatestCache } from "../src/lib/latest-cache.js";

type KvStub = {
  get: ReturnType<typeof mock>;
  put: ReturnType<typeof mock>;
  delete: ReturnType<typeof mock>;
};

function mkKv(overrides: Partial<KvStub> = {}): KvStub {
  return {
    get: mock(async () => null),
    put: mock(async () => undefined),
    delete: mock(async () => undefined),
    ...overrides,
  };
}

let logs: string[] = [];
const origConsoleInfo = console.info;
const origConsoleWarn = console.warn;
beforeEach(() => {
  logs = [];
  console.info = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  console.warn = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
});

afterEach(() => {
  console.info = origConsoleInfo;
  console.warn = origConsoleWarn;
});

describe("invalidateLatestCache", () => {
  it("skips with reason=flag_off when INVALIDATION_ENABLED is unset", async () => {
    const kv = mkKv();
    await invalidateLatestCache({ LATEST_CACHE: kv }, { nReleases: 3, sourceId: "src_abc" });
    expect(kv.delete).not.toHaveBeenCalled();
    expect(
      logs.some(
        (l) =>
          l.includes("[invalidation]") &&
          l.includes("action=skipped") &&
          l.includes("reason=flag_off"),
      ),
    ).toBe(true);
  });

  it("skips with reason=flag_off when INVALIDATION_ENABLED is 'false'", async () => {
    const kv = mkKv();
    await invalidateLatestCache(
      { LATEST_CACHE: kv, INVALIDATION_ENABLED: "false" },
      { nReleases: 3, sourceId: "src_abc" },
    );
    expect(kv.delete).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("reason=flag_off"))).toBe(true);
  });

  it("skips with reason=no_releases when nReleases is 0", async () => {
    const kv = mkKv();
    await invalidateLatestCache(
      { LATEST_CACHE: kv, INVALIDATION_ENABLED: "true" },
      { nReleases: 0, sourceId: "src_abc" },
    );
    expect(kv.delete).not.toHaveBeenCalled();
    expect(logs.some((l) => l.includes("reason=no_releases"))).toBe(true);
  });

  it("skips with reason=no_binding when LATEST_CACHE is undefined", async () => {
    await invalidateLatestCache(
      { INVALIDATION_ENABLED: "true" },
      { nReleases: 2, sourceId: "src_abc" },
    );
    expect(logs.some((l) => l.includes("reason=no_binding"))).toBe(true);
  });

  it("purges the default key when flag is on and binding present", async () => {
    const kv = mkKv();
    await invalidateLatestCache(
      { LATEST_CACHE: kv, INVALIDATION_ENABLED: "true" },
      { nReleases: 5, sourceId: "src_abc" },
    );
    expect(kv.delete).toHaveBeenCalledTimes(1);
    expect(kv.delete).toHaveBeenCalledWith("latest:v1:count=10");
    expect(logs.some((l) => l.includes("action=purged") && l.includes("ok=true"))).toBe(true);
  });

  it("swallows KV.delete errors and logs ok=false", async () => {
    const kv = mkKv({
      delete: mock(async () => {
        throw new Error("kv down");
      }),
    });
    await expect(
      invalidateLatestCache(
        { LATEST_CACHE: kv, INVALIDATION_ENABLED: "true" },
        { nReleases: 2, sourceId: "src_abc" },
      ),
    ).resolves.toBeUndefined();
    expect(
      logs.some(
        (l) => l.includes("action=purged") && l.includes("ok=false") && l.includes("reason=error"),
      ),
    ).toBe(true);
  });
});
