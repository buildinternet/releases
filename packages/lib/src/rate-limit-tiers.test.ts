import { describe, it, expect } from "bun:test";
import { resolveTierEnforcement, TIER_QUOTAS, type RateLimiter } from "./rate-limit-tiers";
import { resolveAccountFromCache, type CredentialCache } from "./rate-limit-tiers";

const fakeLimiter = (): RateLimiter => ({
  async limit() {
    return { success: true };
  },
});

describe("resolveTierEnforcement", () => {
  it("returns null for an exempt principal", () => {
    expect(resolveTierEnforcement({ tier: "exempt" }, {})).toBeNull();
  });

  it("maps an account principal to the account limiter, key, and 300 quota", () => {
    const account = fakeLimiter();
    const out = resolveTierEnforcement(
      { tier: "account", bucketKey: "user_abc" },
      { account, anonymous: fakeLimiter(), machine: fakeLimiter() },
    );
    expect(out).toEqual({
      tier: "account",
      limiter: account,
      key: "user_abc",
      policyName: "account",
      quota: TIER_QUOTAS.account,
    });
  });

  it("maps a machine principal to the machine limiter and 600 quota", () => {
    const machine = fakeLimiter();
    const out = resolveTierEnforcement({ tier: "machine", bucketKey: "tok_1" }, { machine });
    expect(out?.quota).toBe(600);
    expect(out?.key).toBe("tok_1");
    expect(out?.policyName).toBe("token");
  });

  it("maps an anonymous principal to the anonymous limiter and 120 quota", () => {
    const anonymous = fakeLimiter();
    const out = resolveTierEnforcement({ tier: "anonymous", bucketKey: "1.2.3.4" }, { anonymous });
    expect(out?.quota).toBe(120);
    expect(out?.key).toBe("1.2.3.4");
    expect(out?.policyName).toBe("public");
  });

  it("returns limiter:undefined when the matching rung's limiter is absent (rung disabled → allow)", () => {
    const out = resolveTierEnforcement({ tier: "account", bucketKey: "u" }, {});
    expect(out?.limiter).toBeUndefined();
    expect(out?.quota).toBe(300);
  });
});

function fakeCache(): CredentialCache & { store: Map<string, string>; gets: number } {
  const store = new Map<string, string>();
  return {
    store,
    gets: 0,
    async get(key) {
      this.gets += 1;
      return store.get(key) ?? null;
    },
    async put(key, value) {
      store.set(key, value);
    },
  };
}

describe("resolveAccountFromCache", () => {
  it("verifies on a cache miss, then serves the cached result without re-verifying", async () => {
    const cache = fakeCache();
    let verifies = 0;
    const validate = async () => {
      verifies += 1;
      return { valid: true, userId: "user_1" };
    };
    const first = await resolveAccountFromCache({ credential: "relu_abc", cache, validate });
    const second = await resolveAccountFromCache({ credential: "relu_abc", cache, validate });
    expect(first).toEqual({ valid: true, userId: "user_1" });
    expect(second).toEqual({ valid: true, userId: "user_1" });
    expect(verifies).toBe(1); // second call hit the cache
    expect(cache.gets).toBe(2); // both calls checked the cache
  });

  it("caches a negative result (junk credential) so it is not re-verified", async () => {
    const cache = fakeCache();
    let verifies = 0;
    const validate = async () => {
      verifies += 1;
      return { valid: false };
    };
    await resolveAccountFromCache({ credential: "relu_junk", cache, validate });
    const again = await resolveAccountFromCache({ credential: "relu_junk", cache, validate });
    expect(again.valid).toBe(false);
    expect(verifies).toBe(1);
  });

  it("verifies every call when no cache is provided", async () => {
    let verifies = 0;
    const validate = async () => {
      verifies += 1;
      return { valid: true, userId: "u" };
    };
    await resolveAccountFromCache({ credential: "relu_x", cache: undefined, validate });
    await resolveAccountFromCache({ credential: "relu_x", cache: undefined, validate });
    expect(verifies).toBe(2);
  });

  it("re-validates and overwrites a corrupt/unknown cached value (fail-closed)", async () => {
    const cache = fakeCache();
    let verifies = 0;
    const validate = async () => {
      verifies += 1;
      return { valid: true, userId: "user_good" };
    };
    // Prime the cache so we know the hashed key, then corrupt the stored value.
    await resolveAccountFromCache({ credential: "relu_corrupt", cache, validate });
    expect(verifies).toBe(1);
    // Overwrite with a garbage string that matches neither "0" nor "1|…".
    for (const [k] of cache.store) cache.store.set(k, "GARBAGE");
    // Second call must re-run validate() and return the fresh result.
    const result = await resolveAccountFromCache({ credential: "relu_corrupt", cache, validate });
    expect(verifies).toBe(2);
    expect(result).toEqual({ valid: true, userId: "user_good" });
  });
});

import { rateLimitConsumerRef, rateLimitDecisionPayload } from "./rate-limit-tiers";

describe("consumption signal", () => {
  it("hashes the bucket key into a stable, non-raw consumerRef", async () => {
    const a = await rateLimitConsumerRef("1.2.3.4");
    const b = await rateLimitConsumerRef("1.2.3.4");
    expect(a).toBe(b); // stable
    expect(a).not.toContain("1.2.3.4"); // never the raw value
    expect(a).toMatch(/^[0-9a-f]{64}$/); // SHA-256 hex
  });

  it("builds a tagged decision payload", () => {
    const payload = rateLimitDecisionPayload({
      surface: "api",
      tier: "account",
      rateLimited: false,
      consumerRef: "deadbeef",
      operation: "GET orgs",
    });
    expect(payload).toEqual({
      component: "rate-limit",
      event: "decision",
      surface: "api",
      tier: "account",
      rateLimited: false,
      consumerRef: "deadbeef",
      operation: "GET orgs",
    });
  });
});
