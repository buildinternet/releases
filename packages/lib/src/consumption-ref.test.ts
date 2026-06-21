import { describe, expect, test } from "bun:test";
import { consumptionConsumerRef } from "./consumption-ref.js";

describe("consumptionConsumerRef", () => {
  test("root and anonymous are fixed buckets", async () => {
    expect(await consumptionConsumerRef({ kind: "root" })).toBe("root");
    expect(await consumptionConsumerRef({ kind: "anonymous" })).toBe("anonymous");
  });

  test("token ids hash to a stable hex ref, never echo the id", async () => {
    const a = await consumptionConsumerRef({ kind: "token", tokenId: "relk_lookup_abc" });
    const b = await consumptionConsumerRef({ kind: "token", tokenId: "relk_lookup_abc" });
    const c = await consumptionConsumerRef({ kind: "token", tokenId: "relk_lookup_xyz" });
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toContain("relk");
    expect(a).not.toContain("lookup");
  });
});
