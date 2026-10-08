import { describe, it, expect } from "bun:test";
import { redactApiKey } from "../../src/cli/commands/whoami.js";

describe("redactApiKey", () => {
  it("masks short keys entirely", () => {
    expect(redactApiKey("short")).toBe("****");
    expect(redactApiKey("12345678")).toBe("****");
  });

  it("preserves prefix and suffix for long keys", () => {
    expect(redactApiKey("rk_live_abcdefghij1234567890")).toBe("rk_l…7890");
  });

  it("does not reveal the middle of the key", () => {
    const key = "abcd1234SECRETSECRETwxyz";
    const redacted = redactApiKey(key);
    expect(redacted).not.toContain("SECRET");
  });
});
