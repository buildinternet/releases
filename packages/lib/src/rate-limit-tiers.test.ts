import { describe, it, expect } from "bun:test";
import { resolveTierEnforcement, TIER_QUOTAS, type RateLimiter } from "./rate-limit-tiers";

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
